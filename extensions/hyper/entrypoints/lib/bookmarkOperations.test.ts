import { describe, expect, it, vi } from 'vitest';
import {
  copyBookmark,
  createBookmarkFolder,
  createBookmarkFromTab,
  createSpace,
  openFavourite,
  updateBookmarkUrl,
  type BookmarkCreateDetails,
} from './bookmarkOperations';
import {
  bookmarkTitleWithCustomName,
  bookmarkTitleWithFavouriteSlot,
  type BookmarkNode,
} from './bookmarks';
import { testTab } from './testFixtures';
import { testBookmark as bookmark, testFolder as folder } from './testBookmarkTree';

const modelTree = (spaces: BookmarkNode[]): BookmarkNode[] => [
  folder('root', '', undefined, [
    folder('toolbar', 'Bookmarks Bar', 'root', [
      folder('hyper', 'hyper', 'toolbar', [
        folder('favourites', 'favourites', 'hyper'),
        folder('spaces', 'spaces', 'hyper', spaces),
      ]),
    ]),
  ]),
];

const tab = (id: number, url: string, overrides: Partial<Browser.tabs.Tab> = {}) => testTab({
  id,
  index: id,
  title: `Page ${id}`,
  url,
  ...overrides,
});

/** Effects for `createBookmarkFromTab` into an empty folder, with `created` as the new bookmark. */
const fromTabEffects = <Overrides extends Partial<Parameters<typeof createBookmarkFromTab>[2]>>(
  created?: BookmarkNode,
  overrides = {} as Overrides,
) => ({
  createBookmark: vi.fn().mockResolvedValue(created),
  extensionOrigin: 'chrome-extension://hyper/',
  getActiveTab: vi.fn(),
  getBookmarkChildren: vi.fn().mockResolvedValue([]),
  getTab: vi.fn(),
  ...overrides,
});

