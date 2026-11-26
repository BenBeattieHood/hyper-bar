import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BookmarkNode } from './bookmarks';
import { createSpaceDeletionBrowserPort } from './spaceDeletionBrowser';
import { createSpaceDeletionController } from './spaceDeletionController';
import { hyperBookmarkTree } from './testBookmarkTree';
import { fakeStorageArea } from './testFixtures';
import { spaceGroupKey } from './spaceGroupStore';

vi.mock('./bookmarkStorage', async (importOriginal) => ({
  ...await importOriginal<typeof import('./bookmarkStorage')>(),
  ensureHyperBookmarkStructure: vi.fn(async () => undefined),
  ensureSpaceBookmarksFolder: vi.fn(async (spaceId: string) => ({ id: `${spaceId}-bookmarks` })),
}));
vi.mock('./operationJournal', () => ({
  advanceDurableOperation: vi.fn(async () => undefined),
  beginDurableOperation: vi.fn(async () => undefined),
  completeDurableOperation: vi.fn(async () => undefined),
}));
vi.mock('./windowState', async (importOriginal) => ({
  ...await importOriginal<typeof import('./windowState')>(),
  getWindowActiveSpaceId: vi.fn(async () => 'two'),
  removeWindowActiveSpaceId: vi.fn(async () => undefined),
}));

const WINDOW_ID = 1;
const BOOKMARKS_ROOT_TITLE = 'bookmarks {"hyper":{"spaceBookmarks":true}}';

function installBrowser(options: {
  bookmarks?: Record<string, BookmarkNode[]>;
  removeTree?: boolean;
} = {}) {
  const spaces = [
    { id: 'one', title: 'One' },
    { id: 'two', title: 'Two' },
    { id: 'three', title: 'Three' },
  ];
  let tabs = [
    { groupId: 50, id: 10, incognito: false, index: 0, windowId: WINDOW_ID },
    { groupId: -1, id: 11, incognito: false, index: 1, windowId: WINDOW_ID },
  ];
  const session = fakeStorageArea({
    'tabSpaceId:10': { spaceId: 'two' },
    'tabSpaceId:11': { spaceId: 'one' },
    [spaceGroupKey('two', WINDOW_ID)]: 50,
  });
  const tree = (): BookmarkNode[] => hyperBookmarkTree(spaces.map((space) => ({
    ...space,
    children: options.bookmarks?.[space.id]
      ? [{ children: options.bookmarks[space.id], id: `${space.id}-bookmarks`, title: BOOKMARKS_ROOT_TITLE }]
      : [],
    parentId: 'spaces',
  })));
  vi.stubGlobal('browser', {
    bookmarks: {
      create: vi.fn(async () => ({ id: 'moved' })),
      get: async (id: string) => spaces.filter((space) => space.id === id)
        .map((space) => ({ ...space, parentId: 'spaces' })),
      getChildren: async () => [],
      getTree: async () => tree(),
      move: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
      removeTree: vi.fn(async (id: string) => {
        if (options.removeTree === false) return;
        spaces.splice(spaces.findIndex((space) => space.id === id), 1);
      }),
    },
    storage: { session },
    tabs: {
      query: async () => tabs,
      ungroup: async (tabIds: number[]) => {
        tabs = tabs.map((tab) => tabIds.includes(tab.id) ? { ...tab, groupId: -1 } : tab);
      },
    },
    windows: { getAll: async () => [{ id: WINDOW_ID }] },
  });
  const dependencies = {
    bookmarkLifecycleGeneration: () => 0,
    closeTabs: vi.fn(async (tabIds: number[]) => {
      tabs = tabs.filter((tab) => !tabIds.includes(tab.id));
    }),
    persistWindowActiveSpace: vi.fn(async () => undefined),
    port: createSpaceDeletionBrowserPort(),
  };
  return { dependencies, session: session.values, spaces, tabs: () => tabs };
}

describe('space deletion', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it('moves the window on, closes the space tabs, releases its group, and removes it', async () => {
    const fake = installBrowser();

    const result = await createSpaceDeletionController(fake.dependencies)
      .deleteSpace({ spaceId: 'two' }, WINDOW_ID);

    expect(result).toEqual({ activeSpaceId: 'three' });
    expect(fake.dependencies.persistWindowActiveSpace).toHaveBeenCalledWith(WINDOW_ID, 'three');
    expect(fake.dependencies.closeTabs).toHaveBeenCalledWith([10]);
    expect(fake.tabs().map((tab) => tab.id)).toEqual([11]);
    expect(fake.session.get(spaceGroupKey('two', WINDOW_ID))).toBeUndefined();
    expect(fake.spaces.map((space) => space.id)).toEqual(['one', 'three']);
    expect(browser.bookmarks.move).not.toHaveBeenCalled();
  });

  it('first moves the bookmarks to a folder named for the space, numbered past one already there', async () => {
    const fake = installBrowser({ bookmarks: {
      one: [{ children: [], id: 'existing', title: 'Two' }],
      two: [
        { id: 'page', title: 'Page', url: 'https://example.test/' },
        { children: [], id: 'nested', title: 'Nested' },
      ],
    } as unknown as Record<string, BookmarkNode[]> });

    await createSpaceDeletionController(fake.dependencies)
      .deleteSpace({ moveBookmarks: true, spaceId: 'two' }, WINDOW_ID);

    expect(browser.bookmarks.create).toHaveBeenCalledWith({ parentId: 'one-bookmarks', title: 'Two 2' });
    expect(vi.mocked(browser.bookmarks.move).mock.calls).toEqual([
      ['page', { parentId: 'moved' }],
      ['nested', { parentId: 'moved' }],
    ]);
    expect(vi.mocked(browser.bookmarks.move).mock.invocationCallOrder[1])
      .toBeLessThan(fake.dependencies.closeTabs.mock.invocationCallOrder[0] ?? 0);
    expect(fake.spaces.map((space) => space.id)).toEqual(['one', 'three']);
  });

  it('keeps a provisional space the user has changed', async () => {
    const fake = installBrowser();

    await expect(createSpaceDeletionController(fake.dependencies)
      .deleteSpace({ expectedProvisionalTitle: 'Space 4', spaceId: 'two' }, WINDOW_ID))
      .rejects.toThrow('The provisional space changed before it could be removed.');
    expect(fake.dependencies.closeTabs).not.toHaveBeenCalled();
    expect(fake.spaces).toHaveLength(3);
  });

  it('puts windows back on the space when its removal cannot be verified', async () => {
    const fake = installBrowser({ removeTree: false });

    await expect(createSpaceDeletionController(fake.dependencies).deleteSpace({ spaceId: 'two' }, WINDOW_ID))
      .rejects.toThrow('The deleted space is still present.');
    expect(fake.dependencies.persistWindowActiveSpace).toHaveBeenLastCalledWith(WINDOW_ID, 'two');
  });

  it('refuses to delete the last space', async () => {
    const fake = installBrowser();
    fake.spaces.splice(0, 3, { id: 'two', title: 'Two' });

    await expect(createSpaceDeletionController(fake.dependencies).deleteSpace({ spaceId: 'two' }, WINDOW_ID))
      .rejects.toThrow('At least one space is required.');
  });
});
