import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createHyperModelClient,
  INTENT_DROPPED,
  INTENT_UNREACHABLE,
  type HyperModelClientPort,
} from './modelClient';
import { HYPER_BUILD_ID, HYPER_MODEL_PROTOCOL_VERSION, type ClientMessage } from './modelProtocol';

interface FakePort extends HyperModelClientPort {
  drop(): void;
  emit(message: unknown): void;
  sent: ClientMessage[];
}

function fakePort(): FakePort {
  const messages: ((message: unknown) => void)[] = [];
  const drops: (() => void)[] = [];
  const sent: ClientMessage[] = [];
  return {
    disconnect: vi.fn(),
    drop() {
      for (const listener of [...drops]) listener();
    },
    emit(message) {
      for (const listener of [...messages]) listener(message);
    },
    onDisconnect: { addListener: (listener) => { drops.push(listener); } },
    onMessage: { addListener: (listener) => { messages.push(listener); } },
    postMessage: (message) => { sent.push(message); },
    sent,
  };
}

/** A welcome; a `null` build id leaves it out, as workers from before build ids did. */
const welcomeMessage = (role: string, buildId: string | null = HYPER_BUILD_ID, clientId = 'client-1') => ({
  ...(buildId === null ? {} : { buildId }),
  clientId,
  protocolVersion: HYPER_MODEL_PROTOCOL_VERSION,
  role,
  type: 'welcome',
});

function harness(windowId = 7) {
  const ports: FakePort[] = [];
  const timers: (() => void)[] = [];
  const projections: { payload: unknown; revision: number }[] = [];
  const buildMismatches: (string | undefined)[] = [];
  const client = createHyperModelClient<{ revision: number }>({
    connect: () => {
      const port = fakePort();
      ports.push(port);
      return port;
    },
    onBuildMismatch: (workerBuildId) => { buildMismatches.push(workerBuildId); },
    onProjection: (payload, revision) => { projections.push({ payload, revision }); },
    role: 'sidebar',
    schedule: (run) => {
      timers.push(run);
      return () => {};
    },
    windowId,
  });
  const latest = () => {
    const port = ports.at(-1);
    if (!port) throw new Error('No port was opened.');
    return port;
  };
  /** The background always offers a first snapshot right after its welcome. */
  const welcome = (revision = 1, buildId = HYPER_BUILD_ID) => {
    latest().emit(welcomeMessage('sidebar', buildId));
    latest().emit({ payload: { revision }, revision, sequence: 1, type: 'snapshot' });
  };
  const accept = (commandId: string, revision: number) =>
    latest().emit({ commandId, revision, type: 'accepted' });
  /** Commits a projection whose command statuses include `commands`. */
  const commitStatuses = (commands: unknown[], revision: number, sequence = 2) =>
    latest().emit({ payload: { commands, revision }, revision, sequence, type: 'snapshot' });
  const refuseHandshake = (buildId = HYPER_BUILD_ID) =>
    latest().emit({ buildId, reason: 'unauthenticated', type: 'protocol-error' });
  const runTimers = () => timers.forEach((run) => { run(); });
  /** Answers the search the client sent last with no results. */
  const answerSearch = (revision: number) => {
    const request = latest().sent.at(-1) as { requestId: string; type: string };
    expect(request.type).toBe('search-query');
    latest().emit({ requestId: request.requestId, results: [], revision, type: 'search-result' });
  };
  return {
    accept,
    answerSearch,
    buildMismatches,
    client,
    commitStatuses,
    latest,
    ports,
    projections,
    refuseHandshake,
    runTimers,
    timers,
    welcome,
  };
}

beforeEach(() => {
  vi.stubGlobal('crypto', { randomUUID: () => 'command-1' });
});

