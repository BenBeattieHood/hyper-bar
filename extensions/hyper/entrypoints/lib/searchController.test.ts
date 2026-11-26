import { describe, expect, it, vi } from 'vitest';
import {
  commitHyperModelAtom,
  createHyperModelStore,
  emptyBrowserObservation,
  emptyRuntimeMetadata,
  hyperModelAtom,
  type BrowserObservation,
  type HyperModelStore,
  type RuntimeMetadata,
} from './model';
import type { BookmarkNode } from './bookmarks';
import type { SearchCommand } from './searchIndex';
import { createSearchController } from './searchController';
import type { SearchSelectionHistory } from './searchSelection';
import { hyperBookmarkTree, testBookmark, testFolder } from './testBookmarkTree';
import { commitTestSources } from './testFixtures';

const normalWindow = (id: number) => ({ id, incognito: false }) as Browser.windows.Window;

/** A store that starts with one normal window, 7, and nothing else. */
const windowStore = () => createHyperModelStore({
  browser: { ...emptyBrowserObservation, windows: [normalWindow(7)] },
  runtime: emptyRuntimeMetadata,
});

/** A store whose first commit observes window 7 and the given sources. */
function committedStore(browser: Partial<BrowserObservation>, runtime: Partial<RuntimeMetadata> = {}) {
  const store = createHyperModelStore();
  commitTestSources(store, { windows: [normalWindow(7)], ...browser }, runtime);
  return store;
}

function controllerFor(
  store: HyperModelStore,
  dependencies: Partial<Parameters<typeof createSearchController>[0]> = {},
) {
  return createSearchController({
    extensionOrigin: () => 'chrome-extension://hyper/',
    history: {
      deleteUrl: vi.fn(async () => undefined),
      search: vi.fn(async () => [] as Browser.history.HistoryItem[]),
    },
    reconcile: vi.fn(async () => undefined),
    selectionStorage: { set: vi.fn(async () => undefined) },
    store,
    ...dependencies,
  });
}

const searchQuery = (query: string, commands: SearchCommand[] = [], requestId = 'request-1') =>
  ({ commands, query, requestId, type: 'search-query' as const });

function controllerHarness() {
  const store = windowStore();
  const history = {
    deleteUrl: vi.fn(async () => undefined),
    search: vi.fn(async () => [{
      id: '1',
      title: 'Design notes',
      url: 'https://design.example',
    } as Browser.history.HistoryItem]),
  };
  const reconciler = { scheduleReconciliation: vi.fn(async () => store.get(hyperModelAtom)) };
  const selectionStorage = { set: vi.fn(async () => undefined) };
  const controller = controllerFor(store, {
    history,
    reconcile: () => reconciler.scheduleReconciliation(),
    selectionStorage,
  });
  return { controller, history, reconciler, selectionStorage };
}

function searchBookmarkTree(): BookmarkNode[] {
  return hyperBookmarkTree([testFolder('space-1', 'Work', 'spaces', [
    testFolder('space-1-bookmarks', 'bookmarks {"hyper":{"spaceBookmarks":true,"spaceId":"space-1"}}', 'space-1', [
      testBookmark('design', 'Design archive', 'https://design.example', 'space-1-bookmarks'),
    ]),
  ])]);
}

