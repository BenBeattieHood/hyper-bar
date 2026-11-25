import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createBookmarkIntentHandlers,
  type BookmarkIntentHandlerDependencies,
} from './bookmarkIntentHandlers';
import { tabBackingBookmarkTitle } from './bookmarks';
import { SupersededTargetError } from './modelGuards';
import type { HyperModelPortClient } from './modelPort';

vi.mock('./bookmarkStorage', async (importOriginal) => ({
  ...await importOriginal<typeof import('./bookmarkStorage')>(),
  ensureSpaceBookmarksFolder: vi.fn(async () => ({ id: 'space-bookmarks', title: 'bookmarks' })),
  ensureSpaceTabsFolder: vi.fn(async () => ({ id: 'space-tabs', title: 'tabs' })),
}));

const client: HyperModelPortClient = {
  clientId: 'sidebar-client',
  role: 'sidebar',
  windowId: 3,
};

const queueMutation = <Result,>(operation: () => Promise<Result>) => operation();

const handlersUnderTest = (overrides: Partial<BookmarkIntentHandlerDependencies> = {}) => {
  const messages = { offer: vi.fn(() => 'message') };
  const windowSpaces = { select: vi.fn(), showNewSpace: vi.fn(async () => undefined) };
  const handlers = createBookmarkIntentHandlers({
    linkTabToBookmark: vi.fn(async () => undefined),
    messages: messages as unknown as BookmarkIntentHandlerDependencies['messages'],
    openTabInSpace: vi.fn(),
    queueMutation,
    setFavouriteSlot: vi.fn(async () => undefined),
    tabTitles: vi.fn(() => ({})),
    tabsLinkedTo: vi.fn(() => new Map()),
    windowSpaces: () => windowSpaces,
    ...overrides,
  });
  /** The window and undo offer of the first message the handlers offered. */
  const offered = () => messages.offer.mock.calls[0] as unknown as
    [number, { act(remade: Map<string, string>): Promise<void>; detail?: string; kind: string; text: string }];
  return { handlers, messages, offered, windowSpaces };
};

