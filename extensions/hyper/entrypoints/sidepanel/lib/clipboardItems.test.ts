import { describe, expect, it } from 'vitest';
import { tabBackingBookmarkTitle, type BookmarkNode, type BrowserTab } from '../../lib/bookmarks';
import { testTab } from '../../lib/testFixtures';
import type { FlattenedTreeItem } from './drag';
import {
  clipboardEntries,
  hyperClipboard,
  itemLocator,
  planPaste,
  resolveClipboard,
  searchItemEntry,
  type ClipboardSurroundings,
  type PasteTarget,
} from './clipboardItems';
import type { HyperClipboard } from './itemClipboard';

const node = (
  id: string,
  parentId: string,
  index: number,
  title: string,
  url?: string,
  children?: BookmarkNode[],
): BookmarkNode => ({
  id,
  index,
  parentId,
  syncing: false,
  title,
  ...(url ? { url } : {}),
  ...(children ? { children } : {}),
});

// The space's bookmarks: docs/ (guide), api/ (empty), news
const guide = node('guide', 'docs', 0, 'Guide', 'https://example.test/guide');
const docs = node('docs', 'space-root', 0, 'Docs', undefined, [guide]);
const api = node('api', 'space-root', 1, 'API', undefined, []);
const news = node('news', 'space-root', 2, 'News {"isCustomName":true}', 'https://example.test/news');
// The window's tab tree: one (b1), Reading/ (two: b2)
const one = node('b1', 'tabs-root', 0, 'One', 'https://tabs.test/one');
const two = node('b2', 'reading', 0, 'Two', 'https://tabs.test/two');
const reading = node('reading', 'tabs-root', 1, 'Reading', undefined, [two]);
const favourite = node('fav', 'favourites', 0, 'Fav', 'https://example.test/fav');
const tabs: BrowserTab[] = [
  testTab({ id: 1, index: 0, title: 'One', url: 'https://tabs.test/one', windowId: 9 }),
  testTab({ id: 2, index: 1, title: 'Two', url: 'https://tabs.test/two', windowId: 9 }),
  // In another of the window's spaces, so in no place of this space's tree.
  testTab({ id: 3, index: 2, title: 'Three', url: 'https://tabs.test/three', windowId: 9 }),
];

const surroundings: ClipboardSurroundings = {
  bookmarkTrees: [{ nodes: [docs, api, news], rootId: 'space-root' }],
  extensionOrigin: 'chrome-extension://hyper/',
  favouriteSlots: [favourite],
  installationId: 'install',
  nodeMap: new Map([docs, guide, api, news, one, two, reading, favourite].map((item) => [item.id, item])),
  tabBackingIds: { 1: 'b1', 2: 'b2' },
  tabTreeNodes: [one, reading],
  tabTreeRootId: 'tabs-root',
  tabs,
  windowId: 9,
};

const placed = (item: BookmarkNode, depth: number, ancestorIds: string[]): FlattenedTreeItem => ({
  ancestorIds,
  depth,
  index: item.index ?? 0,
  isFolder: !item.url,
  node: item,
  nodeId: item.id,
  parentId: item.parentId ?? '',
});
const intoApi: PasteTarget = { folder: placed(api, 0, []), kind: 'bookmark-folder' };
const intoDocs: PasteTarget = { folder: placed(docs, 0, []), kind: 'bookmark-folder' };
const intoReading: PasteTarget = { folder: placed(reading, 0, []), kind: 'tab-folder' };

const treeItem = (item: BookmarkNode, depth = 0) => ({
  depth,
  index: item.index ?? 0,
  isFolder: !item.url,
  kind: 'tree' as const,
  nodeId: item.id,
  parentId: item.parentId ?? '',
  title: item.title,
});
const tabItem = (tabId: number) => ({
  bookmarkable: true,
  index: tabId - 1,
  kind: 'tab' as const,
  tabId,
  title: `Tab ${tabId}`,
  windowId: 9,
});
const copied = (
  operation: HyperClipboard['operation'],
  items: Parameters<typeof hyperClipboard>[1],
  within = surroundings,
) => ({ hyper: hyperClipboard(operation, items, within), text: '' });