describe('createHyperModelClient', () => {
  it('introduces itself before expecting anything from the background', () => {
    const { latest } = harness();
    expect(latest().sent).toEqual([{
      protocolVersion: HYPER_MODEL_PROTOCOL_VERSION,
      role: 'sidebar',
      type: 'hello',
      windowId: 7,
    }]);
  });

  it('acknowledges each delivery so the background keeps sending', () => {
    const { latest, projections, welcome } = harness();
    welcome();
    latest().emit({ payload: { revision: 4 }, revision: 4, sequence: 2, type: 'snapshot' });

    expect(projections.at(-1)).toEqual({ payload: { revision: 4 }, revision: 4 });
    expect(latest().sent.at(-1)).toEqual({ sequence: 2, type: 'ack' });
  });

  it('reconnects after the background worker sleeps', () => {
    const { latest, ports, runTimers, welcome } = harness();
    welcome();
    latest().drop();

    expect(ports).toHaveLength(1);
    runTimers();
    expect(ports).toHaveLength(2);
    expect(ports[1]?.sent[0]).toMatchObject({ type: 'hello' });
  });

  it('stops retrying a handshake the background refused', () => {
    const { latest, ports, refuseHandshake, runTimers } = harness();
    refuseHandshake();
    latest().drop();

    runTimers();
    expect(ports).toHaveLength(1);
  });

  it('settles an intent with the outcome the background reports', async () => {
    const { accept, client, welcome } = harness();
    welcome();
    const outcome = client.submitIntent('selectSpace', { spaceId: 'space-1' });
    accept('command-1', 9);

    await expect(outcome).resolves.toEqual({ revision: 9, status: 'accepted' });
  });

  it('waits for the terminal command status in a committed projection', async () => {
    const { accept, client, commitStatuses, welcome } = harness();
    welcome();
    const outcome = client.submitSettledIntent('closeTabs', { tabIds: [7] });
    accept('command-1', 9);
    commitStatuses([{
      clientId: 'client-1',
      commandId: 'command-1',
      kind: 'closeTabs',
      phase: 'succeeded',
      result: { closed: [7] },
      startedRevision: 8,
      targets: ['tab:7'],
    }], 10, 1);

    await expect(outcome).resolves.toEqual({ result: { closed: [7] }, succeeded: true });
  });

  it('tells the caller which failure its command settled with', async () => {
    const { accept, client, commitStatuses, welcome } = harness();
    welcome();
    const outcome = client.submitSettledIntent('navigateTab', { kind: 'search', query: 'news' });
    accept('command-1', 9);
    commitStatuses([{
      clientId: 'client-1',
      commandId: 'command-1',
      failure: 'unsupported',
      kind: 'navigateTab',
      phase: 'failed',
      startedRevision: 8,
      targets: [],
    }], 10, 1);

    await expect(outcome).resolves.toEqual({
      failure: 'unsupported',
      result: undefined,
      succeeded: false,
    });
  });

  it('uses a caller supplied command id so completion can be correlated', () => {
    const { client, ports, welcome } = harness();
    welcome();
    void client.submitIntent('setPreference', undefined, 'caller-id');
    expect(ports[0]?.sent.at(-1)).toMatchObject({
      commandId: 'caller-id',
      kind: 'setPreference',
      type: 'intent',
    });
  });

  it('refuses a command id that is already in flight', async () => {
    const { client, welcome } = harness();
    welcome();
    void client.submitIntent('setPreference', undefined, 'caller-id');
    await expect(
      client.submitIntent('setPreference', undefined, 'caller-id'),
    ).resolves.toEqual({ reason: 'duplicate-command-id', status: 'rejected' });
  });

  it('holds a choice made while reconnecting until the first snapshot is acknowledged', async () => {
    const { accept, client, latest, runTimers, welcome } = harness();
    welcome(3);
    latest().drop();
    runTimers();
    latest().emit(welcomeMessage('sidebar', HYPER_BUILD_ID, 'client-2'));

    expect(client.connectionState()).toBe('connecting');
    const outcome = client.submitIntent('selectSpace', { spaceId: 'space-1' });
    expect(latest().sent.some((message) => message.type === 'intent')).toBe(false);

    latest().emit({ payload: { revision: 4 }, revision: 4, sequence: 1, type: 'snapshot' });
    await Promise.resolve();
    // The background admits an intent only against the revision this port acknowledged.
    expect(latest().sent.slice(-2)).toEqual([
      { sequence: 1, type: 'ack' },
      expect.objectContaining({ baseRevision: 4, commandId: 'command-1', type: 'intent' }),
    ]);
    accept('command-1', 5);
    await expect(outcome).resolves.toEqual({ revision: 5, status: 'accepted' });
  });

  it('wakes a sleeping background at once for a waiting choice instead of after the backoff', async () => {
    const { accept, client, latest, ports, welcome } = harness();
    welcome();
    latest().drop();
    expect(ports).toHaveLength(1);

    const outcome = client.submitIntent('activateTab', { tabId: 4 });
    expect(ports).toHaveLength(2);
    welcome(2);
    await Promise.resolve();
    expect(latest().sent.at(-1)).toMatchObject({ kind: 'activateTab', type: 'intent' });
    accept('command-1', 3);
    await expect(outcome).resolves.toEqual({ revision: 3, status: 'accepted' });
  });

  it('rejects a waiting choice when the background cannot be reached in time', async () => {
    const { client, latest, timers, welcome } = harness();
    welcome();
    latest().drop();
    const outcome = client.submitIntent('activateTab', { tabId: 4 });
    timers.at(-1)?.();

    await expect(outcome).resolves.toEqual({ reason: INTENT_UNREACHABLE, status: 'rejected' });
    expect(latest().sent.some((message) => message.type === 'intent')).toBe(false);
  });

  it('keeps a settled choice alive across a drop it waited out', async () => {
    const { accept, client, commitStatuses, latest, timers, welcome } = harness();
    welcome();
    latest().drop();
    const settled = client.submitSettledIntent('activateTab', { tabId: 4 });
    // The reconnection drops again before it is welcomed.
    latest().drop();
    timers.at(-1)?.();
    welcome(2);
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    expect(latest().sent.at(-1)).toMatchObject({ commandId: 'command-1', type: 'intent' });
    accept('command-1', 3);
    commitStatuses([{ commandId: 'command-1', phase: 'succeeded' }], 4);

    await expect(settled).resolves.toMatchObject({ succeeded: true });
  });

  it('refuses a duplicate settled command that is waiting for reconnect', async () => {
    const { accept, client, commitStatuses, latest, welcome } = harness();
    welcome();
    latest().drop();
    const first = client.submitSettledIntent('closeTabs', { tabIds: [7] }, 'caller-id');
    const duplicate = client.submitSettledIntent('closeTabs', { tabIds: [7] }, 'caller-id');
    let firstOutcome: Awaited<ReturnType<typeof client.submitSettledIntent>> | undefined;
    void first.then((outcome) => { firstOutcome = outcome; });

    welcome(2);
    await Promise.resolve();
    expect(latest().sent.at(-1)).toMatchObject({ commandId: 'caller-id', type: 'intent' });
    accept('caller-id', 3);
    commitStatuses([{ commandId: 'caller-id', phase: 'succeeded' }], 4);

    await new Promise((resolve) => { setTimeout(resolve, 0); });
    expect(firstOutcome).toEqual({ result: undefined, succeeded: true });
    await expect(duplicate).resolves.toEqual({ succeeded: false });
  });

  it('answers a search typed while reconnecting once connected', async () => {
    const { answerSearch, client, latest, welcome } = harness();
    welcome();
    latest().drop();
    const result = client.search({ commands: [], query: 'design' });
    welcome(2);
    await Promise.resolve();
    answerSearch(2);

    await expect(result).resolves.toEqual({ results: [], revision: 2 });
  });

  it('connects a projectionless role, such as page Search, on its first acknowledged statuses', async () => {
    const port = fakePort();
    const client = createHyperModelClient({
      connect: () => port,
      onCommandStatuses: () => undefined,
      role: 'page-search',
      schedule: () => () => {},
      windowId: 7,
    });
    port.emit(welcomeMessage('page-search'));

    expect(client.connectionState()).toBe('connecting');

    port.emit({ revision: 5, sequence: 1, statuses: [], type: 'command-status' });

    expect(client.connectionState()).toBe('connected');
    void client.search({ commands: [], query: '' });
    expect(port.sent.slice(-2)).toEqual([
      { sequence: 1, type: 'ack' },
      expect.objectContaining({ query: '', type: 'search-query' }),
    ]);
  });

  it('never leaves an intent hanging when the port drops', async () => {
    const { client, latest, welcome } = harness();
    welcome();
    const outcome = client.submitIntent('selectSpace', { spaceId: 'space-1' });
    latest().drop();

    await expect(outcome).resolves.toEqual({ reason: INTENT_DROPPED, status: 'rejected' });
  });

  it('fails a settlement waiter when its command is rejected or the port drops', async () => {
    const { client, latest, welcome } = harness();
    welcome();
    const rejected = client.submitSettledIntent('closeTabs', { tabIds: [7] });
    latest().emit({ commandId: 'command-1', reason: 'precondition-failed', type: 'rejected' });
    await expect(rejected).resolves.toEqual({ succeeded: false });

    const disconnected = client.submitSettledIntent('closeTabs', { tabIds: [8] }, 'command-2');
    latest().drop();
    // The intent left before the drop, so whether it ran is unknown.
    await expect(disconnected).resolves.toEqual({ dropped: true, succeeded: false });
  });

  it('correlates a search result without exposing the port to the view', async () => {
    const { client, latest, welcome } = harness();
    welcome();
    const result = client.search({
      commands: [],
      includeFolders: true,
      limit: 18,
      query: 'design',
    });
    expect(latest().sent.at(-1)).toMatchObject({ query: 'design', type: 'search-query' });
    const requestId = (latest().sent.at(-1) as { requestId: string }).requestId;
    latest().emit({
      requestId,
      results: [{ item: { id: 'bookmark:design' }, kind: 'item' }],
      revision: 12,
      type: 'search-result',
    });

    await expect(result).resolves.toEqual({
      results: [{ item: { id: 'bookmark:design' }, kind: 'item' }],
      revision: 12,
    });
  });

  it('settles a search request when its port disconnects', async () => {
    const { client, latest, welcome } = harness();
    welcome();
    const result = client.search({ commands: [], query: 'design' });
    latest().drop();

    await expect(result).resolves.toBeUndefined();
  });

  describe('when Chrome closed the port before reporting the drop', () => {
    const killPort = (port: FakePort) => {
      port.postMessage = () => { throw new Error('Attempted to use a disconnected port object'); };
    };

    it('sends an intent that never left again once reconnected', async () => {
      const { accept, client, latest, ports, welcome } = harness();
      welcome();
      const inFlight = client.submitIntent('selectSpace', { spaceId: 'space-1' }, 'earlier');
      killPort(latest());

      const outcome = client.submitIntent('activateTab', { tabId: 4 }, 'refused');
      // An earlier intent may have reached the background, so it is not sent again.
      await expect(inFlight).resolves.toEqual({ reason: INTENT_DROPPED, status: 'rejected' });
      expect(ports).toHaveLength(2);
      welcome(2);
      await Promise.resolve();
      expect(latest().sent.at(-1)).toMatchObject({ commandId: 'refused', kind: 'activateTab', type: 'intent' });
      accept('refused', 3);

      await expect(outcome).resolves.toEqual({ revision: 3, status: 'accepted' });
    });

    it('keeps a settled choice alive when Chrome refuses its first send', async () => {
      const { accept, client, commitStatuses, latest, welcome } = harness();
      welcome();
      killPort(latest());

      const settled = client.submitSettledIntent('closeTabs', { tabIds: [7] }, 'refused');
      welcome(2);
      await Promise.resolve();
      accept('refused', 3);
      commitStatuses([{ commandId: 'refused', phase: 'succeeded' }], 4);

      await expect(settled).resolves.toEqual({ result: undefined, succeeded: true });
    });

    it('gives up when the replacement connection refuses the intent too', async () => {
      const { client, latest, welcome } = harness();
      welcome();
      killPort(latest());

      const outcome = client.submitIntent('activateTab', { tabId: 4 });
      welcome(2);
      killPort(latest());

      await expect(outcome).resolves.toEqual({ reason: INTENT_UNREACHABLE, status: 'rejected' });
    });

    it('reconnects as it would after any other drop', () => {
      const { latest, ports, runTimers, welcome } = harness();
      welcome();
      killPort(latest());
      latest().emit({ payload: { revision: 2 }, revision: 2, sequence: 1, type: 'snapshot' });

      runTimers();
      expect(ports).toHaveLength(2);
      expect(ports[1]?.sent[0]).toMatchObject({ type: 'hello' });
    });

    it('sends a search that never left again once reconnected', async () => {
      const { answerSearch, client, latest, welcome } = harness();
      welcome();
      killPort(latest());

      const result = client.search({ commands: [], query: 'design' });
      welcome(2);
      await Promise.resolve();
      answerSearch(2);

      await expect(result).resolves.toEqual({ results: [], revision: 2 });
    });
  });

  describe('a choice waiting for the background', () => {
    it('is refused at once when the handshake is refused, then and later', async () => {
      const { client, refuseHandshake } = harness();
      const waiting = client.submitIntent('activateTab', { tabId: 4 });
      refuseHandshake();

      await expect(waiting).resolves.toEqual({ reason: INTENT_UNREACHABLE, status: 'rejected' });
      await expect(client.submitIntent('activateTab', { tabId: 4 }))
        .resolves.toEqual({ reason: INTENT_UNREACHABLE, status: 'rejected' });
    });

    it('is refused when the client is disposed, even though disposal leaves it marked connected', async () => {
      const { client } = harness();
      const waiting = client.submitIntent('activateTab', { tabId: 4 });
      client.dispose();
      await expect(waiting).resolves.toEqual({ reason: INTENT_UNREACHABLE, status: 'rejected' });

      const connected = harness();
      connected.welcome();
      connected.client.dispose();
      await expect(connected.client.submitIntent('activateTab', { tabId: 4 }))
        .resolves.toEqual({ reason: INTENT_UNREACHABLE, status: 'rejected' });
    });
  });

  // The browser keeps running the worker it started until Hyper is reloaded, while pages load from disk.
  describe('a background worker from another build', () => {
    it('is reported once, without giving up a connection that still works', () => {
      const { buildMismatches, client, latest, runTimers, welcome } = harness();
      welcome(1, 'older-build');
      expect(client.connectionState()).toBe('connected');

      latest().drop();
      runTimers();
      welcome(2, 'older-build');

      expect(buildMismatches).toEqual(['older-build']);
      expect(client.connectionState()).toBe('connected');
    });

    it('includes a worker from before build ids, which states none', () => {
      const { buildMismatches, latest } = harness();
      latest().emit(welcomeMessage('sidebar', null));

      expect(buildMismatches).toEqual([undefined]);
    });

    it('is told apart from its own build whether the worker welcomes or refuses the page', () => {
      const welcomed = harness();
      welcomed.welcome();
      // A private window is refused by the page's own build, and that is not an update.
      const refused = harness();
      refused.refuseHandshake();
      const refusedByAnotherBuild = harness();
      refusedByAnotherBuild.refuseHandshake('newer-build');

      expect(welcomed.buildMismatches).toEqual([]);
      expect(refused.buildMismatches).toEqual([]);
      expect(refusedByAnotherBuild.buildMismatches).toEqual(['newer-build']);
    });
  });
});
