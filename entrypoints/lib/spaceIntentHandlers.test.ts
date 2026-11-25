import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BookmarkNode } from './bookmarks';
import { SupersededTargetError } from './modelGuards';
import type { HyperModelPortClient } from './modelPort';
import { duplicateSpace } from './spaceDuplication';
import { createSpaceIntentHandlers } from './spaceIntentHandlers';
import type { BookmarkTree } from './testBookmarkTree';
import { installSpaceTabsBrowser, type TabSpec } from './testSpaceTabsBrowser';

vi.mock('./bookmarkStorage', async (importOriginal) => ({
  ...await importOriginal<typeof import('./bookmarkStorage')>(),
  ensureSpaceTabsFolder: vi.fn(),
}));
vi.mock('./spaceDuplication', () => ({ duplicateSpace: vi.fn() }));
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

/** The space handlers over a fake browser of a few windows and the spaces their tabs are in. */
function installBrowser(specs: TabSpec[], shownSpaceId = 'work') {
  const browserState = installSpaceTabsBrowser(specs, shownSpaceId);
  const windowSpaces = { select: vi.fn(), showNewSpace: vi.fn(async () => undefined) };
  const dependencies = {
    ...browserState.dependencies,
    setSpaceArchived: vi.fn(async () => undefined),
    windowSpaces: () => windowSpaces,
  };
  return { ...browserState, dependencies, handlers: createSpaceIntentHandlers(dependencies), windowSpaces };
}

const workTabs = (tree: BookmarkTree) => tree.outline('work-tabs');

const WORK_TABS: TabSpec[] = [
  { id: 1, pinned: true, spaceId: 'work', url: 'https://pinned.test/' },
  { active: true, backingId: 'a', id: 2, spaceId: 'work' },
  { backingId: 'b', id: 3, spaceId: 'work' },
  { backingId: 'c', discarded: true, id: 4, spaceId: 'work' },
  { backingId: 'h', id: 5, spaceId: 'home' },
  { id: 9, spaceId: 'work', url: 'https://other-window.test/', windowId: 7 },
];

