import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  adoptParkedTabBackings,
  createTabFolder,
  ensureHyperBookmarkStructure,
  ensureTabBackingBookmark,
  gatherSplitViewFolder,
  hasParkedTabBackings,
  localTabBackingPagesByWindow,
  migrateLegacyPreferences,
  migrateTabBackingWindowIds,
  moveTabTreeNode,
  moveTabTreeNodes,
  reconcileTabBackingFolders,
  removeProvisionalBookmarkFolder,
  removeTabFolder,
  renameTabBackingBookmark,
  renameTabFolder,
  removeTabBackingBookmark,
  saveHyperPreferences,
  windowTabBackings,
  bookmarkById,
} from './bookmarkStorage';
import { preferencesFromHyperRoot } from './preferences';
import {
  serializeBookmarkTitle,
  bookmarkTitleWithCustomName,
  isSpaceBookmarksFolder,
  isTabFolder,
  tabBackingBookmarkTitle,
  tabBackingInstallationId,
  tabBackingSpaceId,
  tabBackingTitleWithBookmarkLink,
  tabBackingToken,
  tabBackingWindowId,
  visibleBookmarkTitle,
} from './bookmarks';
import { createBookmarkTree, type BookmarkSpec, type BookmarkTree } from './testBookmarkTree';
import { fakeStorageArea, testTab } from './testFixtures';

function tab(
  id: number,
  url: string,
  index: number,
  windowId = 1,
): Browser.tabs.Tab {
  return testTab({
    id,
    url,
    title: `Tab ${id}`,
    index,
    windowId,
  });
}

const backTab = (spaceId: string, ...args: Parameters<typeof tab>) =>
  ensureTabBackingBookmark(tab(...args), spaceId);
const create = (parentId: string, title: string, url?: string) =>
  browser.bookmarks.create({ parentId, title, url });
const legacyWindowFolder = (parentId: string, windowId: number, installationId: string) =>
  create(parentId, serializeBookmarkTitle(String(windowId), { hyper: { installationId, windowId } }));
const parentOf = async (id: string) => (await bookmarkById(id))?.parentId;
const ids = (nodes: Browser.bookmarks.BookmarkTreeNode[]) => nodes.map((node) => node.id);

let bookmarkTree: BookmarkTree;
const nodeOf = (id: string) => bookmarkTree.node(id);

function installBookmarkMock(localValues: Record<string, unknown> = {}) {
  const openWindows = new Set(Array.from({ length: 20 }, (_, index) => index + 1));
  const liveTabs: Browser.tabs.Tab[] = [];
  const local = fakeStorageArea(localValues);
  const folderSpec = (id: string, title: string, children: BookmarkSpec[] = []): BookmarkSpec =>
    ({ id, title, children });
  const tree = bookmarkTree = createBookmarkTree(folderSpec('root', '', [
    folderSpec('1', 'Bookmarks bar', [folderSpec('hyper', 'hyper', [
      folderSpec('favourites', 'favourites'),
      folderSpec('bookmarks', 'bookmarks'),
      folderSpec('spaces', 'spaces', [folderSpec('green', 'Green'), folderSpec('blue', 'Blue'), folderSpec('space', 'Space')]),
    ])]),
  ]));
  const { children } = tree;
  const folder = (parentId: string, title: string) => children(parentId).find(
    (node) => !node.url && visibleBookmarkTitle(node) === title,
  );
  const windowChildren = (spaceId: string, windowId: number) => {
    const tabs = folder(spaceId, 'tabs');
    const collect = (parentId: string): Browser.bookmarks.BookmarkTreeNode[] =>
      children(parentId).flatMap((node) => {
        if (node.url) return [node];
        return isTabFolder(node) ? collect(node.id) : [];
      });
    return tabs
      ? collect(tabs.id).filter((node) => tabBackingWindowId(node) === windowId)
      : [];
  };
  vi.stubGlobal('browser', {
    runtime: { getURL: () => 'chrome-extension://hyper/' },
    windows: { getAll: async () => [...openWindows].map((id) => ({ id })) },
    tabs: { query: async () => liveTabs },
    storage: { local },
    bookmarks: tree.api,
  });
  const localStorage = () => Object.fromEntries(local.values);
  return { ...tree, folder, liveTabs, localStorage, openWindows, windowChildren };
}

afterEach(() => vi.unstubAllGlobals());

