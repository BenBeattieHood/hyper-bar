import type {
  CommandSettlementOutcome,
  CommandStatus,
  HyperActionKind,
} from './modelActions';
import type { HyperModelPortMessage, IntentOutcome } from './modelPort';
import {
  HYPER_BUILD_ID,
  HYPER_MODEL_PORT_NAME,
  HYPER_MODEL_PROTOCOL_VERSION,
  type ClientMessage,
  type HyperModelClientRole,
  type ProtocolErrorReason,
  type SearchQueryMessage,
} from './modelProtocol';
import type { SharedSearchResult } from './searchIndex';

export type HyperModelConnectionState =
  | 'connected'
  | 'connecting'
  | 'disconnected'
  | 'rejected';

export interface HyperModelClientPort {
  disconnect(): void;
  onDisconnect: { addListener(listener: () => void): void };
  onMessage: { addListener(listener: (message: unknown) => void): void };
  postMessage(message: ClientMessage): void;
}

export interface HyperModelClientOptions<Payload> {
  connect?(name: string): HyperModelClientPort;
  /**
   * Called once when the background worker turns out to be from another build,
   * as it is after a rebuild until Hyper is reloaded. The connection is kept, so
   * whatever the two builds still agree on keeps working.
   */
  onBuildMismatch?(workerBuildId: string | undefined): void;
  onCommandStatuses?(statuses: readonly CommandStatus[], revision: number): void;
  onConnectionChange?(state: HyperModelConnectionState, reason?: ProtocolErrorReason): void;
  onProjection?(payload: Payload, revision: number): void;
  role: HyperModelClientRole;
  schedule?(run: () => void, delayMs: number): () => void;
  windowId?: number;
}

export interface HyperModelClient {
  connectionState(): HyperModelConnectionState;
  dispose(): void;
  /** Discards the delivered baseline and asks for a full snapshot. */
  resync(): void;
  revision(): number;
  /**
   * Acceptance only means the command was admitted to the lane. A caller that
   * needs the effect to have happened supplies its own id and waits for that id
   * to settle in a later snapshot.
   */
  submitIntent(
    kind: HyperActionKind,
    payload: unknown,
    commandId?: string,
  ): Promise<IntentOutcome>;
  /** Waits until a committed revision records the command's terminal outcome. */
  submitSettledIntent(
    kind: HyperActionKind,
    payload: unknown,
    commandId?: string,
  ): Promise<CommandSettlementOutcome>;
  search(
    request: Omit<SearchQueryMessage, 'requestId' | 'type'>,
  ): Promise<{ results: SharedSearchResult[]; revision: number } | undefined>;
}

/** Keeps a view callback bound to its current authenticated model connection. */
export function modelClientSearch(
  client: Readonly<{ current: HyperModelClient | undefined }>,
): HyperModelClient['search'] {
  return (request) => client.current?.search(request) ?? Promise.resolve(undefined);
}

const INITIAL_RETRY_MS = 250;
const MAX_RETRY_MS = 5_000;
/** One send that Chrome refuses, and one more on the connection that replaces it. */
const MAX_SEND_ATTEMPTS = 2;

/**
 * The rejection reason for an intent whose port dropped after it was sent. The
 * background may or may not have carried it out, so only a view whose intent is
 * safe to repeat, such as activating a tab, sends it again.
 */
export const INTENT_DROPPED = 'disconnected';

/** The rejection reason for an intent that never left because no connection came back in time. */
export const INTENT_UNREACHABLE = 'unreachable';

function defaultConnect(name: string): HyperModelClientPort {
  return browser.runtime.connect({ name }) as unknown as HyperModelClientPort;
}

function defaultSchedule(run: () => void, delayMs: number): () => void {
  const handle = setTimeout(run, delayMs);
  return () => clearTimeout(handle);
}