beforeEach(() => {
  vi.mocked(duplicateSpace).mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('closing a space\'s tabs', () => {
  it('leaves the shown space on a new tab page, and its undo puts every tab back as it was', async () => {
    const { dependencies, handlers, messages, tree, undo, windowPages } = installBrowser(WORK_TABS);

    await handlers.closeSpaceTabs!.run({ spaceId: 'work' }, client);

    expect(dependencies.closeTabs).toHaveBeenCalledWith([2, 3, 4]);
    expect(dependencies.markIntentionalTab).toHaveBeenCalledWith(100);
    expect(dependencies.routeTab).toHaveBeenCalledWith(100, 'work');
    expect(windowPages()).toEqual(['https://pinned.test/', 'h', '*new tab']);
    expect(windowPages(7)).toEqual(['https://other-window.test/']);
    expect(messages.offer).toHaveBeenCalledWith(3, expect.objectContaining({ kind: 'undo', text: 'Closed 3 tabs' }));
    expect(workTabs(tree)).toEqual([['Research', []]]);

    await undo();

    expect(dependencies.restoreSpaceTabs).toHaveBeenCalledWith('work', 3, []);
    expect(workTabs(tree)).toEqual(['Page a', ['Research', ['Page b']], 'Page c']);
    expect(windowPages()).toEqual(['https://pinned.test/', 'h', '*a', 'b', 'c']);
    expect(dependencies.routeTab.mock.calls.slice(1).map(([, spaceId]) => spaceId)).toEqual(['work', 'work', 'work']);
  });

  it('shows a blank tab the space already has rather than opening another, and keeps it after an undo', async () => {
    const { dependencies, handlers, messages, undo, windowPages } = installBrowser([
      { active: true, backingId: 'a', id: 2, spaceId: 'work' },
      { id: 6, spaceId: 'work' },
      { backingId: 'h', id: 5, spaceId: 'home' },
    ]);

    await handlers.closeSpaceTabs!.run({ spaceId: 'work' }, client);

    expect(browser.tabs.create).not.toHaveBeenCalled();
    expect(dependencies.closeTabs).toHaveBeenCalledWith([2]);
    expect(messages.offer).toHaveBeenCalledWith(3, expect.objectContaining({
      detail: 'Page a',
      kind: 'undo',
      text: 'Closed tab',
    }));
    expect(windowPages()).toEqual(['*new tab', 'h']);

    await undo();

    expect(windowPages()).toEqual(['new tab', 'h', '*a']);
  });

  it('closes a space the window is not showing without changing what it shows', async () => {
    const { dependencies, handlers, undo, windowPages } = installBrowser([
      { active: true, backingId: 'h', id: 5, spaceId: 'home' },
      { backingId: 'b', id: 3, spaceId: 'work' },
      { backingId: 'c', id: 4, spaceId: 'work' },
    ], 'home');

    await handlers.closeSpaceTabs!.run({ spaceId: 'work' }, client);

    expect(browser.tabs.create).not.toHaveBeenCalled();
    expect(dependencies.closeTabs).toHaveBeenCalledWith([3, 4]);
    expect(windowPages()).toEqual(['*h']);

    await undo();

    expect(windowPages()).toEqual(['*h', 'b', 'c']);
    expect(browser.tabs.update).not.toHaveBeenCalled();
  });

  it('counts the pages it closed, and not a blank page closed with them, which has nothing to reopen', async () => {
    const { dependencies, handlers, messages } = installBrowser([
      { active: true, backingId: 'h', id: 5, spaceId: 'home' },
      { backingId: 'b', id: 3, spaceId: 'work' },
      { id: 6, spaceId: 'work', url: 'about:blank' },
      { backingId: 'c', id: 4, spaceId: 'work' },
    ], 'home');

    await handlers.closeSpaceTabs!.run({ spaceId: 'work' }, client);

    expect(dependencies.closeTabs).toHaveBeenCalledWith([3, 6, 4]);
    expect(messages.offer).toHaveBeenCalledWith(3, expect.objectContaining({ text: 'Closed 2 tabs' }));
  });

  it('keeps the shown space when the window shows a tab of another space', async () => {
    const { dependencies, handlers, windowPages } = installBrowser([
      { active: true, backingId: 'b', id: 3, spaceId: 'work' },
      { backingId: 'h', id: 5, spaceId: 'home' },
    ], 'home');

    await handlers.closeSpaceTabs!.run({ spaceId: 'work' }, client);

    expect(dependencies.routeTab).toHaveBeenCalledWith(100, 'home');
    expect(windowPages()).toEqual(['h', '*new tab']);
  });

  it('leaves the window as the user left it when they moved on before undoing', async () => {
    const { handlers, tabs, undo, windowPages } = installBrowser(WORK_TABS);
    await handlers.closeSpaceTabs!.run({ spaceId: 'work' }, client);
    tabs.find((tab) => tab.id === 100)!.url = 'https://elsewhere.test/';

    await undo();

    expect(windowPages()).toEqual(['https://pinned.test/', 'h', '*https://elsewhere.test/', 'a', 'b', 'c']);
  });

  it('does nothing when the window has no tab of the space but pinned ones', async () => {
    const { dependencies, handlers, messages } = installBrowser([
      { active: true, id: 1, pinned: true, spaceId: 'work', url: 'https://pinned.test/' },
      { backingId: 'h', id: 5, spaceId: 'home' },
    ]);

    await handlers.closeSpaceTabs!.run({ spaceId: 'work' }, client);

    expect(dependencies.closeTabs).not.toHaveBeenCalled();
    expect(messages.offer).not.toHaveBeenCalled();
  });

  it('opens no tab and closes nothing when the shown space has only blank tabs', async () => {
    const { dependencies, handlers, messages } = installBrowser([{ active: true, id: 6, spaceId: 'work' }]);

    await handlers.closeSpaceTabs!.run({ spaceId: 'work' }, client);

    expect(browser.tabs.create).not.toHaveBeenCalled();
    expect(dependencies.closeTabs).not.toHaveBeenCalled();
    expect(messages.offer).not.toHaveBeenCalled();
  });

  it('names the space and the window as its targets', () => {
    const { handlers } = installBrowser([]);

    expect(handlers.closeSpaceTabs!.targets({ spaceId: 'work' }, client)).toEqual(['space:work', 'window:3']);
  });
});

describe('reloading a space\'s tabs', () => {
  it('reloads the window\'s pages in the space, leaving pinned and blank tabs and those holding no page', async () => {
    const { handlers } = installBrowser([
      ...WORK_TABS,
      { id: 6, spaceId: 'work', url: 'about:blank' },
      { id: 7, spaceId: 'work', status: 'unloaded', url: 'https://restored.test/' },
      { frozen: true, id: 8, spaceId: 'work', url: 'https://frozen.test/' },
    ]);

    await handlers.reloadSpaceTabs!.run({ spaceId: 'work' }, client);

    expect(vi.mocked(browser.tabs.reload).mock.calls).toEqual([[2], [3], [8]]);
  });
});

describe('duplicating a space', () => {
  const copy = { id: 'copy', syncing: false, title: 'Work 2' } satisfies BookmarkNode;

  it('takes the window to the copy, as it would to a new space', async () => {
    const { handlers, windowSpaces } = installBrowser([]);
    vi.mocked(duplicateSpace).mockResolvedValue(copy);

    await expect(handlers.duplicateSpace!.run({ spaceId: 'work', withTabs: true }, client)).resolves.toBe(copy);

    expect(duplicateSpace).toHaveBeenCalledWith({ sourceSpaceId: 'work', windowId: 3, withTabs: true });
    expect(windowSpaces.select).toHaveBeenCalledWith('copy', client);
    expect(windowSpaces.showNewSpace).toHaveBeenCalledWith('copy', client);
    expect(handlers.duplicateSpace!.targets({ spaceId: 'work', withTabs: false }, client))
      .toEqual(['space:work', 'window:3']);
  });

  it('answers the copy when a newer choice in the window wins over showing it', async () => {
    const { handlers, windowSpaces } = installBrowser([]);
    vi.mocked(duplicateSpace).mockResolvedValue(copy);
    windowSpaces.showNewSpace.mockRejectedValueOnce(new SupersededTargetError('window:3'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(handlers.duplicateSpace!.run({ spaceId: 'work', withTabs: false }, client)).resolves.toBe(copy);

    expect(error).not.toHaveBeenCalled();
  });
});