describe('what a copy records', () => {
  it('keeps titles, addresses, metadata, and folders\u2019 contents', () => {
    expect(clipboardEntries([treeItem(docs), treeItem(news)], surroundings)).toEqual([
      {
        children: [{ kind: 'bookmark', nodeId: 'guide', title: 'Guide', url: 'https://example.test/guide' }],
        kind: 'folder',
        nodeId: 'docs',
        title: 'Docs',
      },
      {
        kind: 'bookmark',
        metadata: { isCustomName: true },
        nodeId: 'news',
        title: 'News',
        url: 'https://example.test/news',
      },
    ]);
    expect(clipboardEntries([
      tabItem(1),
      { depth: 0, index: 1, kind: 'tab-folder', nodeId: 'reading', parentId: 'tabs-root', title: 'Reading' },
      { index: 0, kind: 'favourite', nodeId: 'fav', title: 'Fav' },
    ], surroundings)).toEqual([
      { kind: 'tab', nodeId: 'b1', tabId: 1, title: 'Tab 1', url: 'https://tabs.test/one' },
      {
        children: [{ kind: 'tab', nodeId: 'b2', tabId: 2, title: 'Two', url: 'https://tabs.test/two' }],
        kind: 'tab-folder',
        nodeId: 'reading',
        title: 'Reading',
      },
      { favourite: true, kind: 'bookmark', nodeId: 'fav', title: 'Fav', url: 'https://example.test/fav' },
    ]);
  });
});

describe('what a paste trusts', () => {
  it('finds the copied rows where they are now', () => {
    const clipboard = hyperClipboard('cut', [treeItem(guide, 1), tabItem(1)], surroundings);

    expect(resolveClipboard(clipboard, surroundings)).toEqual([
      expect.objectContaining({ ancestorIds: ['docs'], depth: 1, kind: 'tree', nodeId: 'guide', parentId: 'docs' }),
      expect.objectContaining({
        backingId: 'b1',
        kind: 'tab',
        nodeId: 'b1',
        parentId: 'tabs-root',
        tabId: 1,
        treeIndex: 0,
      }),
    ]);
  });

  it('trusts no copy another installation made, and no row that has changed since', () => {
    const clipboard = hyperClipboard('cut', [treeItem(news)], surroundings);

    expect(resolveClipboard({ ...clipboard, installationId: 'other' }, surroundings)).toBeUndefined();
    expect(resolveClipboard({ ...clipboard, installationId: undefined }, surroundings)).toBeUndefined();
    expect(resolveClipboard({
      ...clipboard,
      items: [{ ...clipboard.items[0]!, url: 'https://example.test/elsewhere' }],
    }, surroundings)).toBeUndefined();
    // Another window's tab is never named by a view, whatever the clipboard says.
    expect(resolveClipboard({
      ...clipboard,
      items: [{ kind: 'tab', tabId: 44, title: 'Remote', url: 'https://tabs.test/remote' }],
    }, surroundings)).toBeUndefined();
  });

  it('finds the rows search results name, so a result\u2019s menu can be its row\u2019s', () => {
    const locate = itemLocator(surroundings);
    const result = { detail: '', id: 'r', source: 'bookmark' as const, title: 'Result' };

    expect(locate.item(searchItemEntry({ ...result, kind: 'bookmark', nodeId: 'guide', url: guide.url })))
      .toEqual(expect.objectContaining({ kind: 'tree', nodeId: 'guide', parentId: 'docs', title: 'Result' }));
    expect(locate.item(searchItemEntry({ ...result, kind: 'folder', nodeId: 'docs' })))
      .toEqual(expect.objectContaining({ isFolder: true, kind: 'tree', nodeId: 'docs' }));
    expect(locate.item(searchItemEntry({
      ...result,
      kind: 'bookmark',
      nodeId: 'fav',
      source: 'favourite',
      url: favourite.url,
    }))).toEqual({ index: 0, itemCount: 1, kind: 'favourite', nodeId: 'fav', title: 'Result' });
    expect(locate.item(searchItemEntry({ ...result, kind: 'tab', source: 'tab', tabId: 2, url: two.url })))
      .toEqual(expect.objectContaining({ kind: 'tab', nodeId: 'b2', tabId: 2 }));
    expect(locate.bookmarkItem('docs')).toEqual(expect.objectContaining({ isFolder: true, nodeId: 'docs' }));
    // History, and another window's tabs, are no row here.
    expect(locate.item(searchItemEntry({ ...result, kind: 'history', url: 'https://example.test/old' })))
      .toBeUndefined();
    expect(locate.item(searchItemEntry({ ...result, kind: 'tab', tabId: 44, url: 'https://tabs.test/remote' })))
      .toBeUndefined();
  });
});

