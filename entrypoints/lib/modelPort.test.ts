import { afterEach, describe, expect, it, vi } from 'vitest';
import { adoptGroup, emptyGroupOwnershipRegistry } from './groupOwnership';
import {
  createHyperModelStore,
  emptyBrowserObservation,
  emptyRuntimeMetadata,
  materialiseHyperModel,
  setCommandStatusesAtom,
  type BrowserObservation,
  type RuntimeMetadata,
} from './model';
import {
  HYPER_MODEL_PORT_NAME,
  HYPER_MODEL_PROTOCOL_VERSION,
  canSubmitHyperModelIntent,
  projectHyperModelForClient,
  resolveHyperModelPortRole,
  startHyperModelPortServer,
} from './modelPort';
import { HYPER_BUILD_ID } from './modelProtocol';
import { hyperBookmarkTree, testBookmark, testFolder } from './testBookmarkTree';

const extensionUrl = (path: string) => `chrome-extension://hyper${path}`;

interface FakePort {
  close(): void;
  disconnect: ReturnType<typeof vi.fn>;
  emit(message: unknown): void;
  name: string;
  onDisconnect: { addListener(listener: () => void): void };
  onMessage: { addListener(listener: (message: unknown) => void): void };
  postMessage: ReturnType<typeof vi.fn>;
  sender?: { tab?: { id?: number; windowId?: number }; url?: string };
}

function fakePort(sender: FakePort['sender']): FakePort {
  const listeners: ((message: unknown) => void)[] = [];
  const disconnectListeners: (() => void)[] = [];
  return {
    close() {
      for (const listener of disconnectListeners) listener();
    },
    disconnect: vi.fn(),
    emit(message) {
      for (const listener of listeners) listener(message);
    },
    name: HYPER_MODEL_PORT_NAME,
    onDisconnect: { addListener: (listener) => { disconnectListeners.push(listener); } },
    onMessage: { addListener: (listener) => { listeners.push(listener); } },
    postMessage: vi.fn(),
    sender,
  };
}

function installRuntime() {
  let connect: ((port: unknown) => void) | undefined;
  vi.stubGlobal('browser', {
    runtime: {
      getURL: (path: string) => extensionUrl(path),
      onConnect: {
        addListener: (listener: (port: unknown) => void) => { connect = listener; },
        removeListener: () => { connect = undefined; },
      },
    },
  });
  vi.stubGlobal('crypto', { randomUUID: () => `client-${Math.random()}` });
  return (port: FakePort) => connect?.(port);
}

const hello = <Role extends string>(role: Role, windowId?: number) => ({
  protocolVersion: HYPER_MODEL_PROTOCOL_VERSION,
  role,
  type: 'hello' as const,
  ...(windowId === undefined ? {} : { windowId }),
});
const sidebarHello = (windowId: number) => hello('sidebar', windowId);
const pageSearchUrl = (windowId: number) =>
  `chrome-extension://hyper/newtab.html?mode=search-overlay&sourceTabId=4&sourceWindowId=${windowId}`;
const tabSender = (url: string) => ({ tab: { id: 4, windowId: 7 }, url });
const sidepanelPort = () => fakePort({ url: extensionUrl('/sidepanel.html') });
const pageSearchPort = () => fakePort({ tab: { id: 4, windowId: 1 }, url: pageSearchUrl(1) });
const intent = (commandId: string, kind: string, payload?: unknown) =>
  ({ baseRevision: 0, commandId, kind, payload, type: 'intent' });
const normalWindow = (id: number) => ({ id, incognito: false, type: 'normal' }) as Browser.windows.Window;

function storeWithWindowOne() {
  return createHyperModelStore({
    browser: { ...emptyBrowserObservation, windows: [normalWindow(1)] },
    runtime: emptyRuntimeMetadata,
  });
}

/** A materialised model of the given browser and runtime sources. */
const snapshotOf = (
  revision: number,
  browser: Partial<BrowserObservation>,
  runtime: Partial<RuntimeMetadata> = {},
  commands?: Parameters<typeof materialiseHyperModel>[2],
) => materialiseHyperModel(revision, {
  browser: { ...emptyBrowserObservation, ...browser },
  runtime: { ...emptyRuntimeMetadata, ...runtime },
}, commands);