describe('tab backing storage', () => {
  it('keeps global bookmarks in the hyper bookmarks folder', async () => {
    const { children } = installBookmarkMock();
    const saved = await create('bookmarks', 'Reading list');

    await ensureHyperBookmarkStructure();

    expect(ids(children('hyper'))).toContain('bookmarks');
    expect(ids(children('bookmarks'))).toEqual([saved.id]);
    expect(children('spaces').map((node) => node.title)).toEqual(['Green', 'Blue', 'Space']);
  });

  it('creates the global bookmarks folder when it is missing', async () => {
    const { children } = installBookmarkMock();
    await browser.bookmarks.remove('bookmarks');

    const structure = await ensureHyperBookmarkStructure();

    const global = children('hyper').filter((node) => !node.url && node.title === 'bookmarks');
    expect(global).toHaveLength(1);
    expect(structure.bookmarks?.id).toBe(global[0]!.id);
  });

  it('moves favourites with no slot left on the bar into the global bookmarks', async () => {
    const { children } = installBookmarkMock();
    const favourite = (title: string, slot: number) =>
      create('favourites', `${title} {"hyper":{"favouriteSlot":${slot}}}`, `https://${title}.example.com`);
    const kept = await favourite('kept', 0);
    const last = await favourite('last', 7);

    await ensureHyperBookmarkStructure();

    expect(ids(children('favourites'))).toEqual([kept.id]);
    expect(ids(children('bookmarks'))).toEqual([last.id]);
    expect((await bookmarkById(last.id))!.title).toBe('last');
  });

  it('isolates the same native window and URL under each owning space', async () => {
    const { windowChildren } = installBookmarkMock();
    const green = await backTab('green', 1, 'https://example.com', 0, 7);
    const blue = await backTab('blue', 2, 'https://example.com', 1, 7);

    expect(green?.backingId).not.toBe(blue?.backingId);
    expect(ids(windowChildren('green', 7))).toEqual([green?.backingId]);
    expect(ids(windowChildren('blue', 7))).toEqual([blue?.backingId]);
  });

  it('does not let an inherited exact ID or token share a claimed backing', async () => {
    const { windowChildren } = installBookmarkMock();
    const source = await backTab('green', 1, 'https://example.com', 0, 7);
    const duplicate = await ensureTabBackingBookmark(
      tab(2, 'https://example.com', 1, 7),
      'green',
      source,
      new Set([source!.backingId]),
    );

    expect(duplicate?.backingId).not.toBe(source?.backingId);
    expect(duplicate?.backingToken).not.toBe(source?.backingToken);
    expect(new Set(windowChildren('green', 7).map(tabBackingToken)).size).toBe(2);
  });

  it('retokens an unclaimed exact backing when another live tab claims its token', async () => {
    installBookmarkMock();
    const sleeping = await backTab('green', 1, 'https://example.com', 0, 7);
    const restored = await ensureTabBackingBookmark(
      tab(2, 'https://example.com', 1, 7),
      'green',
      sleeping,
      new Set(),
      new Set([sleeping!.backingToken]),
    );

    expect(restored?.backingId).toBe(sleeping?.backingId);
    expect(restored?.backingToken).not.toBe(sleeping?.backingToken);
  });

  it('marks existing space roots without relocating their children', async () => {
    const { children, folder } = installBookmarkMock();
    const visibleBookmark = await create('green', 'Visible bookmark', 'https://visible.example.com');
    const visibleFolder = await create('green', 'Reading');
    const nestedBookmark = await create(visibleFolder.id, 'Nested bookmark', 'https://nested.example.com');
    const manualBookmarksRoot = await create('green', 'bookmarks');
    const manuallyMovedBookmark = await create(manualBookmarksRoot.id, 'Already moved', 'https://already-moved.example.com');
    const directBacking = await browser.bookmarks.create({
      parentId: 'green',
      title: tabBackingBookmarkTitle(
        'Filtered pull requests',
        2,
        'direct-token',
      ),
      url: 'https://github.com/example/project/pulls?q=is%3Aopen',
    });

    await ensureHyperBookmarkStructure();
    await ensureHyperBookmarkStructure();

    const bookmarks = folder('green', 'bookmarks')!;
    expect(folder('green', 'tabs')).toBeDefined();
    expect(bookmarks.id).toBe(manualBookmarksRoot.id);
    expect(isSpaceBookmarksFolder(bookmarks)).toBe(true);
    expect(await parentOf(manuallyMovedBookmark.id)).toBe(manualBookmarksRoot.id);
    expect(await parentOf(directBacking.id)).toBe('green');
    expect(await parentOf(visibleBookmark.id)).toBe('green');
    expect(await parentOf(visibleFolder.id)).toBe('green');
    expect(await parentOf(nestedBookmark.id)).toBe(visibleFolder.id);
    expect(ids(children(bookmarks.id))).toEqual([manuallyMovedBookmark.id]);
  });

  it('preserves a child inserted while duplicate global bookmark folders merge', async () => {
    const { children } = installBookmarkMock();
    const duplicate = await create('hyper', 'bookmarks');
    const moving = await create(duplicate.id, 'Moving bookmark', 'https://moving.example.com');
    const move = browser.bookmarks.move;
    let insertedId: string | undefined;
    browser.bookmarks.move = vi.fn(async (id: string, destination: { parentId?: string }) => {
      const moved = await move(id, destination);
      if (id === moving.id) {
        const inserted = await create(duplicate.id, 'Arrived during merge', 'https://arrived.example.com');
        insertedId = inserted.id;
      }
      return moved;
    });

    await ensureHyperBookmarkStructure();

    expect(ids(children(duplicate.id))).toEqual([insertedId]);
    expect(ids(children('hyper'))).toContain(duplicate.id);
  });

  it('preserves empty and populated unmarked root folders named tabs', async () => {
    const { children } = installBookmarkMock();
    const empty = await create('hyper', 'tabs');
    const populated = await create('hyper', 'tabs');
    const userBookmark = await create(populated.id, 'Saved page', 'https://saved.example.com');

    await ensureHyperBookmarkStructure();

    expect(ids(children('hyper'))).toContain(empty.id);
    expect(ids(children(populated.id))).toEqual([userBookmark.id]);
  });

  it('preserves root records that cannot be assigned to a space', async () => {
    const { children } = installBookmarkMock();
    const strayRoot = await create('hyper', 'tabs');
    const strayWindow = await legacyWindowFolder(strayRoot.id, 7, 'other-installation');
    const unplaced = await create(strayWindow.id, tabBackingBookmarkTitle('Unplaced tab', 0, 'unplaced-token'), 'https://unplaced.example.com');

    await ensureHyperBookmarkStructure();

    expect(ids(children(strayWindow.id))).toEqual([unplaced.id]);
    expect(children('hyper').some((node) => node.id === strayRoot.id)).toBe(true);
  });

  it('removes empty metadata suffixes from existing Hyper bookmarks at startup', async () => {
    installBookmarkMock();
    const emptyFolder = await create('bookmarks', 'Reading {"hyper":{}}');
    const emptyBookmark = await create(emptyFolder.id, 'Article {}', 'https://article.example.com');
    const meaningful = await create('bookmarks', 'Pinned {"hyper":{"spaceId":"green"}}', 'https://pinned.example.com');
    const malformed = await create('bookmarks', 'Literal {not-json}', 'https://literal.example.com');
    const outsideHyper = await create('1', 'Outside {}', 'https://outside.example.com');

    await ensureHyperBookmarkStructure();

    const titles = await Promise.all([emptyFolder, emptyBookmark, meaningful, malformed, outsideHyper]
      .map(async (node) => (await bookmarkById(node.id))?.title));
    expect(titles).toEqual([
      'Reading', 'Article', 'Pinned {"hyper":{"spaceId":"green"}}', 'Literal {not-json}', 'Outside {}',
    ]);
  });

  it('does not create a window folder while only reading backings', async () => {
    const { children, folder } = installBookmarkMock();
    await ensureHyperBookmarkStructure();
    const tabs = folder('green', 'tabs')!;

    await expect(windowTabBackings('green', 99)).resolves.toEqual([]);
    expect(children(tabs.id)).toEqual([]);
  });

  it('keeps duplicate URLs distinct and updates or removes only the exact tab record', async () => {
    const { windowChildren } = installBookmarkMock();
    const first = await backTab('space', 1, 'https://example.com', 0);
    expect(first).toBeDefined();
    const second = await ensureTabBackingBookmark(
      tab(2, 'https://example.com', 1),
      'space',
      undefined,
      new Set([first!.backingId]),
    );

    expect(second?.backingId).not.toBe(first?.backingId);
    expect(windowChildren('space', 1)).toHaveLength(2);

    const navigated = await ensureTabBackingBookmark(tab(1, 'https://example.com/next', 0), 'space', first);
    expect(navigated?.backingId).toBe(first?.backingId);
    expect(windowChildren('space', 1)).toHaveLength(2);
    expect(windowChildren('space', 1).find((node) => node.id === first?.backingId)?.url)
      .toBe('https://example.com/next');

    await removeTabBackingBookmark(navigated);
    expect(ids(windowChildren('space', 1))).toEqual([second?.backingId]);
  });

  it('stores tabs directly under the space tabs root with leaf ownership', async () => {
    const { folder, windowChildren } = installBookmarkMock();
    const first = await backTab('green', 1, 'https://example.com', 0, 1);
    const second = await backTab('green', 2, 'https://example.com', 0, 2);

    expect(first?.windowId).toBe(1);
    expect(second?.windowId).toBe(2);
    expect(windowChildren('green', 1)).toHaveLength(1);
    expect(windowChildren('green', 2)).toHaveLength(1);
    expect(tabBackingSpaceId(windowChildren('green', 1)[0]!)).toBe('green');
    expect(tabBackingSpaceId(windowChildren('green', 2)[0]!)).toBe('green');
    const tabs = folder('green', 'tabs')!;
    expect(await parentOf(first!.backingId)).toBe(tabs.id);
    expect(await parentOf(second!.backingId)).toBe(tabs.id);
    expect(tabBackingInstallationId(windowChildren('green', 1)[0]!)).toBeTruthy();
  });

  it('shares a marked user folder across windows and filters leaves by metadata', async () => {
    const { folder } = installBookmarkMock();
    const first = await backTab('green', 1, 'https://one.example.com', 0, 1);
    const second = await backTab('green', 2, 'https://two.example.com', 0, 2);
    const shared = await createTabFolder('green', undefined, 'Shared work');
    await browser.bookmarks.move(first!.backingId, { parentId: shared.id });
    await browser.bookmarks.move(second!.backingId, { parentId: shared.id });

    expect(shared.parentId).toBe(folder('green', 'tabs')!.id);
    expect(isTabFolder(shared)).toBe(true);
    expect(ids(await windowTabBackings('green', 1))).toEqual([first!.backingId]);
    expect(ids(await windowTabBackings('green', 2))).toEqual([second!.backingId]);
  });

  it('preserves a same-space exact backing inside its marked user folder', async () => {
    installBookmarkMock();
    const location = await backTab('green', 1, 'https://example.com', 0, 7);
    const parent = await createTabFolder('green', undefined, 'In progress');
    await browser.bookmarks.move(location!.backingId, { parentId: parent.id });

    const refreshed = await ensureTabBackingBookmark(tab(1, 'https://example.com/updated', 3, 7), 'green', location);

    expect(refreshed?.backingId).toBe(location?.backingId);
    expect(await parentOf(location!.backingId)).toBe(parent.id);
  });

  it('preserves foreign legacy window folders under a space tabs container', async () => {
    const { children, folder } = installBookmarkMock();
    await browser.storage.local.set({ hyperInstallationId: 'local-installation' });
    await ensureHyperBookmarkStructure();
    const tabs = folder('green', 'tabs')!;
    const foreignWindow = await legacyWindowFolder(tabs.id, 7, 'foreign-installation');
    const foreignBacking = await create(foreignWindow.id, tabBackingBookmarkTitle('Foreign', 0, 'foreign', 'green'), 'https://foreign.example.com');

    await ensureHyperBookmarkStructure();

    expect(ids(children(foreignWindow.id))).toEqual([foreignBacking.id]);
  });

  it('renames and removes only empty canonical marked folders', async () => {
    installBookmarkMock();
    const parent = await createTabFolder('green', undefined, 'Parent');
    const child = await createTabFolder('green', parent.id, 'Child');

    const renamed = await renameTabFolder(child.id, 'Renamed');
    expect(visibleBookmarkTitle(renamed)).toBe('Renamed');
    expect(isTabFolder(renamed)).toBe(true);
    await removeTabFolder(child.id);
    expect(bookmarkTree.has(child.id)).toBe(false);
  });

  it('removes a tab folder from the bin with its tabs here, keeping what it held elsewhere', async () => {
    const { children, folder, liveTabs } = installBookmarkMock();
    // Tabs 1, 2 and 4 are in window 7; tab 3 is in window 8.
    liveTabs.push(
      tab(1, 'https://one.test', 0, 7),
      tab(2, 'https://two.test', 1, 7),
      tab(3, 'https://three.test', 0, 8),
      tab(4, 'https://four.test', 2, 7),
    );
    const backings = new Map<number, string>();
    for (const liveTab of liveTabs) {
      backings.set(liveTab.id!, (await ensureTabBackingBookmark(liveTab, 'green'))!.backingId);
    }
    const reading = await createTabFolder('green', undefined, 'Reading');
    const inner = await createTabFolder('green', reading.id, 'Inner');
    await browser.bookmarks.move(backings.get(1)!, { parentId: reading.id });
    await browser.bookmarks.move(backings.get(2)!, { parentId: inner.id });
    await browser.bookmarks.move(backings.get(3)!, { parentId: reading.id });
    const ownerships = Object.fromEntries([...backings].map(([tabId, backingId]) =>
      [`tabSpaceId:${tabId}`, { backingId, spaceId: 'green' }]));
    const closed: number[] = [];
    Object.assign(browser.storage, { session: fakeStorageArea(ownerships) });
    Object.assign(browser.tabs, {
      get: async (tabId: number) => liveTabs.find((liveTab) => liveTab.id === tabId) ??
        Promise.reject(new Error('No tab')),
      query: async ({ windowId }: { windowId?: number }) =>
        liveTabs.filter((liveTab) => windowId === undefined || liveTab.windowId === windowId),
      remove: async (tabId: number) => {
        closed.push(tabId);
        liveTabs.splice(liveTabs.findIndex((liveTab) => liveTab.id === tabId), 1);
      },
    });
    const tabsRootId = folder('green', 'tabs')!.id;
    const readingIndex = (await bookmarkById(reading.id))!.index;

    await expect(removeTabFolder(reading.id)).rejects.toThrow('Only empty tab folders can be removed.');
    await removeTabFolder(reading.id, 7);

    expect(closed.sort()).toEqual([1, 2]);
    for (const id of [reading.id, inner.id, backings.get(1)!, backings.get(2)!]) {
      expect(bookmarkTree.has(id)).toBe(false);
    }
    // Window 8's tab stays open, its record where the folder was.
    expect(children(tabsRootId).find((node) => node.id === backings.get(3))?.index).toBe(readingIndex);
    expect(ids(children(tabsRootId))).toContain(backings.get(4));
  });

  it('removes only unchanged empty provisional bookmark folders', async () => {
    installBookmarkMock();
    const empty = await create('bookmarks', 'New folder');
    const renamed = await create('bookmarks', 'Renamed');
    const populated = await create('bookmarks', 'New folder');
    await create(populated.id, 'Child');

    await expect(removeProvisionalBookmarkFolder(empty.id, 'New folder'))
      .resolves.toBe(true);
    await expect(removeProvisionalBookmarkFolder(renamed.id, 'New folder'))
      .resolves.toBe(false);
    await expect(removeProvisionalBookmarkFolder(populated.id, 'New folder'))
      .resolves.toBe(false);

    expect(bookmarkTree.has(empty.id)).toBe(false);
    expect(bookmarkTree.has(renamed.id)).toBe(true);
    expect(bookmarkTree.has(populated.id)).toBe(true);
    expect(browser.bookmarks.removeTree).not.toHaveBeenCalled();
  });

  it('moves a local backing into a marked folder without changing its identity', async () => {
    installBookmarkMock();
    const location = await backTab('green', 1, 'https://example.com', 0, 7);
    const target = await createTabFolder('green', undefined, 'Target');
    const before = (await bookmarkById(location!.backingId))!;

    const moved = await moveTabTreeNode('green', before.id, { parentId: target.id });

    expect(moved.id).toBe(before.id);
    expect(moved.title).toBe(before.title);
    expect(moved.parentId).toBe(target.id);
  });

  it('reorders marked folders within the same tab tree', async () => {
    const { children, folder } = installBookmarkMock();
    const first = await createTabFolder('green', undefined, 'First');
    const second = await createTabFolder('green', undefined, 'Second');
    const tabs = folder('green', 'tabs')!;

    await moveTabTreeNode('green', second.id, { parentId: tabs.id, index: 0 });

    expect(children(tabs.id).slice(0, 2).map((node) => node.id)).toEqual([
      second.id,
      first.id,
    ]);
  });

  it('rejects foreign, cross-space, and unmarked tab tree moves', async () => {
    const { folder } = installBookmarkMock();
    await browser.storage.local.set({ hyperInstallationId: 'local-installation' });
    await ensureHyperBookmarkStructure();
    const greenTabs = folder('green', 'tabs')!;
    const blueTabs = folder('blue', 'tabs')!;
    const local = await backTab('green', 1, 'https://local.example.com', 0);
    const foreign = await browser.bookmarks.create({
      parentId: greenTabs.id,
      title: tabBackingBookmarkTitle(
        'Foreign',
        1,
        'foreign-token',
        'green',
        undefined,
        { windowId: 2, installationId: 'foreign-installation' },
      ),
      url: 'https://foreign.example.com',
    });
    const ordinaryFolder = await create(greenTabs.id, 'Ordinary');

    await expect(moveTabTreeNode('green', foreign.id, { parentId: greenTabs.id }))
      .rejects.toThrow('cannot be moved');
    await expect(moveTabTreeNode('blue', local!.backingId, { parentId: blueTabs.id }))
      .rejects.toThrow('cannot be moved');
    await expect(moveTabTreeNode('green', local!.backingId, { parentId: blueTabs.id }))
      .rejects.toThrow('destination is unavailable');
    await expect(moveTabTreeNode('green', local!.backingId, { parentId: ordinaryFolder.id }))
      .rejects.toThrow('destination is unavailable');
  });

  it('rejects moving a marked folder into its descendant', async () => {
    installBookmarkMock();
    const parent = await createTabFolder('green', undefined, 'Parent');
    const child = await createTabFolder('green', parent.id, 'Child');

    await expect(moveTabTreeNode('green', parent.id, { parentId: child.id }))
      .rejects.toThrow('descendant');
  });

  it('moves several nodes in order into one destination', async () => {
    const { children } = installBookmarkMock();
    const first = await backTab('green', 1, 'https://one.example.com', 0, 1);
    const second = await backTab('green', 2, 'https://two.example.com', 1, 1);
    const folder = await createTabFolder('green', undefined, 'Folder');
    const existing = await backTab('green', 3, 'https://three.example.com', 2, 1);
    await moveTabTreeNode('green', existing!.backingId, { parentId: folder.id });

    await moveTabTreeNodes('green', [second!.backingId, first!.backingId], {
      parentId: folder.id,
      index: 0,
    });

    expect(ids(children(folder.id))).toEqual([
      second!.backingId,
      first!.backingId,
      existing!.backingId,
    ]);
  });

  it('creates a link\'s backing just after the tab it follows, past a split view it is in', async () => {
    const { children } = installBookmarkMock();
    const first = await backTab('green', 1, 'https://one.example.com', 0, 1);
    const second = await backTab('green', 2, 'https://two.example.com', 1, 1);
    const tabsRoot = (await parentOf(first!.backingId))!;

    const link = await ensureTabBackingBookmark(
      tab(3, 'https://link.example.com', 1, 1),
      'green',
      undefined,
      new Set(),
      new Set(),
      async () => ({ after: first!.backingId }),
    );
    expect(ids(children(tabsRoot))).toEqual([first!.backingId, link!.backingId, second!.backingId]);

    const split = await gatherSplitViewFolder('green', [first!.backingId, link!.backingId]);
    const splitLink = await ensureTabBackingBookmark(
      tab(4, 'https://split-link.example.com', 2, 1),
      'green',
      undefined,
      new Set(),
      new Set(),
      async () => ({ after: link!.backingId }),
    );
    expect(ids(children(tabsRoot))).toEqual([split.id, splitLink!.backingId, second!.backingId]);
  });

  it('creates a backing between its tab\'s neighbours, in the deepest folder holding both', async () => {
    const { children } = installBookmarkMock();
    const first = await backTab('green', 1, 'https://one.example.com', 0, 1);
    const last = await backTab('green', 2, 'https://two.example.com', 1, 1);
    const tabsRoot = (await parentOf(first!.backingId))!;
    const work = await createTabFolder('green', undefined, 'Work');
    const inner = await createTabFolder('green', work.id, 'Inner');
    await moveTabTreeNode('green', first!.backingId, { parentId: work.id, index: 0 });
    await moveTabTreeNode('green', last!.backingId, { parentId: inner.id });
    const createBetween = (tabId: number, previous: string | undefined, next: string) =>
      ensureTabBackingBookmark(
        tab(tabId, `https://${tabId}.example.com`, 0, 1),
        'green',
        undefined,
        new Set(),
        new Set(),
        async () => previous ? { previous, next } : { next },
      );

    const between = await createBetween(3, first!.backingId, last!.backingId);
    expect(ids(children(work.id))).toEqual([first!.backingId, between!.backingId, inner.id]);

    // With no backed tab before it, a tab joins no folder.
    const leading = await createBetween(4, undefined, first!.backingId);
    expect(ids(children(tabsRoot))).toEqual([leading!.backingId, work.id]);
  });

  it('preserves an exact backing custom name while refreshing tab metadata', async () => {
    const { windowChildren } = installBookmarkMock();
    const location = await backTab('green', 1, 'https://example.com', 0, 1);
    const backing = windowChildren('green', 1)[0]!;
    await browser.bookmarks.update(backing.id, {
      title: bookmarkTitleWithCustomName(backing, 'My working title'),
    });

    await ensureTabBackingBookmark(
      { ...tab(1, 'https://example.com', 4, 1), title: 'Changed browser title' },
      'blue',
      location,
    );

    const updated = windowChildren('blue', 1)[0]!;
    expect(visibleBookmarkTitle(updated)).toBe('My working title');
    expect(tabBackingSpaceId(updated)).toBe('blue');
    expect(updated.title).toContain('"tabIndex":4');
    expect(updated.title).toContain('"isCustomName":true');
  });

  it('drops a tab name and bookmark link once the tab moves to another site', async () => {
    const { windowChildren } = installBookmarkMock();
    const location = await backTab('green', 1, 'https://example.com/a', 0);
    const backing = windowChildren('green', 1)[0]!;
    await browser.bookmarks.update(backing.id, {
      title: tabBackingTitleWithBookmarkLink(
        bookmarkTitleWithCustomName(backing, 'Mine'),
        { linkedBookmarkId: 'docs' },
      ),
    });

    await ensureTabBackingBookmark({ ...tab(1, 'https://example.com/b', 0), title: 'Same site' }, 'green', location);
    expect(visibleBookmarkTitle(windowChildren('green', 1)[0]!)).toBe('Mine');

    await ensureTabBackingBookmark({ ...tab(1, 'https://elsewhere.test/', 0), title: 'Elsewhere' }, 'green', location);
    const moved = windowChildren('green', 1)[0]!;
    expect(visibleBookmarkTitle(moved)).toBe('Elsewhere');
    expect(moved.title).not.toContain('isCustomName');
    expect(moved.title).not.toContain('linkedBookmarkId');
  });

  it('renames only the requested exact backing and preserves its metadata', async () => {
    const { windowChildren } = installBookmarkMock();
    const first = await backTab('green', 1, 'https://example.com', 0);
    const second = await ensureTabBackingBookmark(
      tab(2, 'https://example.com', 1),
      'green',
      undefined,
      new Set([first!.backingId]),
    );

    await renameTabBackingBookmark(first!.backingId, 'Exact custom title', first!);

    const records = windowChildren('green', 1);
    expect(visibleBookmarkTitle(records.find((node) => node.id === first!.backingId)!))
      .toBe('Exact custom title');
    expect(records.find((node) => node.id === first!.backingId)?.title)
      .toContain('"isCustomName":true');
    expect(visibleBookmarkTitle(records.find((node) => node.id === second!.backingId)!))
      .toBe('Tab 2');
  });

  it('returns a renamed backing to its page title when the name is cleared', async () => {
    const { windowChildren } = installBookmarkMock();
    const location = await backTab('green', 1, 'https://example.com', 0);
    await renameTabBackingBookmark(location!.backingId, 'Mine', location!);
    // The tab strip shows the name, which must not replace the page title kept beside it.
    await ensureTabBackingBookmark({ ...tab(1, 'https://example.com', 0), title: 'Mine' }, 'green', location);

    await renameTabBackingBookmark(location!.backingId, '', location!);

    const restored = windowChildren('green', 1)[0]!;
    expect(visibleBookmarkTitle(restored)).toBe('Tab 1');
    expect(restored.title).not.toContain('isCustomName');
  });

  it('keeps the last known page title while the browser shows only a placeholder', async () => {
    const { windowChildren } = installBookmarkMock();
    const url = 'https://example.com/docs';
    const location = await ensureTabBackingBookmark({ ...tab(1, url, 0), title: 'Docs' }, 'green');

    for (const title of ['example.com', 'example.com/docs', url, '']) {
      await ensureTabBackingBookmark({ ...tab(1, url, 0), title }, 'green', location);
      expect(visibleBookmarkTitle(windowChildren('green', 1)[0]!)).toBe('Docs');
    }

    // A placeholder on another page is all there is to know about that page.
    await ensureTabBackingBookmark({ ...tab(1, 'https://example.com/other', 0), title: 'example.com' }, 'green', location);
    expect(visibleBookmarkTitle(windowChildren('green', 1)[0]!)).toBe('example.com');
  });

  it('rejects a missing or non-backing bookmark ID', async () => {
    installBookmarkMock();
    await expect(renameTabBackingBookmark('missing', 'Name'))
      .rejects.toThrow('backing no longer exists');
  });

  it('moves an exact backing across spaces into the target tabs root', async () => {
    const { folder, windowChildren } = installBookmarkMock();
    const previous = await backTab('green', 1, 'https://example.com', 0, 1);
    const migrated = await ensureTabBackingBookmark(tab(1, 'https://example.com', 0, 2), 'blue', previous);

    expect(migrated?.backingId).toBe(previous?.backingId);
    expect(windowChildren('green', 1)).toHaveLength(0);
    expect(ids(windowChildren('blue', 2))).toEqual([previous?.backingId]);
    expect(tabBackingSpaceId(windowChildren('blue', 2)[0]!)).toBe('blue');
    expect(await parentOf(previous!.backingId)).toBe(folder('blue', 'tabs')!.id);
  });

  it('parks local closed-window records while preserving legacy backings', async () => {
    const { children, folder, windowChildren } = installBookmarkMock();
    const stale = await backTab('green', 1, 'https://stale.example.com', 0, 1);
    const current = await backTab('green', 2, 'https://current.example.com', 0, 2);
    const parked = await backTab('green', 3, 'https://parked.example.com', 1, 1);
    const hyper = folder('1', 'hyper')!;
    const spaces = folder(hyper.id, 'spaces')!;
    await browser.bookmarks.move(stale!.backingId, {
      parentId: children(spaces.id)[0]!.id,
    });

    await reconcileTabBackingFolders(new Set([2]), new Set([current!.backingId]));

    expect(windowChildren('green', 1)).toHaveLength(0);
    expect(ids(windowChildren('green', 2))).toEqual([current?.backingId]);
    expect(bookmarkTree.has(stale!.backingId)).toBe(true);
    const parkedNode = nodeOf(parked!.backingId);
    expect(tabBackingWindowId(parkedNode!)).toBeUndefined();
    await expect(hasParkedTabBackings('green')).resolves.toBe(true);
  });

  it('preserves a protected backing under a no-longer-open window ID', async () => {
    const { windowChildren } = installBookmarkMock();
    const protectedBacking = await backTab('green', 1, 'https://protected.example.com', 0, 1);

    await reconcileTabBackingFolders(new Set([2]), new Set([protectedBacking!.backingId]));

    expect(ids(windowChildren('green', 1))).toEqual([protectedBacking?.backingId]);
  });

  it('migrates every local inactive-space backing to its restored window', async () => {
    const { windowChildren } = installBookmarkMock();
    const green = await backTab('green', 1, 'https://green.example.com', 0, 7);
    const blue = await backTab('blue', 2, 'https://blue.example.com', 0, 7);
    const untouched = await backTab('green', 3, 'https://untouched.example.com', 0, 8);

    await expect(migrateTabBackingWindowIds(new Map([[7, 12]]))).resolves.toEqual(
      new Set([green!.backingId, blue!.backingId]),
    );

    expect(ids(windowChildren('green', 12))).toEqual([green!.backingId]);
    expect(ids(windowChildren('blue', 12))).toEqual([blue!.backingId]);
    expect(ids(windowChildren('green', 8))).toEqual([untouched!.backingId]);
  });

  it('indexes local backing page identities by native window', async () => {
    installBookmarkMock();
    await backTab('green', 1, 'https://one.example.com/path#first', 0, 7);
    await backTab('blue', 2, 'https://one.example.com/path#second', 1, 7);
    await backTab('green', 3, 'https://two.example.com/', 0, 8);

    await expect(localTabBackingPagesByWindow()).resolves.toEqual(new Map([
      [7, new Set(['https://one.example.com/path'])],
      [8, new Set(['https://two.example.com/'])],
    ]));
  });

  it('never converts an unmarked token-bearing bookmark into a backing', async () => {
    const { children } = installBookmarkMock();
    const seed = await backTab('green', 99, 'https://seed.example.com', 0, 7);
    const seedBacking = (await bookmarkById(seed!.backingId))!;
    const tabsFolder = (await bookmarkById(seedBacking.parentId!))!;
    const ordinary = await browser.bookmarks.create({
      parentId: tabsFolder.id,
      title: serializeBookmarkTitle('Ordinary', {
        hyper: { tabToken: 'shared-token', spaceId: 'green' },
      }),
      url: 'https://ordinary.example.com',
    });

    const location = await ensureTabBackingBookmark(
      tab(1, 'https://ordinary.example.com', 0, 7),
      'green',
      {
        backingToken: 'shared-token',
        spaceId: 'green',
        windowId: 7,
        url: 'https://ordinary.example.com',
      },
    );

    expect(location?.backingId).not.toBe(ordinary.id);
    expect(children(tabsFolder.id).find((node) => node.id === ordinary.id)?.title)
      .toContain('Ordinary');
  });

  it('never reconciles another installation’s synced window folder', async () => {
    const { children, folder, windowChildren } = installBookmarkMock();
    const current = await backTab('green', 1, 'https://current.example.com', 0, 2);
    const tabs = folder('green', 'tabs')!;
    const foreignFolder = await legacyWindowFolder(tabs.id, 2, 'another-installation');
    const foreignBacking = await create(foreignFolder.id, tabBackingBookmarkTitle('Foreign tab', 0, 'foreign-token', 'blue'), 'https://foreign.example.com');

    await reconcileTabBackingFolders(new Set([2]), new Set([current!.backingId]));

    expect(ids(windowChildren('green', 2))).toEqual([current?.backingId]);
    expect(ids(children(foreignFolder.id))).toEqual([foreignBacking.id]);
  });

  it('treats a closed local window as parked in every space until each space adopts its tabs', async () => {
    const { openWindows, windowChildren } = installBookmarkMock();
    const green = await backTab('green', 1, 'https://green.example.com', 0, 7);
    const blue = await backTab('blue', 2, 'https://blue.example.com', 1, 7);
    const other = await backTab('green', 3, 'https://other.example.com', 0, 8);
    await expect(hasParkedTabBackings('green')).resolves.toBe(false);

    openWindows.delete(7);

    expect(ids(windowChildren('green', 8))).toEqual([other!.backingId]);
    await expect(hasParkedTabBackings('green')).resolves.toBe(true);
    await expect(hasParkedTabBackings('blue')).resolves.toBe(true);

    await expect(adoptParkedTabBackings('green', 9)).resolves.toBe(1);
    expect(ids(windowChildren('green', 9))).toEqual([green!.backingId]);
    await expect(hasParkedTabBackings('green')).resolves.toBe(false);
    await expect(hasParkedTabBackings('blue')).resolves.toBe(true);
    expect(blue).toBeDefined();
  });

  it('drops a parked backing whose page the browser already restored itself', async () => {
    const { liveTabs, openWindows, windowChildren } = installBookmarkMock();
    const restored = await backTab('green', 1, 'https://restored.example.com', 0, 7);
    const missing = await backTab('green', 2, 'https://missing.example.com', 1, 7);
    openWindows.delete(7);
    liveTabs.push(tab(3, 'https://restored.example.com', 0, 9));

    await expect(adoptParkedTabBackings('green', 9)).resolves.toBe(1);

    expect(bookmarkTree.has(restored!.backingId)).toBe(false);
    expect(ids(windowChildren('green', 9))).toEqual([missing!.backingId]);
  });

  it('lets a live tab of the same space and page take over a parked backing', async () => {
    const { openWindows } = installBookmarkMock();
    const parked = await backTab('green', 1, 'https://green.example.com', 0, 7);
    openWindows.delete(7);

    const restored = await backTab('green', 2, 'https://green.example.com', 0, 9);

    expect(restored?.backingId).toBe(parked?.backingId);
    const node = nodeOf(parked!.backingId);
    expect(tabBackingWindowId(node!)).toBe(9);
    await expect(hasParkedTabBackings('green')).resolves.toBe(false);
  });

  it('removes an unclaimed backing whose window is still open', async () => {
    const { windowChildren } = installBookmarkMock();
    const stray = await backTab('green', 1, 'https://stray.example.com', 0, 2);

    await reconcileTabBackingFolders(new Set([2]), new Set());

    expect(bookmarkTree.has(stray!.backingId)).toBe(false);
    expect(windowChildren('green', 2)).toEqual([]);
  });

  it('parks an unclaimed leaf in place during reconciliation', async () => {
    const { children, folder } = installBookmarkMock();
    const stale = await backTab('green', 1, 'https://stale.example.com', 0, 7);
    const tabs = folder('green', 'tabs')!;
    const userFolder = await createTabFolder('green', tabs.id, 'Later');
    await browser.bookmarks.move(stale!.backingId, { parentId: userFolder.id });

    await reconcileTabBackingFolders(new Set(), new Set());

    expect(ids(children(userFolder.id))).toEqual([stale!.backingId]);
    const parked = nodeOf(stale!.backingId);
    expect(tabBackingWindowId(parked!)).toBeUndefined();
  });

  it('discovers later spaces when one closed-window lookup fails', async () => {
    const { windowChildren } = installBookmarkMock();
    await backTab('green', 1, 'https://green.example.com', 0, 7);
    await backTab('blue', 2, 'https://blue.example.com', 1, 7);
    const getChildren = browser.bookmarks.getChildren;
    browser.bookmarks.getChildren = vi.fn(async (parentId: string) => {
      if (parentId === 'green') throw new Error('green lookup unavailable');
      return getChildren(parentId);
    });

    await expect(reconcileTabBackingFolders(new Set(), new Set())).rejects.toThrow(
      'Unable to reconcile every tab backing',
    );

    expect(windowChildren('blue', 7)).toEqual([]);
  });

  it('propagates an exact backing deletion failure', async () => {
    installBookmarkMock();
    const location = await backTab('space', 1, 'https://example.com', 0);
    vi.mocked(browser.bookmarks.remove).mockRejectedValueOnce(new Error('sync unavailable'));

    await expect(removeTabBackingBookmark(location)).rejects.toThrow('sync unavailable');
  });

  it('never deletes an ordinary bookmark referenced by stale ownership', async () => {
    installBookmarkMock();
    const ordinary = await create('bookmarks', 'Keep me', 'https://ordinary.example.com');

    await removeTabBackingBookmark({
      backingId: ordinary.id,
      backingToken: 'stale-token',
      spaceId: 'green',
      windowId: 7,
      url: ordinary.url!,
    });

    expect(bookmarkTree.has(ordinary.id)).toBe(true);
  });

  it('rejects exact adoption, rename, and removal from a foreign window folder', async () => {
    const { children, folder } = installBookmarkMock();
    const original = await backTab('green', 1, 'https://foreign.example.com', 0, 7);
    const tabs = folder('green', 'tabs')!;
    const foreignFolder = await legacyWindowFolder(tabs.id, 7, 'foreign-installation');
    await browser.bookmarks.move(original!.backingId, { parentId: foreignFolder.id });

    const replacement = await ensureTabBackingBookmark(tab(2, 'https://foreign.example.com', 1, 7), 'green', original);
    await expect(renameTabBackingBookmark(original!.backingId, 'Changed', original!))
      .rejects.toThrow('no longer exists');
    await removeTabBackingBookmark(original);

    expect(replacement?.backingId).not.toBe(original?.backingId);
    expect(ids(children(foreignFolder.id))).toEqual([original?.backingId]);
  });

  it('rejects an exact ID when its token does not match ownership', async () => {
    installBookmarkMock();
    const original = await backTab('green', 1, 'https://example.com', 0, 7);
    const replacement = await ensureTabBackingBookmark(
      tab(2, 'https://example.com', 1, 7),
      'green',
      { ...original, backingToken: 'wrong-token' },
    );

    expect(replacement?.backingId).not.toBe(original?.backingId);
    expect(replacement?.backingToken).not.toBe('wrong-token');
  });

  it('treats an already removed exact backing as a successful cleanup', async () => {
    installBookmarkMock();
    const location = await backTab('space', 1, 'https://example.com', 0);
    await browser.bookmarks.remove(location!.backingId);

    await expect(removeTabBackingBookmark(location)).resolves.toBeUndefined();
  });

  it('retains the deletion error when absence cannot be verified', async () => {
    installBookmarkMock();
    const location = await backTab('space', 1, 'https://example.com', 0);
    vi.mocked(browser.bookmarks.remove).mockRejectedValueOnce(new Error('remove unavailable'));
    const getTree = browser.bookmarks.getTree;
    browser.bookmarks.getTree = vi.fn()
      .mockImplementationOnce(getTree)
      .mockRejectedValueOnce(new Error('lookup unavailable'));

    await expect(removeTabBackingBookmark(location)).rejects.toThrow('remove unavailable');
  });
});