describe('what a paste does', () => {
  it('moves cut bookmarks into the folder, as a drop on its middle would', () => {
    const plan = planPaste(copied('cut', [treeItem(news)]), intoDocs, surroundings);

    expect(plan).toMatchObject({
      kind: 'drop',
      request: {
        copiesBookmark: false,
        modifierActive: false,
        source: { kind: 'tree', nodeId: 'news' },
        target: { isFolder: true, kind: 'tree', nodeId: 'docs' },
        treeDrop: { destination: { index: 0, parentId: 'docs' }, invalid: false, position: 'inside' },
      },
    });
  });

  it('copies copied bookmarks, but will not pretend to copy a folder', () => {
    expect(planPaste(copied('copy', [treeItem(news)]), intoDocs, surroundings)).toMatchObject({
      kind: 'drop',
      request: { copiesBookmark: true, modifierActive: true },
    });
    expect(planPaste(copied('copy', [treeItem(docs)]), intoApi, surroundings)).toEqual({
      kind: 'notice',
      message: 'Folders can be cut and pasted, but not copied',
    });
  });

  it('marks a folder pasted into itself, and a bookmark already first in the folder', () => {
    expect(planPaste(copied('cut', [treeItem(docs)]), intoDocs, surroundings)).toMatchObject({
      request: { treeDrop: { invalid: true } },
    });
    expect(planPaste(copied('cut', [treeItem(guide, 1)]), intoDocs, surroundings)).toMatchObject({
      request: { treeDrop: { unchanged: true } },
    });
  });

  it('moves cut tabs into a tab folder, and opens copied ones there as new tabs', () => {
    expect(planPaste(copied('cut', [tabItem(1)]), intoReading, surroundings)).toMatchObject({
      kind: 'drop',
      request: {
        source: { backingId: 'b1', kind: 'tab' },
        tabTreeDrop: { destination: { index: 0, parentId: 'reading' }, invalid: false },
        target: { kind: 'tab-folder', nodeId: 'reading' },
      },
    });
    expect(planPaste(copied('copy', [tabItem(1)]), intoReading, surroundings)).toEqual({
      kind: 'open-pages',
      pages: [{ title: 'Tab 1', url: 'https://tabs.test/one' }],
    });
  });

  it('brings a tab from another of the window\u2019s spaces into the folder', () => {
    expect(planPaste(copied('cut', [tabItem(3)]), intoReading, surroundings)).toEqual({
      destination: { index: 0, parentId: 'reading' },
      kind: 'move-tabs',
      tabIds: [3],
    });
  });

  it('pastes plain addresses and rows it cannot trust as new bookmarks or tabs', () => {
    const text = { text: 'https://pasted.test/a\nhello' };
    expect(planPaste(text, intoApi, surroundings)).toEqual({
      index: 0,
      kind: 'bookmark-pages',
      pages: [{ title: 'https://pasted.test/a', url: 'https://pasted.test/a' }],
      parentId: 'api',
    });
    expect(planPaste(text, intoReading, surroundings)).toEqual({
      kind: 'open-pages',
      pages: [{ title: 'https://pasted.test/a', url: 'https://pasted.test/a' }],
    });
    const foreign = copied('cut', [treeItem(news)]);
    expect(planPaste(
      { ...foreign, hyper: { ...foreign.hyper, installationId: 'other' } },
      intoApi,
      surroundings,
    )).toEqual({
      index: 0,
      kind: 'bookmark-pages',
      notice: 'Pasted as copies: what was cut stays where it was',
      pages: [{ title: 'News', url: 'https://example.test/news' }],
      parentId: 'api',
    });
    expect(planPaste({ text: 'hello' }, intoApi, surroundings)).toEqual({
      kind: 'notice',
      message: 'There is nothing here to paste',
    });
  });
});

