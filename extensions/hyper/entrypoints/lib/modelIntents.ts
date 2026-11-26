import { createSerialAsyncRunner } from './async';
import {
  beginCommand,
  CommandFailureError,
  type HyperActionKind,
} from './modelActions';
import { hyperModelAtom, setCommandStatusesAtom, type HyperModelStore } from './model';
import {
  createEffectFence,
  createTargetLedger,
  SupersededTargetError,
  type EffectFence,
  type TargetKey,
  type TargetLedger,
} from './modelGuards';
import type { HyperModelReconciler } from './modelReconciler';
import type { IntentItems } from './modelIntentPayloads';
import type { HyperModelPortClient, IntentOutcome } from './modelPort';
import type { IntentMessage } from './modelProtocol';

export interface HyperIntentHandler {
  /**
   * Runs synchronously at admission, before earlier commands have left the lane.
   *
   * The browser still counts the user's click as a gesture only while the view's
   * message is being delivered, so a call that needs one, such as a permission
   * request, starts here. Whatever this returns is handed to `run`. A promise
   * holds the command back from the lane until it settles, so a browser prompt
   * waiting on the user never delays other commands.
   */
  admit?(payload: unknown, client: HyperModelPortClient): unknown;
  /** Anything returned rides the terminal status back to the issuing client. */
  run(
    payload: unknown,
    client: HyperModelPortClient,
    effects?: EffectFence,
    admission?: unknown,
  ): Promise<unknown>;
  /** Declared in advance so the ledger can fence the effect before it runs. */
  targets(payload: unknown, client: HyperModelPortClient): readonly TargetKey[];
}

export type HyperIntentHandlers = Partial<Record<HyperActionKind, HyperIntentHandler>>;

/** Runs an intent's items in order; a batch answers with every result, one payload with its own. */
export async function runEachItem<Payload, Result>(
  { batch, items }: IntentItems<Payload>,
  perform: (item: Payload) => Promise<Result>,
): Promise<Result | Result[]> {
  const results: Result[] = [];
  for (const item of items) results.push(await perform(item));
  return batch ? results : results[0] as Result;
}

/**
 * Builds a handler that parses once, before admission.
 *
 * Parsing inside `targets` is deliberate: the submitter treats a throw there as
 * a rejected precondition, so a malformed payload never becomes a pending
 * command and never reaches a browser call.
 */
export function intentHandler<Payload, Result = void, Admission = void>(options: {
  admit?: (payload: Payload, client: HyperModelPortClient) => Admission;
  parse: (payload: unknown) => Payload;
  run: (
    payload: Payload,
    client: HyperModelPortClient,
    effects?: EffectFence,
    admission?: Admission,
  ) => Promise<Result>;
  targets: (payload: Payload, client: HyperModelPortClient) => readonly TargetKey[];
}): HyperIntentHandler {
  return {
    ...(options.admit
      ? { admit: (payload: unknown, client: HyperModelPortClient) =>
          options.admit!(options.parse(payload), client) }
      : {}),
    run: (payload, client, effects, admission) =>
      options.run(options.parse(payload), client, effects, admission as Admission | undefined),
    targets: (payload, client) => options.targets(options.parse(payload), client),
  };
}

/**
 * Turns an intent into a command on the serial lane.
 *
 * Acceptance means the command was admitted, not that it finished: the revision
 * returned is the one that first carries the pending status. The outcome lands
 * later on the revision that also carries the browser state it produced, so a
 * view can never see a success that disagrees with the tree it is rendering.
 */
export function createIntentSubmitter(options: {
  handlers: HyperIntentHandlers;
  ledger?: TargetLedger;
  reconciler: HyperModelReconciler;
  store: HyperModelStore;
}) {
  const effectLane = createSerialAsyncRunner();
  const ledger = options.ledger ?? createTargetLedger();
  return async (
    intent: IntentMessage,
    client: HyperModelPortClient,
  ): Promise<IntentOutcome> => {
    const handler = options.handlers[intent.kind as HyperActionKind];
    if (!handler) return { reason: 'unsupported', status: 'rejected' };
    const current = options.store.get(hyperModelAtom);
    // Revisions advance on every browser event, so a client is routinely behind; fences catch real staleness.
    if (intent.baseRevision > current.revision) {
      return { reason: 'precondition-failed', status: 'rejected' };
    }
    let targets: readonly TargetKey[];
    try {
      targets = handler.targets(intent.payload, client);
    } catch {
      return { reason: 'precondition-failed', status: 'rejected' };
    }
    // Admission reads and writes the command table with nothing in between, so a
    // command settled by a concurrent commit cannot be clobbered by a stale copy.
    const begun = beginCommand(current.commands, {
      clientId: client.clientId,
      commandId: intent.commandId,
      kind: intent.kind,
      startedRevision: current.revision,
      targets,
    });
    if (begun.status === 'rejected') {
      return {
        reason: begun.reason === 'duplicate-command-id' ? 'precondition-failed' : 'too-many-pending',
        status: 'rejected',
      };
    }
    const admitted = options.store.set(setCommandStatusesAtom, begun.table);
    let admission: unknown;
    let admissionError: { error: unknown } | undefined;
    try {
      admission = handler.admit?.(intent.payload, client);
    } catch (error) {
      // The command is already pending, so a failed admission settles it through the lane.
      admissionError = { error };
    }
    const run = async () => {
      const effects = createEffectFence(ledger, intent.commandId, targets);
      try {
        if (admissionError) throw admissionError.error;
        effects.check();
        const result = await handler.run(intent.payload, client, effects, admission);
        await options.reconciler.settleOnCommit({
          commandId: intent.commandId,
          phase: 'succeeded',
          ...(result === undefined ? {} : { result }),
        });
      } catch (error) {
        await options.reconciler.settleOnCommit({
          commandId: intent.commandId,
          failure: error instanceof SupersededTargetError
            ? 'superseded'
            : error instanceof CommandFailureError ? error.failure : 'browser-error',
          phase: 'failed',
        });
      } finally {
        // A terminal reconciliation is the final proof point for this command.
        // Keeping an unmatched expectation beyond it could mask a later external
        // browser change as evidence for an already-settled operation.
        ledger.forget(intent.commandId);
      }
    };
    // Keep the complete effect-and-proof cycle ordered. A failed reconciliation
    // must not poison later work: its queued settlement is retried separately.
    const joinLane = () => void effectLane(run).catch(() => undefined);
    if (isPromiseLike(admission)) void Promise.resolve(admission).then(joinLane, joinLane);
    else joinLane();
    return { revision: admitted.revision, status: 'accepted' };
  };
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof (value as PromiseLike<unknown> | undefined)?.then === 'function';
}
