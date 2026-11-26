import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  deriveSpaces,
  findHyperBookmarkStructure,
  shownSpaces,
  spaceBookmarkTitleWithArchived,
  tabBackingBookmarkTitle,
  tabBackingTitleInWindow,
  tabBackingWindowId,
} from './bookmarks';
import { ensureHyperBookmarkStructure, installationId, type TabBackingLocation } from './bookmarkStorage';
import { createSpaceArchive } from './spaceArchive';
import { createBookmarkTree, hyperBookmarkTree, spaceTabsFolder, type BookmarkSpec } from './testBookmarkTree';
import { testTab } from './testFixtures';
import { loadTabOwnerships, type TabOwnership } from './tabOwnership';
import { getWindowActiveSpaceId } from './windowState';

vi.mock('./bookmarkStorage', async (importOriginal) => ({
  ...await importOriginal<typeof import('./bookmarkStorage')>(),
  ensureHyperBookmarkStructure: vi.fn(),
  installationId: vi.fn(),
}));
vi.mock('./tabOwnership', async (importOriginal) => ({
  ...await importOriginal<typeof import('./tabOwnership')>(),
  loadTabOwnerships: vi.fn(),
}));
vi.mock('./windowState', async (importOriginal) => ({
  ...await importOriginal<typeof import('./windowState')>(),
  getWindowActiveSpaceId: vi.fn(),
}));

const space = (id: string, archived = false, children: BookmarkSpec[] = []): BookmarkSpec => ({
  children,
  id,
  title: archived ? spaceBookmarkTitleWithArchived({ title: id }, true) : id,
});

/**
 * Spaces `work`, `home` and `play`, with `old` archived between them, and two
 * windows: window 3 shows `work` with its two tabs, window 4 shows `home`.
 */
function installBrowser() {
  const tree = createBookmarkTree(hyperBookmarkTree([
    space('work', false, [spaceTabsFolder('work', ['a', 'b'].map((id) => ({
      id,
      title: tabBackingTitleInWindow(tabBackingBookmarkTitle(`Page ${id}`), 3, 'install'),
      url: `https://example.test/${id}`,
    })), 'work-tabs')]),
    space('old', true),
    space('home'),
    space('play'),
  ])[0]!);
  const tabs = [
    testTab({ active: true, id: 10, index: 0, url: 'https://example.test/a', windowId: 3 }),
    testTab({ id: 11, index: 1, url: 'https://example.test/b', windowId: 3 }),
    testTab({ id: 12, index: 2, pinned: true, url: 'https://example.test/pinned', windowId: 3 }),
    testTab({ active: true, id: 20, index: 0, url: 'https://example.test/h', windowId: 4 }),
  ];
  const ownerships: Record<number, TabOwnership> = {
    10: { backingId: 'a', backingToken: 'ta', spaceId: 'work', url: 'https://example.test/a', windowId: 3 },
    11: { backingId: 'b', backingToken: 'tb', spaceId: 'work', url: 'https://example.test/b', windowId: 3 },
    12: { spaceId: 'work', windowId: 3 },
    20: { spaceId: 'home', windowId: 4 },
  };
  const shown: Record<number, string> = { 3: 'work', 4: 'home' };
  vi.stubGlobal('browser', {
    bookmarks: tree.api,
    tabs: { query: vi.fn(async () => tabs.map((tab) => ({ ...tab }))) },
    windows: {
      getAll: vi.fn(async () => [3, 4].map((id) => ({ id, incognito: false, type: 'normal' }))),
    },
  });
  vi.mocked(ensureHyperBookmarkStructure).mockImplementation(async () =>
    findHyperBookmarkStructure(await tree.api.getTree())!);
  vi.mocked(installationId).mockResolvedValue('install');
  vi.mocked(getWindowActiveSpaceId).mockImplementation(async (windowId) => shown[windowId]);
  vi.mocked(loadTabOwnerships).mockImplementation(async () => ({ ...ownerships }));

  const tabBackingLocations = new Map<number, TabBackingLocation>([
    [10, { backingId: 'a', backingToken: 'ta', spaceId: 'work', url: 'https://example.test/a', windowId: 3 }],
  ]);
  const windowSpaces = {
    select: vi.fn(),
    switchTo: vi.fn(async (spaceId: string, client: { windowId: number }) => {
      shown[client.windowId] = spaceId;
    }),
  };
  const dependencies = {
    closeTabs: vi.fn(async () => undefined),
    persistTabOwnership: vi.fn(async (tabId: number, ownership: TabOwnership) => {
      ownerships[tabId] = ownership;
    }),
    queueMutation: <Result,>(operation: () => Promise<Result>) => operation(),
    tabBackingLocations,
    windowSpaces: () => windowSpaces,
  };
  const archive = createSpaceArchive(dependencies);
  const spaces = async () => deriveSpaces(await tree.api.getTree());
  const order = async () => (await spaces()).map((entry) => `${entry.archived ? '~' : ''}${entry.id}`);
  return { archive, dependencies, order, ownerships, shown, spaces, tabBackingLocations, tree, windowSpaces };
}

describe('space archive', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it('moves windows off an archived space and parks its tabs for its return', async () => {
    const browser = installBrowser();
    expect(tabBackingWindowId(browser.tree.node('a'))).toBe(3);

    await browser.archive.setSpaceArchived({ archived: true, spaceId: 'work' });

    expect(await browser.order()).toEqual(['~old', 'home', 'play', '~work']);
    // Only the window showing it leaves, for the next shown space.
    expect(browser.windowSpaces.switchTo).toHaveBeenCalledTimes(1);
    expect(browser.shown).toEqual({ 3: 'home', 4: 'home' });
    // Its unpinned tabs close, having let go of their backings, which stay and forget their window.
    expect(browser.dependencies.closeTabs).toHaveBeenCalledWith([10, 11]);
    expect(browser.ownerships[10]).toEqual({ spaceId: 'work', windowId: 3 });
    expect(browser.tabBackingLocations.has(10)).toBe(false);
    expect(browser.tree.children('work-tabs').map((node) => [node.id, tabBackingWindowId(node)]))
      .toEqual([['a', undefined], ['b', undefined]]);
  });

  it('places an archived space before the one it is dropped on', async () => {
    const browser = installBrowser();

    await browser.archive.setSpaceArchived({ archived: true, beforeSpaceId: 'old', spaceId: 'play' });
    expect(await browser.order()).toEqual(['work', '~play', '~old', 'home']);

    await browser.archive.setSpaceArchived({ archived: true, beforeSpaceId: 'play', spaceId: 'old' });
    expect(await browser.order()).toEqual(['work', '~old', '~play', 'home']);
  });

  it('returns a space to pagination where it is dropped, without switching to it', async () => {
    const browser = installBrowser();

    await browser.archive.setSpaceArchived({ archived: false, beforeSpaceId: 'work', spaceId: 'old' });

    expect(await browser.order()).toEqual(['old', 'work', 'home', 'play']);
    expect(browser.windowSpaces.switchTo).not.toHaveBeenCalled();
    expect(browser.tree.node('old').title).toBe('old');
  });

  it('keeps the last shown space in pagination', async () => {
    const browser = installBrowser();
    await browser.archive.setSpaceArchived({ archived: true, spaceId: 'home' });
    await browser.archive.setSpaceArchived({ archived: true, spaceId: 'play' });

    await expect(browser.archive.setSpaceArchived({ archived: true, spaceId: 'work' }))
      .rejects.toThrow('At least one space must stay unarchived.');
    expect(shownSpaces(await browser.spaces()).map((entry) => entry.id)).toEqual(['work']);
  });
});
