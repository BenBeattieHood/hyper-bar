import { describe, expect, it, vi } from 'vitest';
import { createHyperModelStore, hyperModelAtom, setCommandStatusesAtom } from './model';
import { CommandFailureError, MAX_PENDING_COMMANDS_PER_CLIENT } from './modelActions';
import {
  createIntentSubmitter,
  intentHandler,
  type HyperIntentHandler,
  type HyperIntentHandlers,
} from './modelIntents';
import { requireString } from './modelIntentPayloads';
import { createTargetLedger, tabTarget, type TargetLedger } from './modelGuards';
import type { HyperModelPortClient } from './modelPort';
import type { IntentMessage } from './modelProtocol';
import type { HyperModelReconciler } from './modelReconciler';

const client: HyperModelPortClient = {
  clientId: 'client-1',
  role: 'sidebar',
  windowId: 3,
};

function harness(handlers: HyperIntentHandlers, ledger?: TargetLedger) {
  const store = createHyperModelStore();
  const settled: unknown[] = [];
  const reconciler = {
    settleOnCommit: (settlement: unknown) => {
      settled.push(settlement);
      return Promise.resolve(store.get(hyperModelAtom));
    },
  } as unknown as HyperModelReconciler;
  return {
    settled,
    store,
    submit: createIntentSubmitter({ handlers, ledger, reconciler, store }),
  };
}

/** A harness whose only handler is setPreference, which targets nothing unless told to. */
function soleHandlerHarness(handler: Partial<HyperIntentHandler>, ledger?: TargetLedger) {
  return harness({ setPreference: { run: () => Promise.resolve(), targets: () => [], ...handler } }, ledger);
}

/** How a setPreference intent whose effect is `run` settled. */
async function settlementOf(run: HyperIntentHandler['run']) {
  const { settled, submit } = soleHandlerHarness({ run });
  await submit(intent(), client);
  await vi.waitFor(() => expect(settled).toHaveLength(1));
  return settled[0];
}

function intent(overrides: Partial<IntentMessage> = {}): IntentMessage {
  return {
    baseRevision: 0,
    commandId: 'command-1',
    kind: 'setPreference',
    payload: undefined,
    type: 'intent',
    ...overrides,
  } as IntentMessage;
}