describe('preference storage', () => {
  const root = async () => (await bookmarkById('hyper'))!;

  it('saves preferences on the hyper root folder without hiding it', async () => {
    installBookmarkMock();

    await saveHyperPreferences({ autofolders: true });
    // Writers that overlap still each land, rather than the later reading a stale title.
    await Promise.all([
      saveHyperPreferences({ inPageSidebar: true }),
      saveHyperPreferences({ inPageSidebarWidth: 480 }),
    ]);

    expect(visibleBookmarkTitle(await root())).toBe('hyper');
    expect(preferencesFromHyperRoot(await root())).toEqual({
      autofolders: true,
      bookmarkPanelPercent: 50,
      combineTabsAndBookmarks: true,
      groupFavouritesByDomain: true,
      inPageSidebar: true,
      inPageSidebarWidth: 480,
      pageTextSearch: false,
      showOtherSessions: false,
      syncTabStripOrder: true,
      timedMessageSeconds: 7,
    });
  });

  it('moves legacy local preferences onto the root once, keeping any the root saved', async () => {
    const { localStorage } = installBookmarkMock({
      hyperCombineTabsAndBookmarks: false,
      hyperInPageSidebar: true,
      hyperInstallationId: 'installation',
      hyperTabFolderMode: 'autofolders',
    });
    await browser.bookmarks.update('hyper', {
      title: serializeBookmarkTitle('hyper', { hyper: { preferences: { inPageSidebar: false } } }),
    });

    await migrateLegacyPreferences();
    const migratedTitle = (await root()).title;
    await migrateLegacyPreferences();

    expect(preferencesFromHyperRoot(await root())).toEqual({
      autofolders: true,
      bookmarkPanelPercent: 50,
      combineTabsAndBookmarks: false,
      groupFavouritesByDomain: true,
      inPageSidebar: false,
      inPageSidebarWidth: 360,
      pageTextSearch: false,
      showOtherSessions: false,
      syncTabStripOrder: true,
      timedMessageSeconds: 7,
    });
    expect((await root()).title).toBe(migratedTitle);
    expect(localStorage()).toEqual({ hyperInstallationId: 'installation' });
  });
});

