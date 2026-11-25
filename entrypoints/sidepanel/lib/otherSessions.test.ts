import { describe, expect, it } from 'vitest';
import {
  serializeBookmarkTitle,
  tabBackingBookmarkTitle,
  tabFolderBookmarkTitle,
  type BookmarkNode,
} from '../../lib/bookmarks';
import type { DragItemData, SelectableDragItem } from '../types';
import {
  otherSessions,
  sessionDropRefused,
  sessionTabFolders,
  sessionTabMoves,
  sessionTabsIn,
} from './otherSessions';

const folder = (id: string, title: string, parentId: string, children: BookmarkNode[]): BookmarkNode =>
  ({ children, id, parentId, syncing: false, title });

const backing = (
  id: string,
  spaceId: string,
  installationId: string | undefined,
  dateAdded: number,
): BookmarkNode => ({
  dateAdded,
  id,
  parentId: `${spaceId}-tabs`,
  syncing: false,
  title: tabBackingBookmarkTitle(id, 0, `token-${id}`, spaceId, undefined, {
    ...(installationId ? { installationId } : {}),
  }),
  url: `https://${id}.example.com/`,
});

function hyperTree(tabsBySpace: Record<string, BookmarkNode[]>): BookmarkNode[] {
  const spaces = Object.entries(tabsBySpace).map(([spaceId, tabs]) => folder(spaceId, spaceId, 'spaces', [
    folder(`${spaceId}-tabs`, serializeBookmarkTitle('tabs', { hyper: { spaceTabs: true } }), spaceId, tabs),
  ]));
  return [folder('0', '', '', [folder('1', 'Bookmarks bar', '0', [folder('hyper', 'hyper', '1', [
    folder('favourites', 'favourites', 'hyper', []),
    folder('spaces', 'spaces', 'hyper', spaces),
  ])])])];
}

describe('other sessions', () => {
  const tree = hyperTree({
    green: [
      backing('mine', 'green', 'local', 5_000),
      folder('filed', tabFolderBookmarkTitle('Filed'), 'green-tabs', [
        backing('nested', 'green', 'laptop', 1_000),
      ]),
      backing('laptop-tab', 'green', 'laptop', 2_000),
      backing('ancient', 'green', undefined, 100),
    ],
    blue: [
      backing('desktop-tab', 'blue', 'desktop', 4_000),
      backing('laptop-elsewhere', 'blue', 'laptop', 3_000),
    ],
  });

  it('gathers every other installation\'s tabs in the space, the most recently active first', () => {
    expect(otherSessions(tree, 'green', 'local').map(({ id, lastKeptAt, tabs }) => ({
      id,
      lastKeptAt,
      tabs: tabs.map((node) => node.id),
    }))).toEqual([
      { id: 'desktop', lastKeptAt: 4_000, tabs: [] },
      { id: 'laptop', lastKeptAt: 3_000, tabs: ['nested', 'laptop-tab'] },
      { id: '', lastKeptAt: 100, tabs: ['ancient'] },
    ]);
  });

  it('shows none until this installation is known', () => {
    expect(otherSessions(tree, 'green', undefined)).toEqual([]);
  });

  it('gathers a session\'s tabs into a folder per site, where each site first appears', () => {
    const page = (id: string, url: string): BookmarkNode => ({ ...backing(id, 'green', 'laptop', 1_000), url });

    const folders = sessionTabFolders([
      page('docs', 'https://www.docs.test/a'),
      page('mail', 'https://mail.test/'),
      page('docs-b', 'https://docs.test/b'),
      page('blank', 'about:blank'),
    ]);

    expect(folders.map((node) => [node.title, node.children?.map((child) => child.id)])).toEqual([
      ['docs.test', ['docs', 'docs-b']],
      ['mail.test', ['mail']],
      ['about:', ['blank']],
    ]);
  });
});