describe('search controller', () => {
  it('owns history records and reconciles their mutations', async () => {
    const { controller, history, reconciler } = controllerHarness();

    await controller.initialize();
    expect(controller.runtimeSignals().historySearchItems).toMatchObject([{
      id: 'history:1',
      title: 'Design notes',
    }]);
    await controller.deleteHistory('https://design.example');

    expect(history.deleteUrl).toHaveBeenCalledWith({ url: 'https://design.example' });
    expect(controller.runtimeSignals().historySearchItems).toEqual([]);
    expect(reconciler.scheduleReconciliation).toHaveBeenCalledTimes(2);
  });

  it('does not retain a history entry after a removal notification repeats it', async () => {
    const { controller, reconciler } = controllerHarness();

    await controller.initialize();
    for (let repeat = 0; repeat < 2; repeat += 1) {
      await controller.handleHistoryRemoved({ allHistory: false, urls: ['https://design.example'] });
    }

    expect(controller.runtimeSignals().historySearchItems).toEqual([]);
    expect(reconciler.scheduleReconciliation).toHaveBeenCalledTimes(2);
  });

  it('persists a selection then asks the model to commit it', async () => {
    const { controller, reconciler, selectionStorage } = controllerHarness();

    await controller.recordSelection(' Design ', 'bookmark:https://design.example');

    expect(selectionStorage.set).toHaveBeenCalledWith({
      hyperSearchSelectionHistory: {
        design: {
          'bookmark:https://design.example': { count: 1, lastUsed: expect.any(Number) },
        },
      },
    });
    expect(reconciler.scheduleReconciliation).toHaveBeenCalledTimes(1);
  });

  it('changes selection rank only after it commits to a new model revision', async () => {
    const store = windowStore();
    let persistedHistory: SearchSelectionHistory = {};
    let selectionWriteStarted = false;
    let releaseSelectionCommit: () => void = () => undefined;
    let releaseSelectionWrite: () => void = () => undefined;
    const selectionCommit = new Promise<void>((resolve) => {
      releaseSelectionCommit = resolve;
    });
    const selectionWrite = new Promise<void>((resolve) => {
      releaseSelectionWrite = resolve;
    });
    const reconcile = vi.fn(async () => {
      if (selectionWriteStarted) await selectionCommit;
      const snapshot = store.get(hyperModelAtom);
      return store.set(commitHyperModelAtom, {
        sources: {
          browser: snapshot.browser,
          runtime: { ...snapshot.runtime, searchSelectionHistory: persistedHistory },
        },
      });
    });
    const controller = controllerFor(store, {
      reconcile,
      selectionStorage: {
        set: vi.fn(async (items) => {
          persistedHistory = items.hyperSearchSelectionHistory as SearchSelectionHistory;
          selectionWriteStarted = true;
          releaseSelectionWrite();
        }),
      },
    });
    const request = searchQuery('design', [
      { detail: 'Hyper', icon: 'settings', id: 'first', label: 'Design first' },
      { detail: 'Hyper', icon: 'settings', id: 'second', label: 'Design second' },
    ]);
    const commandIds = (response: Awaited<ReturnType<typeof controller.search>>) =>
      response?.results.flatMap((result) => result.kind === 'command' ? [result.commandId] : []);

    const before = await controller.search(request, { windowId: 7 });
    const revisionBeforeSelection = store.get(hyperModelAtom).revision;
    const recording = controller.recordSelection('design', 'command:second');
    await selectionWrite;
    const beforeCommit = await controller.search(request, { windowId: 7 });
    releaseSelectionCommit();
    await recording;
    const after = await controller.search(request, { windowId: 7 });

    expect(commandIds(before)).toEqual(['first', 'second']);
    expect(commandIds(beforeCommit)).toEqual(['first', 'second']);
    expect(store.get(hyperModelAtom).revision).toBeGreaterThan(revisionBeforeSelection);
    expect(after?.revision).toBe(store.get(hyperModelAtom).revision);
    expect(commandIds(after)).toEqual(['second', 'first']);
  });

  it('queries committed records for only the authenticated normal window', async () => {
    const store = committedStore({
      bookmarkTree: searchBookmarkTree(),
      extensionOrigin: 'chrome-extension://hyper/',
      tabs: [
        { id: 1, title: 'Design document', url: 'https://design.example', windowId: 7 },
        { id: 2, title: 'Design in another window', url: 'https://other.example', windowId: 8 },
        { id: 3, title: 'Design extension page', url: 'chrome-extension://hyper/newtab.html', windowId: 7 },
      ] as Browser.tabs.Tab[],
      windows: [normalWindow(7), normalWindow(8), { id: 9, incognito: true } as Browser.windows.Window],
    }, {
      activeSpaceIds: { 7: 'space-1' },
      historySearchItems: [{
        detail: 'History',
        id: 'history:design',
        kind: 'history',
        source: 'history',
        title: 'Design history',
        url: 'https://history.example/design',
      }],
      tabContents: {
        1: { navigationVersion: 0, text: 'Searchable design page text', url: 'https://design.example' },
      },
      tabContentVersions: { 1: 0 },
      tabOwnerships: { 1: { spaceId: 'space-1' } },
    });
    const controller = controllerFor(store);

    const response = await controller.search(searchQuery('design', [
      { detail: 'Hyper', icon: 'settings', id: 'open-design', label: 'Open Design settings' },
    ]), { windowId: 7 });

    expect(response?.revision).toBe(store.get(hyperModelAtom).revision);
    expect(response?.results.map((result) =>
      result.kind === 'item'
        ? result.item.id
        : result.kind === 'command'
          ? result.commandId
          : result.target.kind === 'search' ? result.target.query : result.target.url,
    )).toEqual(expect.arrayContaining([
      'bookmark:design',
      'history:design',
      'open-design',
      'tab:1',
    ]));
    expect(response?.results.some((result) =>
      result.kind === 'item' && ['tab:2', 'tab:3'].includes(result.item.id),
    )).toBe(false);
    // Page text ranks a tab in the background but never crosses the port.
    const byPageText = await controller.search(searchQuery('searchable'), { windowId: 7 });
    expect(byPageText?.results).toContainEqual(expect.objectContaining({
      item: expect.objectContaining({ id: 'tab:1' }),
      kind: 'item',
    }));
    expect(byPageText?.results.concat(response?.results ?? []).some((result) =>
      result.kind === 'item' && result.item.content !== undefined,
    )).toBe(false);
    expect(await controller.search(searchQuery('open design', [], 'request-2'), { windowId: 7 })).not.toEqual(expect.objectContaining({
      results: expect.arrayContaining([{ commandId: 'open-design', kind: 'command' }]),
    }));
    expect(await controller.search(searchQuery('design', [], 'request-3'), { windowId: 9 })).toBeUndefined();
  });

  it('builds its text index in idle batches when Search opens with nothing typed', async () => {
    const store = committedStore({ extensionOrigin: 'chrome-extension://hyper/' }, {
      historySearchItems: Array.from({ length: 900 }, (_, index) => ({
        detail: 'History',
        id: `history:${index}`,
        kind: 'history' as const,
        source: 'history' as const,
        title: `Visited page ${index}`,
        url: `https://pages.example/${index}`,
      })),
    });
    const tasks: (() => void)[] = [];
    const controller = controllerFor(store, { later: (task) => tasks.push(task) });
    const search = (query: string) => controller.search(searchQuery(query, [], query), { windowId: 7 });

    await search('');
    await search('');
    let batches = 0;
    while (tasks.length) {
      tasks.shift()!();
      batches += 1;
    }

    expect(batches).toBe(3);
    expect((await search('page 412'))?.results).toContainEqual(expect.objectContaining({
      item: expect.objectContaining({ id: 'history:412' }),
    }));
  });

  it('offers space switches only to in-page Search, which holds no projection', async () => {
    const controller = controllerFor(committedStore(
      { bookmarkTree: searchBookmarkTree() },
      { activeSpaceIds: { 7: 'space-1' } },
    ));
    const request = searchQuery('switch to work');

    const pageSearch = await controller.search(request, { role: 'page-search', windowId: 7 });
    const sidebar = await controller.search(request, { role: 'sidebar', windowId: 7 });

    expect(pageSearch?.results).toContainEqual({
      command: {
        detail: 'Current space',
        icon: 'space',
        id: 'space:space-1',
        keywords: ['Work'],
        label: 'Switch to Work',
      },
      commandId: 'space:space-1',
      kind: 'command',
    });
    expect(sidebar?.results.some((result) => result.kind === 'command')).toBe(false);
  });

  it('offers in-page Search its window\'s music commands, each naming the music tab', async () => {
    const controller = controllerFor(committedStore({
      bookmarkTree: searchBookmarkTree(),
      tabs: [
        { active: true, id: 1, index: 0, title: 'Article', url: 'https://page.example', windowId: 7 },
        { audible: true, id: 2, index: 1, title: 'Radio', url: 'https://radio.example', windowId: 7 },
      ] as Browser.tabs.Tab[],
    }, {
      activeSpaceIds: { 7: 'space-1' },
      mediaControlAvailable: true,
      mediaStates: {
        2: {
          elementIndex: 0,
          frameId: 0,
          navigationVersion: 0,
          state: 'playing',
          tabId: 2,
          url: 'https://radio.example',
        },
      },
    }));
    const request = searchQuery('music');

    const pageSearch = await controller.search(request, { role: 'page-search', windowId: 7 });
    const sidebar = await controller.search(request, { role: 'sidebar', windowId: 7 });

    expect(pageSearch?.results.flatMap((result) => result.kind === 'command' ? [result.command] : []))
      .toEqual([
        expect.objectContaining({ detail: 'Radio', id: 'media:pause', label: 'Pause music', tabId: 2 }),
        expect.objectContaining({ detail: 'Radio', id: 'media:focus', label: 'Switch to music', tabId: 2 }),
      ]);
    expect(sidebar?.results.some((result) => result.kind === 'command')).toBe(false);
  });

  it('answers an empty query with recent picks, and forgets one when asked', async () => {
    const store = createHyperModelStore();
    let persisted: SearchSelectionHistory = {
      settings: { 'command:settings': { count: 1, lastUsed: 1 } },
      work: { 'command:space:space-1': { count: 1, lastUsed: 3 } },
      gone: { 'command:missing': { count: 1, lastUsed: 2 } },
    };
    const commit = () => {
      const snapshot = store.get(hyperModelAtom);
      return store.set(commitHyperModelAtom, {
        sources: {
          browser: { ...emptyBrowserObservation, bookmarkTree: searchBookmarkTree(), windows: [normalWindow(7)] },
          runtime: {
            ...snapshot.runtime,
            activeSpaceIds: { 7: 'space-1' },
            searchSelectionHistory: persisted,
          },
        },
      });
    };
    commit();
    const selectionStorage = {
      set: vi.fn(async (items: Record<string, unknown>) => {
        persisted = items.hyperSearchSelectionHistory as SearchSelectionHistory;
      }),
    };
    const controller = controllerFor(store, { reconcile: vi.fn(async () => commit()), selectionStorage });
    const request = searchQuery('  ', [{ detail: 'Hyper', icon: 'settings', id: 'settings', label: 'Settings' }]);

    const before = await controller.search(request, { role: 'page-search', windowId: 7 });
    await controller.forgetSelection('command:space:space-1');
    const after = await controller.search(request, { role: 'page-search', windowId: 7 });

    expect(before?.results).toEqual([
      expect.objectContaining({
        command: expect.objectContaining({ id: 'space:space-1' }),
        commandId: 'space:space-1',
        recent: { query: 'work', resultId: 'command:space:space-1' },
      }),
      { commandId: 'settings', kind: 'command', recent: { query: 'settings', resultId: 'command:settings' } },
    ]);
    expect(selectionStorage.set).toHaveBeenCalledWith({
      hyperSearchSelectionHistory: {
        gone: { 'command:missing': { count: 1, lastUsed: 2 } },
        settings: { 'command:settings': { count: 1, lastUsed: 1 } },
      },
    });
    expect(after?.results.map((result) => result.kind === 'command' && result.commandId)).toEqual(['settings']);
  });
});