describe('installation identity', () => {
  // The installation is read once per worker, so each case starts a fresh one.
  const freshInstallation = async (stored: Record<string, unknown> = {}) => {
    const { localStorage } = installBookmarkMock(stored);
    vi.resetModules();
    const storage = await import('./bookmarkStorage');
    return { localStorage, storage, tabs: await storage.ensureSpaceTabsFolder('green') };
  };
  const addBacking = async (
    parentId: string,
    installationId: string,
    url: string,
    dateAdded: number,
    windowId?: number,
  ) => {
    const node = await create(parentId, tabBackingBookmarkTitle(url, 0, `${installationId} ${url}`, 'green', undefined, {
      installationId,
      ...(windowId === undefined ? {} : { windowId }),
    }), url);
    bookmarkTree.setDateAdded(node.id, dateAdded);
    return nodeOf(node.id);
  };

  it('stays the installation whose tabs fill the open windows when the extension is reinstalled', async () => {
    const { localStorage, storage, tabs } = await freshInstallation();
    await addBacking(tabs.id, 'earlier', 'https://earlier.example.com/', 1_000, 7);
    await addBacking(tabs.id, 'elsewhere', 'https://elsewhere.example.com/', 1_000, 99);

    expect([...(await storage.localTabBackingPagesByWindow()).keys()]).toEqual([7]);
    expect(localStorage()).toEqual({ hyperInstallationId: 'earlier' });
  });

  it('lets a space take back the tabs the installation it replaced left parked for it', async () => {
    const { storage, tabs } = await freshInstallation({ hyperInstallationId: 'current', hyperInstallationStartedAt: 2_000 });
    await addBacking(tabs.id, 'current', 'https://kept.example.com/', 2_500, 3);
    const left = await addBacking(tabs.id, 'previous', 'https://left.example.com/', 1_500);
    const untouched = [
      await addBacking(tabs.id, 'previous', 'https://kept.example.com/', 1_400),
      await addBacking(tabs.id, 'older', 'https://older.example.com/', 500),
      await addBacking(tabs.id, 'concurrent', 'https://concurrent.example.com/', 2_600),
    ];

    await expect(storage.hasParkedTabBackings('green')).resolves.toBe(true);
    await expect(storage.adoptParkedTabBackings('green', 9)).resolves.toBe(1);

    const adopted = nodeOf(left.id);
    expect(tabBackingInstallationId(adopted!)).toBe('current');
    expect(tabBackingWindowId(adopted!)).toBe(9);
    for (const backing of untouched) {
      const node = nodeOf(backing.id);
      expect(tabBackingInstallationId(node!)).not.toBe('current');
      expect(tabBackingWindowId(node!)).toBeUndefined();
    }
  });

  it('dates an installation from before its start was recorded by its oldest tab', async () => {
    const { localStorage, storage, tabs } = await freshInstallation({ hyperInstallationId: 'current' });
    await addBacking(tabs.id, 'current', 'https://kept.example.com/', 3_000, 3);
    await addBacking(tabs.id, 'previous', 'https://left.example.com/', 2_000);

    await expect(storage.adoptParkedTabBackings('green', 9)).resolves.toBe(1);
    expect(localStorage().hyperInstallationStartedAt).toBe(3_000);
  });

  it('leaves the tabs of another device still in use where they are', async () => {
    const { localStorage, storage, tabs } = await freshInstallation();
    await addBacking(tabs.id, 'laptop', 'https://laptop.example.com/', Date.now() + 60_000);

    await expect(storage.hasParkedTabBackings('green')).resolves.toBe(false);
    expect(typeof localStorage().hyperInstallationStartedAt).toBe('number');
  });

  it('copies a tab to another session, parked under a token of its own', async () => {
    const { storage, tabs } = await freshInstallation({ hyperInstallationId: 'current' });
    const source = await addBacking(tabs.id, 'current', 'https://kept.example.com/', 1_000, 3);

    const copy = await storage.copyBackingToSession(source.id, 'laptop');

    expect(copy.parentId).toBe(tabs.id);
    expect(copy.url).toBe('https://kept.example.com/');
    expect(tabBackingInstallationId(copy)).toBe('laptop');
    expect(tabBackingWindowId(copy)).toBeUndefined();
    expect(tabBackingToken(copy)).not.toBe(tabBackingToken(source));
    const kept = nodeOf(source.id);
    expect(tabBackingInstallationId(kept!)).toBe('current');
  });

  it('hands another session\'s tab to a session, taking it out of an earlier window folder for this one', async () => {
    const { storage, tabs } = await freshInstallation({ hyperInstallationId: 'current' });
    const windowFolder = await legacyWindowFolder(tabs.id, 4, 'previous');
    const parked = await addBacking(tabs.id, 'previous', 'https://parked.example.com/', 1_000);
    const nested = await addBacking(windowFolder.id, 'previous', 'https://nested.example.com/', 1_000, 4);

    await storage.moveBackingToSession(parked.id, { installationId: 'laptop' });
    const handed = nodeOf(parked.id);
    expect(tabBackingInstallationId(handed!)).toBe('laptop');
    expect(tabBackingToken(handed!)).toBe(tabBackingToken(parked));

    await expect(storage.moveBackingToSession(nested.id, {
      installationId: 'current', spaceId: 'blue', windowId: 9,
    })).rejects.toThrow('another space');
    await expect(storage.moveBackingToSession(nested.id, {
      installationId: 'current', spaceId: 'green', windowId: 9,
    })).resolves.toMatchObject({ backingId: nested.id, spaceId: 'green', windowId: 9 });
    const taken = nodeOf(nested.id);
    expect(taken!.parentId).toBe(tabs.id);
    expect(tabBackingInstallationId(taken!)).toBe('current');
    expect(tabBackingWindowId(taken!)).toBe(9);
    await expect(storage.moveBackingToSession(nested.id, { installationId: 'laptop' }))
      .rejects.toThrow('already this session');
  });

  it('bookmarks another session\'s tab in a folder, taking it out of its session only when moved', async () => {
    const { storage, tabs } = await freshInstallation({ hyperInstallationId: 'current' });
    const { moveSessionTab } = await import('./sessionTabs');
    const reading = await create('1', 'Reading');
    const remote = await addBacking(tabs.id, 'laptop', 'https://remote.example.com/', 1_000);
    const own = await addBacking(tabs.id, 'current', 'https://own.example.com/', 1_000, 3);
    const dependencies = {
      getTabOwnership: vi.fn(),
      markIntentionalTab: vi.fn(),
      moveTabTreeNodes: vi.fn(),
      routeTab: vi.fn(),
    };

    await expect(storage.sessionBackingPage(remote.id))
      .resolves.toEqual({ title: 'https://remote.example.com/', url: 'https://remote.example.com/' });
    await expect(storage.sessionBackingPage(own.id)).rejects.toThrow('bookmarked from its windows');

    await moveSessionTab({ copy: true, destination: { bookmarks: { parentId: reading.id } }, source: { backingId: remote.id } }, 9, dependencies);
    // Copying it again finds the bookmark already there.
    await moveSessionTab({ copy: true, destination: { bookmarks: { parentId: reading.id } }, source: { backingId: remote.id } }, 9, dependencies);
    expect((await browser.bookmarks.getChildren(reading.id)).map((node) => node.url))
      .toEqual(['https://remote.example.com/']);
    expect(bookmarkTree.has(remote.id)).toBe(true);

    await moveSessionTab({ copy: false, destination: { bookmarks: { parentId: '1' } }, source: { backingId: remote.id } }, 9, dependencies);
    expect((await browser.bookmarks.getChildren('1')).some((node) => node.url === 'https://remote.example.com/')).toBe(true);
    expect((await browser.bookmarks.getChildren(tabs.id)).map((node) => node.id)).not.toContain(remote.id);
    expect(dependencies.routeTab).not.toHaveBeenCalled();
  });
});