describe('bookmark operation effects', () => {
  it('creates a current-page bookmark from the port client window and returns its node', async () => {
    const created = bookmark('created', 'Page 5', 'https://example.test/page', 'destination');
    const effects = fromTabEffects(created, { getActiveTab: vi.fn().mockResolvedValue(tab(5, 'https://example.test/page')) });

    await expect(createBookmarkFromTab({ parentId: 'destination' }, 18, effects))
      .resolves.toEqual({ created: true, node: created });

    expect(effects.getActiveTab).toHaveBeenCalledWith(18);
    expect(effects.createBookmark).toHaveBeenCalledWith({
      parentId: 'destination',
      title: 'Page 5',
      url: 'https://example.test/page',
    });
  });

  it('uses the named tab and preserves a matching bookmark instead of creating a duplicate', async () => {
    const existing = bookmark('existing', 'Saved', 'https://example.test/page', 'destination');
    const effects = fromTabEffects(undefined, {
      getBookmarkChildren: vi.fn().mockResolvedValue([existing]),
      getTab: vi.fn().mockResolvedValue(tab(9, 'https://example.test/page')),
    });

    await expect(createBookmarkFromTab({ index: 2, parentId: 'destination', tabId: 9 }, 18, effects))
      .resolves.toEqual({ created: false, node: existing });

    expect(effects.getTab).toHaveBeenCalledWith(9);
    expect(effects.createBookmark).not.toHaveBeenCalled();
  });

  it('bookmarks a pasted page, keeping only the title that shows and skipping one already here', async () => {
    const created = bookmark('created', 'Docs', 'https://example.test/docs', 'destination');
    const effects = fromTabEffects(created);
    const { createBookmark } = effects;

    await expect(createBookmarkFromTab({
      index: 1,
      page: { title: 'Docs {"hyper":{"tabsRoot":true}}', url: 'https://example.test/docs' },
      parentId: 'destination',
    }, 18, effects)).resolves.toEqual({ created: true, node: created });
    expect(createBookmark).toHaveBeenCalledWith({
      index: 1,
      parentId: 'destination',
      title: 'Docs',
      url: 'https://example.test/docs',
    });
    expect(effects.getTab).not.toHaveBeenCalled();
    expect(effects.getActiveTab).not.toHaveBeenCalled();

    effects.getBookmarkChildren.mockResolvedValue([created]);
    await expect(createBookmarkFromTab({
      page: { title: '', url: 'https://example.test/docs' },
      parentId: 'destination',
    }, 18, effects)).resolves.toEqual({ created: false, node: created });
    expect(createBookmark).toHaveBeenCalledTimes(1);
  });

  it('names a bookmark after its tab and links the two', async () => {
    const created = bookmark('created', 'Mine', 'https://example.test/page', 'destination');
    const linkTabToBookmark = vi.fn(async () => undefined);
    const effects = fromTabEffects(created, {
      getTab: vi.fn().mockResolvedValue(tab(9, 'https://example.test/page')),
      linkTabToBookmark,
      tabTitles: vi.fn(() => ({ name: 'Mine' })),
    });

    await createBookmarkFromTab({ parentId: 'destination', tabId: 9 }, 18, effects);

    expect(effects.createBookmark).toHaveBeenCalledWith(expect.objectContaining({
      title: bookmarkTitleWithCustomName({ title: 'Page 9' }, 'Mine'),
    }));
    expect(linkTabToBookmark).toHaveBeenCalledWith(9, 'created');
  });

  it('copies only leaf bookmarks and clears a copied favourite slot', async () => {
    const source = bookmark(
      'source',
      bookmarkTitleWithFavouriteSlot({ title: 'Saved' } as BookmarkNode, 2),
      'https://example.test/page',
      'source-parent',
    );
    const copied = bookmark('copy', 'Saved', source.url!, 'destination');
    const createBookmark = vi.fn().mockResolvedValue(copied);

    await expect(copyBookmark({
      bookmarkId: 'source',
      index: 1,
      parentId: 'destination',
      skipExisting: true,
    }, {
      createBookmark,
      getBookmark: vi.fn().mockResolvedValue(source),
      getBookmarkChildren: vi.fn().mockResolvedValue([]),
    })).resolves.toEqual(copied);

    expect(createBookmark).toHaveBeenCalledWith({
      index: 1,
      parentId: 'destination',
      title: 'Saved',
      url: source.url,
    });
  });

  it('does not copy a duplicate only when skipExisting was requested', async () => {
    const source = bookmark('source', 'Saved', 'https://example.test/page', 'source-parent');
    const createBookmark = vi.fn();

    await expect(copyBookmark({
      bookmarkId: 'source',
      parentId: 'destination',
      skipExisting: true,
    }, {
      createBookmark,
      getBookmark: vi.fn().mockResolvedValue(source),
      getBookmarkChildren: vi.fn().mockResolvedValue([source]),
    })).resolves.toBeUndefined();

    expect(createBookmark).not.toHaveBeenCalled();
  });

  it('creates folders and rolls back a partially initialized space', async () => {
    const createBookmark = vi.fn(async (details: BookmarkCreateDetails) => folder(
      details.title === 'New space' ? 'space' : 'folder',
      details.title,
      details.parentId,
    ));
    await expect(createBookmarkFolder('parent', { createBookmark }))
      .resolves.toMatchObject({ id: 'folder', title: 'New folder' });

    const space = folder('space', 'New space', 'spaces');
    const tabs = folder('tabs', 'tabs', 'space');
    const bookmarks = folder('bookmarks', 'bookmarks', 'space');
    const removeCompleteSpace = vi.fn();
    await expect(createSpace('spaces', {
      createBookmark: vi.fn().mockResolvedValue(space),
      ensureSpaceBookmarksFolder: vi.fn().mockResolvedValue(bookmarks),
      ensureSpaceTabsFolder: vi.fn().mockResolvedValue(tabs),
      removeBookmarkTree: removeCompleteSpace,
    })).resolves.toEqual({ ...space, children: [tabs, bookmarks] });
    expect(removeCompleteSpace).not.toHaveBeenCalled();

    const removeBookmarkTree = vi.fn().mockResolvedValue(undefined);
    await expect(createSpace('spaces', {
      createBookmark: vi.fn().mockResolvedValue(folder('space', 'New space', 'spaces')),
      ensureSpaceBookmarksFolder: vi.fn().mockRejectedValue(new Error('bookmark setup failed')),
      ensureSpaceTabsFolder: vi.fn().mockResolvedValue(folder('tabs', 'tabs', 'space')),
      removeBookmarkTree,
    })).rejects.toThrow('bookmark setup failed');

    expect(removeBookmarkTree).toHaveBeenCalledWith('space');
  });

  it('updates only an extant leaf bookmark URL', async () => {
    const updateBookmarkUrlEffect = vi.fn().mockResolvedValue(
      bookmark('bookmark', 'Saved', 'https://updated.test', 'parent'),
    );
    await updateBookmarkUrl({ bookmarkId: 'bookmark', url: 'https://updated.test' }, {
      getBookmark: vi.fn().mockResolvedValue(bookmark('bookmark', 'Saved', 'https://before.test', 'parent')),
      updateBookmarkUrl: updateBookmarkUrlEffect,
    });
    expect(updateBookmarkUrlEffect).toHaveBeenCalledWith('bookmark', 'https://updated.test');

    await expect(updateBookmarkUrl({ bookmarkId: 'folder', url: 'https://updated.test' }, {
      getBookmark: vi.fn().mockResolvedValue(folder('folder', 'Folder', 'parent')),
      updateBookmarkUrl: updateBookmarkUrlEffect,
    })).rejects.toThrow('no longer exists');
  });

  it('opens a favourite in the space already holding its page', async () => {
    const target = tab(4, 'https://example.test/page');
    const openTabInSpace = vi.fn().mockResolvedValue({ created: false, tab: target });
    const getTabs = vi.fn().mockResolvedValue([tab(7, 'https://example.test/page')]);

    await expect(openFavourite({
      activeSpaceId: 'active',
      url: 'https://example.test/page',
    }, 18, {
      getBookmarkTree: vi.fn().mockResolvedValue(modelTree([
        folder('left', 'Left', 'spaces'),
        folder('active', 'Active', 'spaces'),
      ])),
      getTabSpaceIds: vi.fn().mockResolvedValue({ 7: 'left' }),
      getTabs,
      getWindowActiveSpaceId: vi.fn().mockResolvedValue(undefined),
      getWindowIncognito: vi.fn().mockResolvedValue(false),
      openTabInSpace,
    })).resolves.toEqual(target);

    expect(openTabInSpace).toHaveBeenCalledWith({
      active: true,
      destinationSpaceId: 'left',
      forceNew: false,
      reuse: 'browser',
      url: 'https://example.test/page',
      windowId: 18,
    });
    expect(getTabs).toHaveBeenCalledTimes(1);
  });
});