describe('what a paste on a favourites bar slot does', () => {
  const slot: PasteTarget = { index: 2, kind: 'favourite-slot' };
  const withFavourites = { ...surroundings, favouritesFolderId: 'favourites' };

  it('pins copied bookmarks and tabs there, as dropping them would', () => {
    expect(planPaste(copied('copy', [treeItem(news)]), slot, withFavourites)).toMatchObject({
      kind: 'drop',
      request: { copiesBookmark: true, target: slot },
    });
    expect(planPaste(copied('cut', [tabItem(1)]), slot, withFavourites)).toMatchObject({
      kind: 'drop',
      request: { modifierActive: false, source: { kind: 'tab', tabId: 1 }, target: slot },
    });
  });

  it('refuses folders', () => {
    expect(planPaste(copied('cut', [treeItem(docs)]), slot, withFavourites)).toEqual({
      kind: 'notice',
      message: 'Only bookmarks and tabs can be pinned',
    });
  });

  it('pins an address as a new favourite in that slot', () => {
    expect(planPaste({ text: 'https://pasted.test/a' }, slot, withFavourites)).toEqual({
      favouriteSlots: [2],
      index: 0,
      kind: 'bookmark-pages',
      pages: [{ title: 'https://pasted.test/a', url: 'https://pasted.test/a' }],
      parentId: 'favourites',
    });
    expect(planPaste({ text: 'hello' }, slot, withFavourites)).toEqual({
      kind: 'notice',
      message: 'There is nothing here to pin',
    });
  });

  it('unpins a cut favourite once it lands in a bookmark folder', () => {
    const fav = { index: 0, kind: 'favourite' as const, nodeId: 'fav', title: 'Fav' };
    expect(planPaste(copied('cut', [fav]), intoApi, withFavourites)).toMatchObject({
      kind: 'drop',
      unpinAfter: ['fav'],
    });
    expect(planPaste(copied('copy', [fav]), intoApi, withFavourites)).not.toHaveProperty('unpinAfter');
  });
});

