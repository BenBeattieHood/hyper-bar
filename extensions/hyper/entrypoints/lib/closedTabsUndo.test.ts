import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HyperModelPortClient } from './modelPort';
import { createTabIntentHandlers, type TabIntentHandlerDependencies } from './tabIntentHandlers';
import { installSpaceTabsBrowser, type TabSpec } from './testSpaceTabsBrowser';
import { createTimedMessages, type TimedMessages } from './timedMessages';

vi.mock('./bookmarkStorage', async (importOriginal) => ({
  ...await importOriginal<typeof import('./bookmarkStorage')>(),
  ensureSpaceTabsFolder: vi.fn(),
}));
vi.mock('./tabOwnership', async (importOriginal) => ({
  ...await importOriginal<typeof import('./tabOwnership')>(),
  getTabOwnership: vi.fn(),
  loadTabOwnerships: vi.fn(),
}));
vi.mock('./windowState', async (importOriginal) => ({
  ...await importOriginal<typeof import('./windowState')>(),
  getWindowActiveSpaceId: vi.fn(),
}));

const client: HyperModelPortClient = { clientId: 'sidebar-client', role: 'sidebar', windowId: 3 };

const WORK_TABS: TabSpec[] = [
  { id: 1, pinned: true, spaceId: 'work', url: 'https://pinned.test/' },
  { active: true, backingId: 'a', id: 2, spaceId: 'work' },
  { backingId: 'b', id: 3, spaceId: 'work' },
  { backingId: 'c', id: 4, spaceId: 'work' },
];

/** The closeTabs handler over a fake browser whose closes release backings. */
function installBrowser(specs: TabSpec[] = WORK_TABS, messages?: TimedMessages) {
  const browserState = installSpaceTabsBrowser(specs);
  const stub = () => vi.fn(async () => undefined);
  const dependencies = {
    ...browserState.dependencies,
    ...(messages ? { messages } : {}),
    activateRemoteTab: stub(),
    adoptTabPositions: stub(),
    closeTabsInSpace: stub(),
    deleteHistory: stub(),
    expectAttachment: vi.fn(),
    forgetSearchSelection: stub(),
    getTabOwnership: stub(),
    moveRemoteTabToWindow: stub(),
    moveTabTreeNodes: stub(),
    openNewTab: stub(),
    recordSearchSelection: stub(),
    releaseSplitViews: stub(),
    sharedDragTabIds: vi.fn(() => undefined),
  } satisfies TabIntentHandlerDependencies;
  // A window whose last tab closes closes with it.
  vi.stubGlobal('browser', { ...browser, windows: { remove: stub() } });
  return { ...browserState, closeTabs: createTabIntentHandlers(dependencies).closeTabs! };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('closing tabs', () => {
  it('offers to undo closing a tab, which reopens it in its place and shows it again', async () => {
    const { closeTabs, messages, tree, undo, windowPages } = installBrowser();

    await closeTabs.run({ tabIds: [2] }, client);

    expect(messages.offer).toHaveBeenCalledOnce();
    expect(messages.offer).toHaveBeenCalledWith(3, expect.objectContaining({
      detail: 'Page a',
      kind: 'undo',
      text: 'Closed tab',
    }));
    expect(tree.outline('work-tabs')).toEqual([['Research', ['Page b']], 'Page c']);

    await undo();

    expect(tree.outline('work-tabs')).toEqual(['Page a', ['Research', ['Page b']], 'Page c']);
    expect(windowPages()).toEqual(['https://pinned.test/', 'b', 'c', '*a']);
  });

  it('counts the tabs it closed, and its undo leaves the tab the user is on showing', async () => {
    const { closeTabs, messages, tree, undo, windowPages } = installBrowser();

    await closeTabs.run({ tabIds: [3, 4, 3] }, client);

    expect(messages.offer).toHaveBeenCalledWith(3, expect.objectContaining({ text: 'Closed 2 tabs' }));

    await undo();

    expect(tree.outline('work-tabs')).toEqual(['Page a', ['Research', ['Page b']], 'Page c']);
    expect(windowPages()).toEqual(['https://pinned.test/', '*a', 'b', 'c']);
  });

  it('names a closed folder in one message, and its undo makes the folder again', async () => {
    const { closeTabs, messages, tree, undo, windowPages } = installBrowser();

    await closeTabs.run({ folderTitle: 'Research', tabIds: [3] }, client);

    expect(messages.offer).toHaveBeenCalledOnce();
    expect(messages.offer).toHaveBeenCalledWith(3, expect.objectContaining({
      detail: 'Research',
      kind: 'undo',
      text: 'Closed folder',
    }));
    await tree.api.removeTree('research');

    await undo();

    expect(tree.outline('work-tabs')).toEqual(['Page a', ['Research', ['Page b']], 'Page c']);
    expect(windowPages()).toEqual(['https://pinned.test/', '*a', 'c', 'b']);
  });

  it('joins closes in a row into one undo, which makes their folder again once', async () => {
    const messages = createTimedMessages({ reconcile: async () => undefined });
    const { closeTabs, tree, windowPages } = installBrowser(WORK_TABS, messages);
    await tree.api.move('c', { parentId: 'research' });

    await closeTabs.run({ tabIds: [4] }, client);
    await closeTabs.run({ folderTitle: 'Research', tabIds: [3] }, client);
    // Hyper removes a tab folder its last tab left.
    await tree.api.removeTree('research');

    expect(messages.current(3)).toMatchObject({ kind: 'undo', text: 'Closed 2 tabs' });
    await messages.handlers.actOnTimedMessage.run({ messageId: messages.current(3)!.id }, client);

    expect(tree.outline('work-tabs')).toEqual(['Page a', ['Research', ['Page b', 'Page c']]]);
    expect(windowPages()).toEqual(['https://pinned.test/', '*a', 'b', 'c']);
  });

  it('offers to undo closing the other tabs, and only those it closed', async () => {
    const { closeTabs, messages, tree, undo } = installBrowser();

    await closeTabs.run({ condition: 'other-unpinned', keepTabId: 2, tabIds: [1, 3, 4], windowId: 3 }, client);

    expect(messages.offer).toHaveBeenCalledWith(3, expect.objectContaining({ text: 'Closed 2 tabs' }));

    await undo();

    expect(tree.outline('work-tabs')).toEqual(['Page a', ['Research', ['Page b']], 'Page c']);
  });

  it('offers nothing when what closed has nothing to bring back', async () => {
    const { closeTabs, messages } = installBrowser([
      ...WORK_TABS,
      { id: 6, spaceId: 'work' },
    ]);

    await closeTabs.run({ tabIds: [1, 6] }, client);

    expect(messages.offer).not.toHaveBeenCalled();
  });
});