describe('createIntentSubmitter', () => {
  it('refuses a kind the background has not implemented', async () => {
    const { submit } = harness({});
    await expect(submit(intent(), client)).resolves.toEqual({
      reason: 'unsupported',
      status: 'rejected',
    });
  });

  it('admits an intent decided on an older committed revision', async () => {
    const run = vi.fn(() => Promise.resolve());
    const { store, submit } = soleHandlerHarness({ run });
    store.set(setCommandStatusesAtom, {});

    await expect(submit(intent(), client)).resolves.toEqual({
      revision: 2,
      status: 'accepted',
    });
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
  });

  it('refuses an intent decided on a revision the model never committed', async () => {
    const run = vi.fn(() => Promise.resolve());
    const { submit } = soleHandlerHarness({ run });

    await expect(submit(intent({ baseRevision: 5 }), client)).resolves.toEqual({
      reason: 'precondition-failed',
      status: 'rejected',
    });
    expect(run).not.toHaveBeenCalled();
  });

  it('admits a command before the effect has run', async () => {
    let release = () => {};
    const running = new Promise<void>((resolve) => { release = resolve; });
    const { store, submit } = soleHandlerHarness({ run: () => running });
    const outcome = await submit(intent(), client);
    expect(outcome).toEqual({ revision: 1, status: 'accepted' });
    expect(store.get(hyperModelAtom).commands['command-1']).toMatchObject({
      clientId: 'client-1',
      kind: 'setPreference',
      phase: 'pending',
      startedRevision: 0,
    });
    release();
  });

  it('settles on commit once the effect succeeds', async () => {
    expect(await settlementOf(() => Promise.resolve())).toEqual({ commandId: 'command-1', phase: 'succeeded' });
  });

  it('reports a browser failure rather than leaving the command pending', async () => {
    expect(await settlementOf(() => Promise.reject(new Error('denied')))).toEqual({
      commandId: 'command-1',
      failure: 'browser-error',
      phase: 'failed',
    });
  });

  it('settles with the failure a handler names', async () => {
    expect(await settlementOf(() => Promise.reject(new CommandFailureError('unsupported', 'No engine')))).toEqual({
      commandId: 'command-1',
      failure: 'unsupported',
      phase: 'failed',
    });
  });

  it('carries what the effect created back on the terminal status', async () => {
    const created = { id: 'folder-9', title: 'New folder' };
    expect(await settlementOf(() => Promise.resolve(created))).toEqual({
      commandId: 'command-1',
      phase: 'succeeded',
      result: created,
    });
  });

  it('omits a result for an effect that produced nothing', async () => {
    expect(await settlementOf(() => Promise.resolve(undefined))).not.toHaveProperty('result');
  });

  it('keeps a failed effect from carrying a result', async () => {
    expect(await settlementOf(() => Promise.reject(new Error('denied')))).not.toHaveProperty('result');
  });

  it('records the targets the effect will fence', async () => {
    const { store, submit } = soleHandlerHarness({ run: () => Promise.resolve(), targets: () => ['bookmark:root'] });
    await submit(intent(), client);
    expect(store.get(hyperModelAtom).commands['command-1']?.targets).toEqual(['bookmark:root']);
  });

  it('refuses an intent whose payload it cannot target', async () => {
    const { store, submit } = soleHandlerHarness({
      run: () => Promise.resolve(),
      targets: () => { throw new Error('no spaceId'); },
    });
    await expect(submit(intent(), client)).resolves.toEqual({
      reason: 'precondition-failed',
      status: 'rejected',
    });
    expect(store.get(hyperModelAtom).commands).toEqual({});
  });

  it('refuses a replayed command id', async () => {
    const { submit } = soleHandlerHarness({ run: () => new Promise<void>(() => {}) });
    await submit(intent(), client);
    await expect(submit(intent(), client)).resolves.toEqual({
      reason: 'precondition-failed',
      status: 'rejected',
    });
  });

  it('stops a client queueing unbounded work onto the lane', async () => {
    const { submit } = soleHandlerHarness({ run: () => new Promise<void>(() => {}) });
    for (let index = 0; index < MAX_PENDING_COMMANDS_PER_CLIENT; index += 1) {
      await submit(intent({ baseRevision: index, commandId: `command-${index}` }), client);
    }
    await expect(submit(intent({
      baseRevision: MAX_PENDING_COMMANDS_PER_CLIENT,
      commandId: 'overflow',
    }), client)).resolves.toEqual({
      reason: 'too-many-pending',
      status: 'rejected',
    });
  });

  it('runs admitted effects one at a time, including their terminal settlement', async () => {
    let releaseFirst = () => {};
    const firstRunning = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const run = vi.fn()
      .mockImplementationOnce(() => firstRunning)
      .mockImplementationOnce(() => Promise.resolve());
    const { submit } = soleHandlerHarness({ run });

    await submit(intent({ commandId: 'first' }), client);
    await submit(intent({ baseRevision: 1, commandId: 'second' }), client);
    await Promise.resolve();
    expect(run).toHaveBeenCalledTimes(1);

    releaseFirst();
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
  });

  it('tells a handler its intent was admitted before earlier work leaves the lane', async () => {
    const admitted: string[] = [];
    const { submit } = soleHandlerHarness({
      admit: (payload) => admitted.push(String(payload)),
      run: () => new Promise<void>(() => {}),
    });

    await submit(intent({ commandId: 'first', payload: 'first' }), client);
    await submit(intent({ commandId: 'second', payload: 'second' }), client);
    await submit(intent({ baseRevision: 99, commandId: 'refused', payload: 'refused' }), client);

    expect(admitted).toEqual(['first', 'second']);
  });

  it('admits before the submission yields, while the click still counts as a gesture', () => {
    const admitted: string[] = [];
    const { submit } = soleHandlerHarness({
      admit: (payload) => { admitted.push(String(payload)); },
      run: () => Promise.resolve(),
    });

    void submit(intent({ payload: 'now' }), client);

    expect(admitted).toEqual(['now']);
  });

  it('hands the effect what admission started', async () => {
    const run = vi.fn(() => Promise.resolve());
    const { submit } = soleHandlerHarness({ admit: () => 'started', run });

    await submit(intent(), client);

    await vi.waitFor(() => expect(run).toHaveBeenCalledWith(
      undefined,
      client,
      expect.anything(),
      'started',
    ));
  });

  it('keeps a command waiting on the user out of the lane until its admission settles', async () => {
    let answer = (_granted: boolean) => {};
    const prompt = new Promise<boolean>((resolve) => { answer = resolve; });
    const ran: string[] = [];
    const { settled, submit } = soleHandlerHarness({
      admit: (payload) => payload === 'prompt' ? prompt : undefined,
      run: async (payload, _client, _effects, admission) => {
        ran.push(`${String(payload)}:${String(await admission)}`);
      },
    });

    await submit(intent({ commandId: 'prompt', payload: 'prompt' }), client);
    await submit(intent({ baseRevision: 1, commandId: 'later', payload: 'later' }), client);
    await vi.waitFor(() => expect(ran).toEqual(['later:undefined']));

    answer(true);
    await vi.waitFor(() => expect(ran).toEqual(['later:undefined', 'prompt:true']));
    await vi.waitFor(() => expect(settled).toHaveLength(2));
  });

  it('settles a refused admission as a failure without an unhandled rejection', async () => {
    const { settled, submit } = harness({
      setPreference: intentHandler({
        admit: () => Promise.reject(new Error('refused')),
        parse: () => undefined,
        run: async (_payload, _client, _effects, admission) => { await admission; },
        targets: () => [],
      }),
    });

    await submit(intent(), client);

    await vi.waitFor(() => expect(settled).toEqual([{
      commandId: 'command-1',
      failure: 'browser-error',
      phase: 'failed',
    }]));
  });

  it('settles a command whose admission threw instead of leaving it pending', async () => {
    const run = vi.fn(() => Promise.resolve());
    const { settled, submit } = soleHandlerHarness({
      admit: () => { throw new Error('no browser window'); },
      run,
    });

    await expect(submit(intent(), client)).resolves.toMatchObject({ status: 'accepted' });

    await vi.waitFor(() => expect(settled).toEqual([{
      commandId: 'command-1',
      failure: 'browser-error',
      phase: 'failed',
    }]));
    expect(run).not.toHaveBeenCalled();
  });

  it('settles a command as superseded when an external observation crosses its fence', async () => {
    const ledger = createTargetLedger();
    const { settled, submit } = soleHandlerHarness({
      run: async (_payload, _client, effects) => {
        ledger.observe(tabTarget(7), 'updated');
        effects!.check();
      },
      targets: () => [tabTarget(7)],
    }, ledger);

    await submit(intent(), client);

    await vi.waitFor(() => expect(settled).toEqual([{
      commandId: 'command-1',
      failure: 'superseded',
      phase: 'failed',
    }]));
  });

  it('allows a handler to declare its own expected browser evidence', async () => {
    const ledger = createTargetLedger();
    const { settled, submit } = soleHandlerHarness({
      run: async (_payload, _client, effects) => {
        await effects!.step([{ change: 'updated', target: tabTarget(7) }], async () => {
          ledger.observe(tabTarget(7), 'updated');
        });
      },
      targets: () => [tabTarget(7)],
    }, ledger);

    await submit(intent(), client);

    await vi.waitFor(() => expect(settled).toEqual([{
      commandId: 'command-1',
      phase: 'succeeded',
    }]));
  });
});

describe('intentHandler', () => {
  const renameHarness = () => {
    const run = vi.fn(() => Promise.resolve());
    return {
      run,
      ...harness({
        renameBookmark: intentHandler({
          parse: (payload) => requireString(payload, 'bookmarkId'),
          run,
          targets: (bookmarkId) => [`bookmark:${bookmarkId}`],
        }),
      }),
    };
  };

  it('rejects a malformed payload without running the effect', async () => {
    const { run, store, submit } = renameHarness();

    await expect(submit(intent({ kind: 'renameBookmark', payload: {} }), client))
      .resolves.toEqual({ reason: 'precondition-failed', status: 'rejected' });
    expect(run).not.toHaveBeenCalled();
    // A rejected intent leaves no trace, so it cannot consume the client's quota.
    expect(store.get(hyperModelAtom).commands).toEqual({});
  });

  it('parses once and declares the target it parsed', async () => {
    const { run, store, submit } = renameHarness();

    await submit(intent({ kind: 'renameBookmark', payload: { bookmarkId: 'b1' } }), client);

    expect(run).toHaveBeenCalledWith('b1', client, expect.anything(), undefined);
    expect(store.get(hyperModelAtom).commands['command-1']?.targets).toEqual(['bookmark:b1']);
  });
});