describe('what a paste of another session\u2019s tabs does', () => {
  // A tab the laptop's Hyper keeps, and one from before installations had IDs.
  const remote = node('r1', 'tabs-root', 2, tabBackingBookmarkTitle('Remote', 0, 'token-r1', 'space', undefined, {
    installationId: 'laptop',
  }), 'https://remote.test/');
  const legacy = node('r2', 'tabs-root', 3, tabBackingBookmarkTitle('Old', 0, 'token-r2'), 'https://old.test/');
  const withRemote: ClipboardSurroundings = {
    ...surroundings,
    favouritesFolderId: 'favourites',
    nodeMap: new Map([...surroundings.nodeMap, [remote.id, remote], [legacy.id, legacy]]),
  };
  const sessionItem = { installationId: 'laptop', kind: 'session-tab' as const, nodeId: 'r1', title: 'Remote' };
  const copiedRemote = (operation: HyperClipboard['operation'], items: Parameters<typeof hyperClipboard>[1]) =>
    copied(operation, items, withRemote);

  it('records the tab by its backing, and finds it while it is still that session\u2019s', () => {
    const clipboard = hyperClipboard('cut', [sessionItem], withRemote);
    expect(clipboard.items).toEqual([expect.objectContaining({
      kind: 'session-tab', nodeId: 'r1', title: 'Remote', url: 'https://remote.test/',
    })]);
    expect(resolveClipboard(clipboard, withRemote)).toEqual([{ ...sessionItem, itemCount: 1, url: 'https://remote.test/' }]);
    expect(resolveClipboard({
      ...clipboard,
      items: [{ ...clipboard.items[0]!, nodeId: 'r2', url: 'https://old.test/' }],
    }, withRemote)).toEqual([expect.objectContaining({ installationId: '', nodeId: 'r2' })]);
    // Gone, moved to another address, or taken over by this installation: pasted as a page instead.
    expect(resolveClipboard(clipboard, surroundings)).toBeUndefined();
    expect(resolveClipboard({ ...clipboard, items: [{ ...clipboard.items[0]!, url: 'https://elsewhere.test/' }] }, withRemote))
      .toBeUndefined();
    expect(resolveClipboard(clipboard, { ...withRemote, installationId: 'laptop' })).toBeUndefined();
  });

  it('makes a bookmark of it in a bookmark folder, and takes it over in a tab folder', () => {
    expect(planPaste(copiedRemote('copy', [sessionItem]), intoApi, withRemote)).toMatchObject({
      kind: 'drop',
      request: { modifierActive: true, source: { kind: 'session-tab', nodeId: 'r1' }, treeDrop: { invalid: false } },
    });
    expect(planPaste(copiedRemote('cut', [sessionItem]), intoReading, withRemote)).toMatchObject({
      kind: 'drop',
      request: {
        modifierActive: false,
        source: { kind: 'session-tab', nodeId: 'r1' },
        tabTreeDrop: { destination: { index: 0, parentId: 'reading' } },
      },
    });
    // A copy opens here through the same drop, so the tab keeps its place in the other session.
    expect(planPaste(copiedRemote('copy', [sessionItem]), intoReading, withRemote)).toMatchObject({
      kind: 'drop',
      request: { modifierActive: true, source: { kind: 'session-tab' } },
    });
  });

  it('pins it as the page it shows', () => {
    expect(planPaste(copiedRemote('copy', [sessionItem]), { index: 1, kind: 'favourite-slot' }, withRemote))
      .toMatchObject({ favouriteSlots: [1], kind: 'bookmark-pages', pages: [{ url: 'https://remote.test/' }] });
  });

  it('gives a session this window\u2019s kept tabs and other sessions\u2019 tabs, and nothing else', () => {
    const intoDesktop: PasteTarget = { installationId: 'desktop', kind: 'session' };
    expect(planPaste(copiedRemote('cut', [sessionItem]), intoDesktop, withRemote)).toMatchObject({
      kind: 'drop',
      request: { modifierActive: false, source: { kind: 'session-tab' }, target: { installationId: 'desktop', kind: 'session-zone' } },
    });
    expect(planPaste(copiedRemote('copy', [tabItem(1)]), intoDesktop, withRemote)).toMatchObject({
      kind: 'drop',
      request: { modifierActive: true, source: { backingId: 'b1', kind: 'tab' }, target: { kind: 'session-zone' } },
    });
    expect(planPaste(copiedRemote('copy', [treeItem(news)]), intoDesktop, withRemote)).toEqual({
      kind: 'notice', message: 'Only tabs can be given to another session',
    });
    expect(planPaste({ text: 'https://pasted.test/a' }, intoDesktop, withRemote)).toEqual({
      kind: 'notice', message: 'Only tabs can be given to another session',
    });
    expect(planPaste(copiedRemote('copy', [sessionItem, tabItem(1)]), intoDesktop, withRemote)).toMatchObject({
      kind: 'notice',
    });
    expect(planPaste(copiedRemote('copy', [sessionItem]), { installationId: 'laptop', kind: 'session' }, withRemote))
      .toEqual({ kind: 'notice', message: 'That session already keeps those tabs' });
    expect(planPaste(copiedRemote('copy', [tabItem(1)]), { installationId: '', kind: 'session' }, withRemote))
      .toEqual({ kind: 'notice', message: 'Tabs kept before Hyper named its installations cannot take more' });
  });
});