/** Stubs bookmark reads and removals over `entries`, keyed by ID; `create` answers with `createdId`. */
const stubBookmarkStore = (entries: Array<{ id: string } & Record<string, unknown>>, createdId = 'copy') => {
  const nodes = new Map(entries.map((entry) => [entry.id, entry]));
  const bookmarks = {
    create: vi.fn(async (details: object) => ({ id: createdId, ...details })),
    get: vi.fn(async (bookmarkId: string) => nodes.has(bookmarkId) ? [nodes.get(bookmarkId)] : []),
    getSubTree: vi.fn(async (bookmarkId: string) => [nodes.get(bookmarkId)]),
    remove: vi.fn(async (bookmarkId: string) => void nodes.delete(bookmarkId)),
  };
  vi.stubGlobal('browser', { bookmarks });
  return bookmarks;
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('bookmark intent handlers', () => {
  it('deletes a selection as one command, answers for each item and offers to undo it', async () => {
    const { create, remove } = stubBookmarkStore([
      { id: 'folder', title: 'Folder' },
      { id: 'one', index: 0, parentId: 'folder', title: 'One', url: 'https://example.test/one' },
      { id: 'two', index: 1, parentId: 'folder', title: 'Two', url: 'https://example.test/two' },
    ]);
    const { handlers, offered } = handlersUnderTest();
    const payload = { items: [{ bookmarkId: 'two' }, { bookmarkId: 'one' }] };

    await expect(handlers.deleteBookmark!.run(payload, client)).resolves.toEqual([undefined, undefined]);

    expect(remove.mock.calls).toEqual([['two'], ['one']]);
    expect(handlers.deleteBookmark!.targets(payload, client)).toEqual(['bookmark:two', 'bookmark:one']);
    const [windowId, offer] = offered();
    expect(windowId).toBe(3);
    expect(offer).toMatchObject({ kind: 'undo', text: 'Deleted 2 items' });
    await offer.act(new Map());
    expect(create.mock.calls).toEqual([
      [{ index: 0, parentId: 'folder', title: 'One', url: 'https://example.test/one' }],
      [{ index: 1, parentId: 'folder', title: 'Two', url: 'https://example.test/two' }],
    ]);
  });

  it('labels a removed favourite as unpinned and still offers undo', async () => {
    const node = {
      id: 'favourite',
      index: 0,
      parentId: 'favourites',
      title: 'Recent tab',
      url: 'https://example.test/',
    };
    stubBookmarkStore([node]);
    const { handlers, offered } = handlersUnderTest();

    await handlers.deleteBookmark!.run({ bookmarkId: node.id, unpin: true }, client);

    const [windowId, offer] = offered();
    expect(windowId).toBe(client.windowId);
    expect(offer).toMatchObject({ kind: 'undo', text: 'Item unpinned' });
    expect(offer.act).toEqual(expect.any(Function));
  });

  it('labels favourites unpinned together, as a grouped tile does, as unpinned', async () => {
    const node = (id: string) => ({ id, index: 0, parentId: 'favourites', title: id, url: `https://example.test/${id}` });
    stubBookmarkStore([node('one'), node('two')]);
    const { handlers, offered } = handlersUnderTest();

    await handlers.deleteBookmark!.run({ items: [{ bookmarkId: 'one', unpin: true }, { bookmarkId: 'two', unpin: true }] }, client);

    expect(offered()[1]).toMatchObject({ kind: 'undo', text: 'Unpinned 2 items' });
  });

  it('says it closed another session\'s tab, and undoing brings its backing back as it was', async () => {
    const title = tabBackingBookmarkTitle('Remote', 0, 'token', 'green', undefined, { installationId: 'laptop' });
    const { create } = stubBookmarkStore([
      { id: 'tabs', title: 'tabs' },
      { id: 'r1', index: 2, parentId: 'tabs', title, url: 'https://remote.test/' },
    ], 'again');
    const { handlers, offered } = handlersUnderTest();

    await handlers.deleteBookmark!.run({ bookmarkId: 'r1' }, client);
    const [, offer] = offered();
    expect(offer).toMatchObject({ detail: 'Remote', kind: 'undo', text: 'Closed tab' });
    await offer.act(new Map());
    expect(create.mock.calls).toEqual([[{ index: 2, parentId: 'tabs', title, url: 'https://remote.test/' }]]);
  });

  it('relinks the tabs that were linked to a deleted folder\'s bookmarks when the delete is undone', async () => {
    const tree = {
      children: [
        { id: 'docs', index: 0, parentId: 'folder', title: 'Docs', url: 'https://docs.test/start' },
        { id: 'mail', index: 1, parentId: 'folder', title: 'Mail', url: 'https://mail.test/' },
      ],
      id: 'folder',
      index: 2,
      parentId: 'space',
      title: 'Work',
    };
    let nextId = 0;
    vi.stubGlobal('browser', {
      bookmarks: {
        create: vi.fn(async (details: object) => ({ id: `copy-${nextId++}`, ...details })),
        get: vi.fn(async (bookmarkId: string) => [{ id: bookmarkId, title: 'Space' }]),
        getSubTree: vi.fn(async () => [tree]),
        removeTree: vi.fn(async () => undefined),
      },
      tabs: {
        get: vi.fn(async (tabId: number) => ({
          id: tabId,
          url: tabId === 7 ? 'https://docs.test/page-2' : 'https://elsewhere.test/',
        })),
      },
    });
    const linkTabToBookmark = vi.fn(async () => undefined);
    const tabsLinkedTo = vi.fn(() => new Map([[7, 'docs'], [8, 'mail']]));
    const { handlers, offered } = handlersUnderTest({ linkTabToBookmark, tabsLinkedTo });

    await handlers.deleteBookmark!.run({ bookmarkId: 'folder' }, client);
    expect(tabsLinkedTo).toHaveBeenCalledWith(new Set(['folder', 'docs', 'mail']));
    await offered()[1].act(new Map());

    // Tab 8 has left its bookmark's domain since, so it stays unlinked.
    expect(linkTabToBookmark.mock.calls).toEqual([[7, 'copy-1']]);
  });

  it('bookmarks a selection of tabs in order, closing up past one already there', async () => {
    const existing = { id: 'existing', parentId: 'folder', title: 'Two', url: 'https://example.test/two' };
    const create = vi.fn(async (details: { index?: number; title: string; url: string }) =>
      ({ id: `new-${details.index}`, parentId: 'folder', ...details }));
    vi.stubGlobal('browser', {
      bookmarks: { create, getChildren: vi.fn(async () => [existing]) },
      runtime: { getURL: () => 'chrome-extension://hyper/' },
      tabs: {
        get: vi.fn(async (tabId: number) => ({
          id: tabId,
          title: ['One', 'Two', 'Three'][tabId - 1],
          url: `https://example.test/${['one', 'two', 'three'][tabId - 1]}`,
          windowId: 3,
        })),
      },
    });
    const { handlers } = handlersUnderTest();

    const results = await handlers.createBookmark!.run({ items: [
      { index: 4, parentId: 'folder', tabId: 1 },
      { index: 5, parentId: 'folder', tabId: 2 },
      { index: 6, parentId: 'folder', tabId: 3 },
    ] }, client) as Array<{ created: boolean }>;

    expect(results.map((result) => result.created)).toEqual([true, false, true]);
    expect(create.mock.calls.map(([details]) => details.index)).toEqual([4, 5]);
  });

  it('takes the creating window to a new space, which survives a newer choice', async () => {
    const create = vi.fn(async () => ({ id: 'space', parentId: 'spaces', title: 'New space' }));
    vi.stubGlobal('browser', { bookmarks: { create } });
    const { handlers, windowSpaces } = handlersUnderTest();

    await expect(handlers.createSpace!.run({ spacesFolderId: 'spaces' }, client))
      .resolves.toMatchObject({ id: 'space' });
    windowSpaces.showNewSpace.mockRejectedValueOnce(new SupersededTargetError('space:space'));
    await expect(handlers.createSpace!.run({ spacesFolderId: 'spaces' }, client))
      .resolves.toMatchObject({ id: 'space' });

    expect(create).toHaveBeenCalledWith({ parentId: 'spaces', title: 'New space' });
    expect(windowSpaces.select).toHaveBeenCalledWith('space', client);
    expect(windowSpaces.showNewSpace).toHaveBeenCalledWith('space', client);
    expect(handlers.createSpace!.targets({ spacesFolderId: 'spaces' }, client))
      .toEqual(['bookmark:spaces', 'window:3']);
  });

  it('deletes ordinary bookmarks and verifies provisional folders in the background lane', async () => {
    const get = vi.fn(async (bookmarkId: string) => bookmarkId === 'bookmark'
      ? [{ id: bookmarkId, url: 'https://example.test' }]
      : [{ id: bookmarkId, title: 'New folder' }]);
    const getChildren = vi.fn(async () => []);
    const remove = vi.fn(async () => undefined);
    const removeTree = vi.fn(async () => undefined);
    const getSubTree = vi.fn(async (bookmarkId: string) => [{ id: bookmarkId, parentId: 'root', title: 'Docs' }]);
    vi.stubGlobal('browser', { bookmarks: { get, getChildren, getSubTree, remove, removeTree } });
    const { handlers, messages } = handlersUnderTest();

    await handlers.deleteBookmark!.run({ bookmarkId: 'bookmark' }, client);
    const removed = await handlers.deleteBookmark!.run({
      bookmarkId: 'folder',
      expectedProvisionalTitle: 'New folder',
    }, client);

    expect(remove).toHaveBeenNthCalledWith(1, 'bookmark');
    expect(remove).toHaveBeenNthCalledWith(2, 'folder');
    expect(removeTree).not.toHaveBeenCalled();
    expect(removed).toBe(true);
    // Cancelling a folder that was never named has nothing to undo.
    expect(messages.offer).toHaveBeenCalledTimes(1);
  });

  it('leaves a provisional folder in place when user content appeared', async () => {
    const get = vi.fn(async () => [{ id: 'folder', title: 'New folder' }]);
    const getChildren = vi.fn(async () => [{ id: 'child', title: 'Saved item' }]);
    const remove = vi.fn(async () => undefined);
    vi.stubGlobal('browser', { bookmarks: { get, getChildren, remove } });
    const { handlers } = handlersUnderTest();

    await expect(handlers.deleteBookmark!.run({
      bookmarkId: 'folder',
      expectedProvisionalTitle: 'New folder',
    }, client)).resolves.toBe(false);
    expect(remove).not.toHaveBeenCalled();
  });

  it('places a copy in its favourite slot in one intent, and removes a copy that cannot take it', async () => {
    const create = vi.fn(async () => ({ id: 'copy', parentId: 'favourites', title: 'Docs' }));
    const get = vi.fn(async () => [{ id: 'source', title: 'Docs', url: 'https://example.test' }]);
    const remove = vi.fn(async () => undefined);
    vi.stubGlobal('browser', { bookmarks: { create, get, getChildren: vi.fn(async () => []), remove } });
    const setFavouriteSlot = vi.fn(async () => undefined);
    const copy = { bookmarkId: 'source', favouriteSlot: 2, parentId: 'favourites' };

    const { handlers } = handlersUnderTest({ setFavouriteSlot });

    await expect(handlers.copyBookmark!.run(copy, client))
      .resolves.toMatchObject({ id: 'copy' });
    expect(setFavouriteSlot).toHaveBeenCalledWith('copy', 2, 3);
    expect(remove).not.toHaveBeenCalled();

    setFavouriteSlot.mockRejectedValueOnce(new Error('Favourites are full'));
    await expect(handlers.copyBookmark!.run(copy, client))
      .rejects.toThrow('Favourites are full');
    expect(remove).toHaveBeenCalledWith('copy');
  });
});