afterEach(() => vi.unstubAllGlobals());

function windowScopedSnapshot() {
  return snapshotOf(5, {
    tabs: [
      { id: 10, windowId: 1, url: 'https://visible.example' } as Browser.tabs.Tab,
      { id: 11, windowId: 2, url: 'https://hidden.example' } as Browser.tabs.Tab,
    ],
    windows: [normalWindow(1), { id: 2, incognito: true } as Browser.windows.Window],
  }, {
    groupOwnership: adoptGroup(
      adoptGroup(emptyGroupOwnershipRegistry, { groupId: 3, spaceId: 'one', windowId: 1 }),
      { groupId: 4, spaceId: 'two', windowId: 2 },
    ),
    tabOwnerships: {
      10: { spaceId: 'one' },
      11: { spaceId: 'two' },
    },
  }, {
    'command-mine': {
      clientId: 'client-a',
      commandId: 'command-mine',
      kind: 'closeTabs',
      phase: 'pending',
      startedRevision: 4,
      targets: [],
    },
    'command-theirs': {
      clientId: 'client-b',
      commandId: 'command-theirs',
      kind: 'closeTabs',
      phase: 'succeeded',
      settledRevision: 5,
      startedRevision: 4,
      targets: [],
    },
  });
}

describe('Hyper model port policy', () => {
  it('authenticates page Search by its source tab but never projects the root model to it', () => {
    expect(resolveHyperModelPortRole(tabSender(pageSearchUrl(7)), hello('page-search'), extensionUrl))
      .toBe('page-search');
  });

  it('authenticates a New Tab from the browser sender without a claimed window', () => {
    expect(resolveHyperModelPortRole(tabSender(extensionUrl('/newtab.html')), hello('newtab'), extensionUrl))
      .toBe('newtab');
  });

  it('does not allow a page-search URL to claim the normal New Tab role', () => {
    expect(resolveHyperModelPortRole(tabSender(pageSearchUrl(7)), hello('newtab'), extensionUrl))
      .toBeUndefined();
  });

  it('permits page Search only the actions it needs to render and run results', () => {
    expect(canSubmitHyperModelIntent('page-search', 'activateTab')).toBe(true);
    expect(canSubmitHyperModelIntent('page-search', 'activateTab', {
      operation: 'remote',
    })).toBe(false);
    expect(canSubmitHyperModelIntent('page-search', 'navigateTab')).toBe(true);
    expect(canSubmitHyperModelIntent('page-search', 'setTabMediaPlayback')).toBe(true);
    expect(canSubmitHyperModelIntent('page-search', 'setTabMuted')).toBe(true);
    expect(canSubmitHyperModelIntent('page-search', 'closeTabs', {
      condition: 'page-in-space',
      source: { kind: 'tab', tabId: 7 },
      spaceId: 'two',
    })).toBe(true);
    expect(canSubmitHyperModelIntent('page-search', 'closeTabs', { tabIds: [7] })).toBe(false);
    expect(canSubmitHyperModelIntent('page-search', 'closeTabs', {
      condition: 'other-unpinned',
      keepTabId: 7,
      tabIds: [8],
      windowId: 1,
    })).toBe(false);
    expect(canSubmitHyperModelIntent('page-search', 'closeTabs')).toBe(false);
    expect(canSubmitHyperModelIntent('page-search', 'deleteSpace')).toBe(false);
    expect(canSubmitHyperModelIntent('sidebar', 'deleteSpace')).toBe(true);
  });

  it('projects only the requested non-private window to sidebar and new-tab clients', () => {
    const snapshot = windowScopedSnapshot();

    expect(projectHyperModelForClient(snapshot, 'sidebar', 1)).toMatchObject({
      bookmarkImportInProgress: false,
      revision: 5,
      window: {
        groupIdsBySpace: { one: 3 },
        tabOwnerships: { 10: { spaceId: 'one' } },
        tabs: [{ id: 10 }],
      },
    });
    expect(projectHyperModelForClient(snapshot, 'newtab', 2)).toBeUndefined();
  });

  it('does not project another regular window or captured page text', () => {
    const snapshot = snapshotOf(5, {
      tabs: [
        { id: 10, windowId: 1, url: 'https://visible.example' } as Browser.tabs.Tab,
        { id: 11, windowId: 2, url: 'https://other.example' } as Browser.tabs.Tab,
      ],
      windows: [normalWindow(1), normalWindow(2)],
    }, {
      tabContents: {
        10: { navigationVersion: 0, text: 'Visible page', url: 'https://visible.example' },
        11: { navigationVersion: 0, text: 'Other page', url: 'https://other.example' },
      },
      tabOwnerships: {
        10: { spaceId: 'one' },
        11: { spaceId: 'two' },
      },
    });

    const projection = projectHyperModelForClient(snapshot, 'sidebar', 1);

    expect(projection?.tabs.map((tab) => tab.id)).toEqual([10]);
    expect(projection?.tabOwnerships).toEqual({ 10: { spaceId: 'one' } });
    expect(projection).not.toHaveProperty('tabContents');
  });

  it('derives remote space presence only for visible local tabs, bookmarks and favourites', () => {
    const sharedBookmark = testBookmark('shared-bookmark', 'Shared', 'https://shared.example', 'one-bookmarks');
    const tree = hyperBookmarkTree([
      testFolder('one', 'One', 'spaces', [
        testFolder('one-bookmarks', 'bookmarks {"hyper":{"spaceBookmarks":true,"spaceId":"one"}}', 'one', [sharedBookmark]),
      ]),
      testFolder('two', 'Two', 'spaces', [
        testFolder('two-tabs', 'tabs {"hyper":{"spaceTabs":true,"spaceId":"two"}}', 'two', [
          testBookmark(
            'backing-two',
            'Shared {"hyper":{"spaceId":"two","tab":true,"tabToken":"token-two"}}',
            'https://shared.example',
            'two-tabs',
          ),
        ]),
        testFolder('two-bookmarks', 'bookmarks {"hyper":{"spaceBookmarks":true,"spaceId":"two"}}', 'two'),
      ]),
    ], [
      testBookmark('shared-favourite', 'Shared {"hyper":{"favouriteSlot":0}}', 'https://shared.example', 'favourites'),
    ]);
    const snapshot = snapshotOf(5, {
      bookmarkTree: tree,
      tabs: [10, 11, 12].map((id) =>
        ({ id, windowId: id === 10 ? 1 : 2, url: 'https://shared.example' }) as Browser.tabs.Tab),
      windows: [normalWindow(1), normalWindow(2)],
    }, {
      activeSpaceIds: { 1: 'one' },
      tabOwnerships: {
        10: { spaceId: 'one' },
        11: { backingId: 'backing-two', backingToken: 'token-two', spaceId: 'two' },
        12: { spaceId: 'one' },
      },
    });

    const projection = projectHyperModelForClient(snapshot, 'sidebar', 1);

    expect(projection?.remoteSpacePresence).toEqual({
      bookmarkSpaceIds: { 'shared-bookmark': ['two'], 'shared-favourite': ['two'] },
      otherWindowTabCounts: { one: 1, two: 1 },
      tabSpaceIds: { 10: ['two'] },
    });
    expect(projection?.remoteSpacePresence.bookmarkSpaceIds['shared-bookmark'])
      .not.toContain('one');
    expect(projection?.tabs.map((tab) => tab.id)).toEqual([10]);
  });

  it('counts the tabs each space lists in other windows, blank pages included', () => {
    const tree = hyperBookmarkTree([
      testFolder('one', 'One', 'spaces', [
        testFolder('one-tabs', 'tabs {"hyper":{"spaceTabs":true,"spaceId":"one"}}', 'one', [
          testBookmark(
            'backing-one',
            'Page {"hyper":{"spaceId":"one","tab":true,"tabToken":"token-one"}}',
            'https://page.example',
            'one-tabs',
          ),
        ]),
      ]),
      testFolder('two', 'Two', 'spaces'),
    ]);
    const tab = (id: number, windowId: number, extra: Partial<Browser.tabs.Tab> = {}) =>
      ({ id, url: 'https://page.example', windowId, ...extra }) as Browser.tabs.Tab;
    const snapshot = snapshotOf(5, {
      bookmarkTree: tree,
      tabs: [
        tab(10, 1),
        tab(11, 2),
        tab(12, 2, { url: 'chrome://newtab/' }),
        tab(13, 3),
        tab(14, 2, { pinned: true }),
        tab(15, 2),
        tab(16, 2),
        tab(17, 4, { incognito: true }),
      ],
      windows: [normalWindow(1), normalWindow(2), normalWindow(3), { id: 4, incognito: true } as Browser.windows.Window],
    }, {
      tabOwnerships: {
        10: { spaceId: 'one' },
        11: { backingId: 'backing-one', backingToken: 'token-one', spaceId: 'one' },
        // A blank page has no backing, so it waits in recovery.
        12: { spaceId: 'one' },
        13: { spaceId: 'two' },
        14: { spaceId: 'one' },
        // Still on its way from window 1.
        15: { spaceId: 'one', windowId: 1 },
        17: { spaceId: 'one' },
      },
    });
    const counts = (windowId: number) =>
      projectHyperModelForClient(snapshot, 'sidebar', windowId)?.remoteSpacePresence.otherWindowTabCounts;

    // Neither the client's own tabs nor pinned, in-transit, unowned or private ones count.
    expect(counts(1)).toEqual({ one: 2, two: 1 });
    expect(counts(2)).toEqual({ one: 1, two: 1 });
  });

  it('projects bookmark import activity and this installation with the model revision', () => {
    const snapshot = snapshotOf(6, { windows: [normalWindow(1)] }, {
      bookmarkImportActiveCount: 1,
      installationId: 'local',
    });

    expect(projectHyperModelForClient(snapshot, 'sidebar', 1)).toMatchObject({
      bookmarkImportInProgress: true,
      installationId: 'local',
      revision: 6,
    });
  });

  it('shows another window\'s sidebar a shared drag without its remote tab IDs', () => {
    const snapshot = snapshotOf(6, { windows: [normalWindow(1), normalWindow(2)] }, {
      sharedDrag: { items: [{ kind: 'tab', tabId: 7 }], sourceWindowId: 1, token: 'drag-1' },
    });

    expect(projectHyperModelForClient(snapshot, 'sidebar', 2)?.sharedDrag)
      .toEqual({ items: [{ kind: 'tab' }], token: 'drag-1' });
    expect(JSON.stringify(projectHyperModelForClient(snapshot, 'sidebar', 2))).not.toContain('"tabId":7');
    expect(projectHyperModelForClient(snapshot, 'sidebar', 1)?.sharedDrag).toBeNull();
    expect(projectHyperModelForClient(snapshot, 'newtab', 2)?.sharedDrag).toBeNull();
  });

  it('gives a client only the command outcomes it issued', () => {
    const snapshot = windowScopedSnapshot();
    expect(projectHyperModelForClient(snapshot, 'sidebar', 1, 'client-a')?.commands
      .map((status) => status.commandId)).toEqual(['command-mine']);
    expect(projectHyperModelForClient(snapshot, 'sidebar', 1)?.commands).toEqual([]);
  });

  it('serves a search request only after binding it to the authenticated client', async () => {
    const open = installRuntime();
    const search = vi.fn(async () => ({
      results: [{
        item: {
          detail: 'Bookmarks',
          id: 'bookmark:design',
          kind: 'bookmark' as const,
          source: 'bookmark' as const,
          title: 'Design notes',
        },
        kind: 'item' as const,
      }],
      revision: 5,
    }));
    startHyperModelPortServer(storeWithWindowOne(), { search });
    const port = sidepanelPort();

    open(port);
    port.emit(sidebarHello(1));
    port.emit({ commands: [], query: 'design', requestId: 'query-1', type: 'search-query' });
    await Promise.resolve();

    expect(search).toHaveBeenCalledWith(expect.objectContaining({
      query: 'design',
      requestId: 'query-1',
    }), expect.objectContaining({ role: 'sidebar', windowId: 1 }));
    expect(port.postMessage).toHaveBeenCalledWith({
      requestId: 'query-1',
      results: [{
        item: {
          detail: 'Bookmarks',
          id: 'bookmark:design',
          kind: 'bookmark',
          source: 'bookmark',
          title: 'Design notes',
        },
        kind: 'item',
      }],
      revision: 5,
      type: 'search-result',
    });
  });

  it('sends page Search command statuses instead of a model snapshot', () => {
    const open = installRuntime();
    startHyperModelPortServer(storeWithWindowOne());
    const port = pageSearchPort();

    open(port);
    port.emit(hello('page-search', 1));

    expect(port.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'command-status',
      statuses: [],
    }));
    expect(port.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'snapshot' }));
  });

  it('rejects a page Search intent outside its authority', () => {
    const open = installRuntime();
    const submitIntent = vi.fn();
    startHyperModelPortServer(storeWithWindowOne(), { submitIntent });
    const port = pageSearchPort();

    open(port);
    port.emit(hello('page-search', 1));
    port.emit({ sequence: 1, type: 'ack' });
    port.emit(intent('delete-space', 'deleteSpace', { spaceId: 'space-1' }));

    expect(submitIntent).not.toHaveBeenCalled();
    expect(port.postMessage).toHaveBeenCalledWith({
      commandId: 'delete-space',
      reason: 'not-permitted',
      type: 'rejected',
    });
  });

  it('requires an intent to use the exact revision the client acknowledged', async () => {
    const open = installRuntime();
    const submitIntent = vi.fn(async () => ({ revision: 1, status: 'accepted' as const }));
    startHyperModelPortServer(storeWithWindowOne(), { submitIntent });
    const port = sidepanelPort();

    open(port);
    port.emit(sidebarHello(1));
    port.emit(intent('before-ack', 'setPreference'));
    expect(submitIntent).not.toHaveBeenCalled();
    expect(port.postMessage).toHaveBeenCalledWith({
      commandId: 'before-ack',
      reason: 'precondition-failed',
      type: 'rejected',
    });

    port.emit({ sequence: 1, type: 'ack' });
    port.emit(intent('after-ack', 'setPreference'));
    await Promise.resolve();
    expect(submitIntent).toHaveBeenCalledWith(expect.objectContaining({
      commandId: 'after-ack',
    }), expect.objectContaining({ role: 'sidebar' }));
  });

  it('disconnects a stalled sidebar without blocking another view', () => {
    const open = installRuntime();
    const store = storeWithWindowOne();
    startHyperModelPortServer(store);
    const port = sidepanelPort();
    const newTab = fakePort({ tab: { id: 4, windowId: 1 }, url: extensionUrl('/newtab.html') });
    const failure = new Error('The port closed before its disconnect event.');
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      open(port);
      port.emit(sidebarHello(1));
      open(newTab);
      newTab.emit({ ...sidebarHello(1), role: 'newtab' });
      port.emit({ sequence: 1, type: 'ack' });
      newTab.emit({ sequence: 1, type: 'ack' });
      port.postMessage.mockImplementationOnce(() => { throw failure; });

      store.set(setCommandStatusesAtom, {});

      expect(port.disconnect).toHaveBeenCalledOnce();
      expect(error).toHaveBeenCalledWith('Unable to deliver the Hyper model.', failure);
      expect(newTab.postMessage).toHaveBeenCalledWith(expect.objectContaining({
        revision: 1,
        type: 'snapshot',
      }));
    } finally {
      error.mockRestore();
    }
  });

  it('disconnects after a malformed message, duplicate hello, or bad acknowledgement', () => {
    const open = installRuntime();
    startHyperModelPortServer(storeWithWindowOne());
    const malformed = sidepanelPort();
    const duplicateHello = sidepanelPort();
    const badAcknowledgement = sidepanelPort();

    open(malformed);
    malformed.emit({ type: 'intent' });
    open(duplicateHello);
    duplicateHello.emit(sidebarHello(1));
    duplicateHello.emit(sidebarHello(1));
    open(badAcknowledgement);
    badAcknowledgement.emit(sidebarHello(1));
    badAcknowledgement.emit({ sequence: 99, type: 'ack' });

    expect(malformed.disconnect).toHaveBeenCalled();
    expect(duplicateHello.disconnect).toHaveBeenCalled();
    expect(badAcknowledgement.disconnect).toHaveBeenCalled();
  });

  it('prefers the window the browser reports over the one a client claims', () => {
    const open = installRuntime();
    startHyperModelPortServer(createHyperModelStore());
    const port = fakePort({ tab: { id: 4, windowId: 7 }, url: extensionUrl('/newtab.html') });

    open(port);
    port.emit({ ...sidebarHello(9), role: 'newtab' });

    expect(port.postMessage).toHaveBeenCalledWith({
      buildId: HYPER_BUILD_ID,
      reason: 'unauthenticated',
      type: 'protocol-error',
    });
    expect(port.disconnect).toHaveBeenCalled();
  });

  it('states its build both when it welcomes a view and when it turns one away', () => {
    const open = installRuntime();
    startHyperModelPortServer(storeWithWindowOne());
    const welcomed = sidepanelPort();
    const refused = sidepanelPort();

    open(welcomed);
    welcomed.emit(sidebarHello(1));
    open(refused);
    refused.emit({ sequence: 1, type: 'ack' });

    expect(welcomed.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ buildId: HYPER_BUILD_ID, type: 'welcome' }),
    );
    expect(refused.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ buildId: HYPER_BUILD_ID, type: 'protocol-error' }),
    );
  });

  it('evicts the incumbent sidebar rather than serving one window twice', () => {
    const open = installRuntime();
    startHyperModelPortServer(storeWithWindowOne());
    const first = sidepanelPort();
    const second = sidepanelPort();

    open(first);
    first.emit(sidebarHello(1));
    open(second);
    second.emit(sidebarHello(1));

    expect(first.disconnect).toHaveBeenCalled();
    expect(second.disconnect).not.toHaveBeenCalled();
  });

  it('accepts a port before views may authenticate, but answers it only once they may', async () => {
    const open = installRuntime();
    const onNativeSidebarPresence = vi.fn();
    let admit = () => {};
    startHyperModelPortServer(storeWithWindowOne(), {
      admitted: new Promise<void>((resolve) => { admit = resolve; }),
      onNativeSidebarPresence,
    });
    const waiting = sidepanelPort();
    const gone = sidepanelPort();

    open(waiting);
    waiting.emit(sidebarHello(1));
    open(gone);
    gone.emit(sidebarHello(1));
    gone.close();
    await Promise.resolve();
    expect(waiting.postMessage).not.toHaveBeenCalled();

    admit();
    await Promise.resolve();

    expect(waiting.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'welcome' }));
    expect(waiting.disconnect).not.toHaveBeenCalled();
    expect(gone.postMessage).not.toHaveBeenCalled();
    expect(onNativeSidebarPresence.mock.calls).toEqual([[1, true]]);
  });

  it('admits an in-page sidebar only with the token issued to its own tab', () => {
    const sidebar = hello('sidebar');
    const authorize = (tabId: number, token: string) => tabId === 4 && token === 'issued';
    const frame = (token: string, tabId = 4) => ({
      tab: { id: tabId, windowId: 7 },
      url: `${extensionUrl('/inpage.html')}?token=${token}`,
    });

    expect(resolveHyperModelPortRole(frame('issued'), sidebar, extensionUrl, authorize))
      .toBe('sidebar');
    expect(resolveHyperModelPortRole(frame('guessed'), sidebar, extensionUrl, authorize))
      .toBeUndefined();
    expect(resolveHyperModelPortRole(frame('issued', 5), sidebar, extensionUrl, authorize))
      .toBeUndefined();
    expect(resolveHyperModelPortRole(frame('issued'), sidebar, extensionUrl)).toBeUndefined();
  });

  it('reports the browser sidebar alone, without letting an in-page sidebar evict it', () => {
    const open = installRuntime();
    const onNativeSidebarPresence = vi.fn();
    startHyperModelPortServer(storeWithWindowOne(), {
      authorizeInPageSidebar: () => true,
      onNativeSidebarPresence,
    });
    const native = sidepanelPort();
    const inPage = fakePort({
      tab: { id: 4, windowId: 1 },
      url: `${extensionUrl('/inpage.html')}?token=issued`,
    });

    open(native);
    native.emit(sidebarHello(1));
    open(inPage);
    inPage.emit(sidebarHello(1));
    inPage.close();

    expect(native.disconnect).not.toHaveBeenCalled();
    expect(inPage.disconnect).not.toHaveBeenCalled();
    expect(onNativeSidebarPresence.mock.calls).toEqual([[1, true]]);
    native.close();
    expect(onNativeSidebarPresence.mock.calls).toEqual([[1, true], [1, false]]);
  });
});