describe('drops between sessions', () => {
  const sessionTab: DragItemData = { installationId: 'laptop', kind: 'session-tab', nodeId: 'b1', title: 'B1' };
  const tab = (tabId: number, backingId?: string): Extract<DragItemData, { kind: 'tab' }> => ({
    bookmarkable: true,
    index: tabId,
    kind: 'tab',
    tabId,
    title: `Tab ${tabId}`,
    windowId: 1,
    ...(backingId ? { backingId } : {}),
  });
  const zone = (installationId: string): DragItemData => ({ installationId, kind: 'session-zone' });
  const windowDestination = { index: 2, tree: { index: 0, parentId: 'green-tabs', spaceId: 'green' } };

  it('takes another session\'s tab into this window\'s tabs, the bookmarks, the bin or another session, and nowhere else', () => {
    expect(sessionDropRefused(sessionTab, { kind: 'tabs-zone', parentId: 'green-tabs', index: 0 }, [])).toBe(false);
    expect(sessionDropRefused(sessionTab, zone('desktop'), [])).toBe(false);
    expect(sessionDropRefused(sessionTab, { kind: 'tree-zone', parentId: 'bookmarks' }, [])).toBe(false);
    expect(sessionDropRefused(sessionTab, { kind: 'trash' }, [])).toBe(false);
    expect(sessionDropRefused(sessionTab, { kind: 'space', spaceId: 'blue' }, [])).toBe(true);
    expect(sessionDropRefused(sessionTab, { index: 0, kind: 'favourite-slot' }, [])).toBe(true);
    expect(sessionTabMoves({ copy: false, selected: [], source: sessionTab, target: zone('desktop') }))
      .toEqual([{ copy: false, destination: { installationId: 'desktop' }, source: { backingId: 'b1' } }]);
    expect(sessionTabMoves({ copy: true, selected: [], source: sessionTab, target: tab(5, 'b5'), windowDestination }))
      .toEqual([{ copy: true, destination: windowDestination, source: { backingId: 'b1' } }]);
    expect(sessionTabMoves({ copy: false, selected: [], source: sessionTab, target: zone('laptop') })).toEqual([]);
    // The bin closes them, which is not a move between sessions.
    expect(sessionTabMoves({ copy: false, selected: [], source: sessionTab, target: { kind: 'trash' } })).toBeUndefined();
  });

  it('makes bookmarks of another session\'s tabs dropped in the bookmarks, each after the one before', () => {
    const selection: SelectableDragItem[] = [
      { installationId: 'laptop', kind: 'session-tab', nodeId: 'b1', title: 'B1' },
      { installationId: 'desktop', kind: 'session-tab', nodeId: 'b2', title: 'B2' },
    ];
    const target: DragItemData = { index: 3, kind: 'tree-zone', parentId: 'bookmarks' };
    expect(sessionTabMoves({
      bookmarkDestination: { index: 3, parentId: 'bookmarks' }, copy: true, selected: selection, source: sessionTab, target,
    })).toEqual([
      { copy: true, destination: { bookmarks: { index: 3, parentId: 'bookmarks' } }, source: { backingId: 'b1' } },
      { copy: true, destination: { bookmarks: { index: 4, parentId: 'bookmarks' } }, source: { backingId: 'b2' } },
    ]);
    expect(sessionTabMoves({
      bookmarkDestination: { parentId: 'global' }, copy: false, selected: [], source: sessionTab, target: { kind: 'global-bookmarks' },
    })).toEqual([{ copy: false, destination: { bookmarks: { parentId: 'global' } }, source: { backingId: 'b1' } }]);
    // Without a folder to land in, nothing moves.
    expect(sessionTabMoves({ copy: false, selected: [], source: sessionTab, target })).toEqual([]);
  });

  it('carries the selection only when it holds the tab grabbed', () => {
    const other: SelectableDragItem = { installationId: 'laptop', kind: 'session-tab', nodeId: 'b9', title: 'B9' };
    const selection: SelectableDragItem[] = [other, tab(1, 'b1-local')];
    expect(sessionTabsIn(sessionTab, selection)).toEqual([sessionTab]);
    expect(sessionTabsIn(other, selection)).toEqual([other]);
    expect(sessionTabsIn(tab(1), selection)).toEqual([]);
  });

  it('places several tabs taken into this window one after another', () => {
    const selection: SelectableDragItem[] = [
      { installationId: 'laptop', kind: 'session-tab', nodeId: 'b1', title: 'B1' },
      { installationId: 'laptop', kind: 'session-tab', nodeId: 'b2', title: 'B2' },
    ];
    expect(sessionTabMoves({
      copy: false, selected: selection, source: sessionTab, target: tab(5, 'b5'), windowDestination,
    })?.map((move) => move.destination)).toEqual([
      windowDestination,
      { index: 3, tree: { index: 1, parentId: 'green-tabs', spaceId: 'green' } },
    ]);
  });

  it('gives a session this window\'s backed tabs only, and only a session with an ID', () => {
    const selection = [tab(1, 'b1'), tab(2, 'b2')];
    expect(sessionTabMoves({ copy: true, selected: selection, source: selection[0]!, target: zone('laptop') }))
      .toEqual([1, 2].map((tabId) => ({ copy: true, destination: { installationId: 'laptop' }, source: { tabId } })));
    expect(sessionDropRefused(tab(3), zone('laptop'), [])).toBe(true);
    expect(sessionDropRefused(tab(1, 'b1'), zone(''), [])).toBe(true);
    const folderItem: DragItemData = {
      depth: 0, index: 0, kind: 'tab-folder', nodeId: 'f', parentId: 'green-tabs', title: 'F',
    };
    expect(sessionTabMoves({ copy: false, selected: [], source: folderItem, target: zone('laptop') })).toEqual([]);
    expect(sessionTabMoves({ copy: false, selected: [], source: tab(1, 'b1'), target: tab(2, 'b2') })).toBeUndefined();
  });
});