/**
 * The view side of the model port. It owns the transport only: handshake,
 * acknowledgement, reconnection, and intent correlation. It derives nothing and
 * decides nothing, so a view can never disagree with the background about what
 * the browser currently looks like.
 *
 * The background sends one unacknowledged delivery at a time, so every payload
 * is acknowledged as soon as it has been applied. Failing to acknowledge would
 * silently stall this client's updates rather than surfacing an error.
 */
export function createHyperModelClient<Payload>(
  options: HyperModelClientOptions<Payload>,
): HyperModelClient {
  const connect = options.connect ?? defaultConnect;
  const schedule = options.schedule ?? defaultSchedule;
  const pendingIntents = new Map<string, (outcome: IntentOutcome) => void>();
  const pendingSettlements = new Map<
    string,
    (outcome: CommandSettlementOutcome) => void
  >();
  const settlingCommandIds = new Set<string>();
  const pendingSearches = new Map<
    string,
    (outcome: { results: SharedSearchResult[]; revision: number } | undefined) => void
  >();
  const connectionWaiters = new Set<(connected: boolean) => void>();

  let port: HyperModelClientPort | undefined;
  let state: HyperModelConnectionState = 'connecting';
  let currentRevision = 0;
  let retryMs = INITIAL_RETRY_MS;
  let cancelRetry: (() => void) | undefined;
  let disposed = false;
  // A rejected handshake is terminal: retrying it would spin without ever
  // becoming authorised, so only a transport-level drop is worth retrying.
  let rejected = false;
  let buildMismatchReported = false;

  // A worker from before build ids states none, which is also another build.
  const checkWorkerBuild = (workerBuildId: string | undefined) => {
    if (workerBuildId === HYPER_BUILD_ID || buildMismatchReported) return;
    buildMismatchReported = true;
    options.onBuildMismatch?.(workerBuildId);
  };

  const settleConnectionWaiters = (connected: boolean) => {
    for (const resolve of [...connectionWaiters]) resolve(connected);
  };

  const setState = (next: HyperModelConnectionState, reason?: ProtocolErrorReason) => {
    if (state === next) return;
    state = next;
    options.onConnectionChange?.(next, reason);
    if (next === 'connected' || next === 'rejected') settleConnectionWaiters(next === 'connected');
  };

  const settleAllPending = (reason: string) => {
    for (const resolve of [...pendingIntents.values()]) {
      resolve({ reason, status: 'rejected' });
    }
    pendingIntents.clear();
    for (const resolve of [...pendingSettlements.values()]) {
      resolve({ dropped: true, succeeded: false });
    }
    pendingSettlements.clear();
    for (const resolve of [...pendingSearches.values()]) resolve(undefined);
    pendingSearches.clear();
  };

  const settleStatuses = (statuses: readonly CommandStatus[]) => {
    for (const status of statuses) {
      if (status.phase === 'pending') continue;
      const resolve = pendingSettlements.get(status.commandId);
      if (!resolve) continue;
      pendingSettlements.delete(status.commandId);
      resolve({
        ...(status.failure === undefined ? {} : { failure: status.failure }),
        result: status.result,
        succeeded: status.phase === 'succeeded',
      });
    }
  };

  const projectionStatuses = (payload: unknown): readonly CommandStatus[] => {
    if (!payload || typeof payload !== 'object') return [];
    const statuses = (payload as { commands?: unknown }).commands;
    return Array.isArray(statuses) ? statuses as readonly CommandStatus[] : [];
  };

  const open = () => {
    if (disposed || rejected) return;
    setState('connecting');
    const active = connect(HYPER_MODEL_PORT_NAME);
    port = active;
    let welcomed = false;
    const acknowledge = (sequence: number) => {
      if (send(active, { sequence, type: 'ack' }) && welcomed) setState('connected');
    };

    active.onMessage.addListener((raw) => {
      const message = raw as HyperModelPortMessage;
      if (!message || typeof message !== 'object') return;
      switch (message.type) {
        case 'accepted':
        case 'rejected': {
          const resolve = pendingIntents.get(message.commandId);
          if (!resolve) return;
          pendingIntents.delete(message.commandId);
          resolve(message.type === 'accepted'
            ? { revision: message.revision, status: 'accepted' }
            : { reason: message.reason, status: 'rejected' });
          return;
        }
        case 'search-error': {
          const resolve = pendingSearches.get(message.requestId);
          if (!resolve) return;
          pendingSearches.delete(message.requestId);
          resolve(undefined);
          return;
        }
        case 'search-result': {
          const resolve = pendingSearches.get(message.requestId);
          if (!resolve) return;
          pendingSearches.delete(message.requestId);
          resolve({ results: message.results, revision: message.revision });
          return;
        }
        case 'command-status':
          currentRevision = message.revision;
          settleStatuses(message.statuses);
          options.onCommandStatuses?.(message.statuses, message.revision);
          // A role without a projection, such as page Search, is delivered statuses instead.
          acknowledge(message.sequence);
          return;
        case 'protocol-error':
          checkWorkerBuild(message.buildId);
          rejected = true;
          setState('rejected', message.reason);
          settleAllPending(message.reason);
          return;
        case 'snapshot':
          currentRevision = message.revision;
          settleStatuses(projectionStatuses(message.payload));
          options.onProjection?.(message.payload as Payload, message.revision);
          // The background admits an intent only against the revision this
          // connection has acknowledged, so a welcomed connection is usable
          // once its first snapshot is applied, not when the welcome arrives.
          acknowledge(message.sequence);
          return;
        case 'welcome':
          checkWorkerBuild(message.buildId);
          retryMs = INITIAL_RETRY_MS;
          welcomed = true;
          return;
      }
    });

    active.onDisconnect.addListener(() => { drop(active); });

    send(active, {
      protocolVersion: HYPER_MODEL_PROTOCOL_VERSION,
      role: options.role,
      type: 'hello',
      ...(options.windowId === undefined ? {} : { windowId: options.windowId }),
    });
  };

  const drop = (active: HyperModelClientPort) => {
    if (port !== active) return;
    port = undefined;
    settleAllPending(INTENT_DROPPED);
    if (disposed || rejected) return;
    setState('disconnected');
    // The background worker sleeps when idle, so a drop is expected rather
    // than exceptional; reconnecting is how a view stays live.
    cancelRetry = schedule(open, retryMs);
    retryMs = Math.min(retryMs * 2, MAX_RETRY_MS);
  };

  // Chrome can close a port before its onDisconnect is delivered, and posting
  // to it then throws. That is the same drop, so it is handled as one.
  const send = (active: HyperModelClientPort, message: ClientMessage): boolean => {
    try {
      active.postMessage(message);
      return true;
    } catch {
      drop(active);
      return false;
    }
  };

  /**
   * Resolves true once the client is connected, or false if it is refused,
   * disposed, or still not connected after `timeoutMs`.
   */
  const whenConnected = (timeoutMs = MAX_RETRY_MS) => {
    // Disposal leaves the state as it was, so it is checked first.
    if (disposed || rejected) return Promise.resolve(false);
    if (state === 'connected') return Promise.resolve(true);
    // Someone is waiting on the background, so wake it now rather than at the next backoff.
    if (!port) {
      cancelRetry?.();
      cancelRetry = undefined;
      open();
    }
    return new Promise<boolean>((resolve) => {
      let cancelTimeout = () => {};
      const settle = (connected: boolean) => {
        connectionWaiters.delete(settle);
        cancelTimeout();
        resolve(connected);
      };
      connectionWaiters.add(settle);
      cancelTimeout = schedule(() => { settle(false); }, timeoutMs);
    });
  };

  /**
   * A user's choice made while the background worker is waking (it sleeps when
   * idle) has never been sent, so it waits for the connection instead of being
   * dropped; dropping it is a click that silently does nothing.
   *
   * Chrome can also refuse the send because it closed the port before reporting
   * the drop. That intent provably never left, so it is sent again on the
   * connection that replaces the port, whatever it does. `onSent` runs once the
   * intent has actually left, so a waiter it registers is settled only by a drop
   * that could have lost it.
   */
  const sendIntent = (
    kind: HyperActionKind,
    payload: unknown,
    suppliedCommandId?: string,
    onSent?: (commandId: string) => void,
    attempts = MAX_SEND_ATTEMPTS,
  ): Promise<IntentOutcome> => {
    const active = port;
    if (!active || state !== 'connected') {
      return whenConnected().then((connected) => connected && state === 'connected'
        ? sendIntent(kind, payload, suppliedCommandId, onSent, attempts)
        : { reason: INTENT_UNREACHABLE, status: 'rejected' as const });
    }
    const commandId = suppliedCommandId ?? crypto.randomUUID();
    // Overwriting a live entry would strand the caller waiting on it.
    if (pendingIntents.has(commandId)) {
      return Promise.resolve({ reason: 'duplicate-command-id', status: 'rejected' as const });
    }
    if (!send(active, { baseRevision: currentRevision, commandId, kind, payload, type: 'intent' })) {
      return attempts > 1
        ? sendIntent(kind, payload, commandId, onSent, attempts - 1)
        : Promise.resolve({ reason: INTENT_UNREACHABLE, status: 'rejected' as const });
    }
    // A reply cannot arrive inside postMessage, so registering after the send loses nothing.
    onSent?.(commandId);
    return new Promise<IntentOutcome>((resolve) => { pendingIntents.set(commandId, resolve); });
  };

  /** A search only reads, so one Chrome refused to send is sent again like an intent. */
  const sendSearch = (
    request: Omit<SearchQueryMessage, 'requestId' | 'type'>,
    attempts = MAX_SEND_ATTEMPTS,
  ): Promise<{ results: SharedSearchResult[]; revision: number } | undefined> => {
    const active = port;
    if (!active || state !== 'connected') {
      return whenConnected().then((connected) => connected && state === 'connected'
        ? sendSearch(request, attempts)
        : undefined);
    }
    const requestId = crypto.randomUUID();
    if (!send(active, { ...request, requestId, type: 'search-query' })) {
      return attempts > 1 ? sendSearch(request, attempts - 1) : Promise.resolve(undefined);
    }
    return new Promise((resolve) => { pendingSearches.set(requestId, resolve); });
  };

  open();

  return {
    connectionState: () => state,
    dispose() {
      disposed = true;
      cancelRetry?.();
      settleAllPending('disposed');
      settleConnectionWaiters(false);
      port?.disconnect();
      port = undefined;
    },
    resync() {
      if (port) send(port, { type: 'resync' });
    },
    revision: () => currentRevision,
    submitIntent: (kind, payload, commandId) => sendIntent(kind, payload, commandId),
    async submitSettledIntent(kind, payload, suppliedCommandId) {
      const commandId = suppliedCommandId ?? crypto.randomUUID();
      // Another caller already owns this id, possibly while both wait for a reconnect.
      if (settlingCommandIds.has(commandId)) return { succeeded: false };
      settlingCommandIds.add(commandId);
      try {
        let settle: (outcome: CommandSettlementOutcome) => void = () => {};
        const settled = new Promise<CommandSettlementOutcome>((resolve) => { settle = resolve; });
        // A drop settles every waiter, so the waiter is taken only once the intent has left.
        const admitted = await sendIntent(kind, payload, commandId, () => {
          pendingSettlements.set(commandId, settle);
        });
        if (admitted.status === 'accepted') return await settled;
        pendingSettlements.delete(commandId);
        return admitted.reason === INTENT_DROPPED
          ? { dropped: true, succeeded: false }
          : { succeeded: false };
      } finally {
        settlingCommandIds.delete(commandId);
      }
    },
    search: (request) => sendSearch(request),
  };
}
