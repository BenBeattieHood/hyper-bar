import { describe, expect, it } from 'vitest';
import {
  splitViewFolderBookmarkTitle,
  tabFolderBookmarkTitle,
  type BookmarkNode,
} from '../../lib/bookmarks';
import { testTab } from '../../lib/testFixtures';
import type { SelectableDragItem } from '../types';
import type { FlattenedTreeItem } from './drag';
import {
  pointerInSplitZone,
  splitDropAt,
  splitViewRows,
  type SplitRows,
} from './splitRows';

const page = (id: string, parentId = 'root', index = 0): BookmarkNode => ({
  id,
  index,
  parentId,
  syncing: false,
  title: id,
  url: `https://example.com/${id}`,
});

const folder = (
  id: string,
  children: BookmarkNode[],
  title = splitViewFolderBookmarkTitle(),
): BookmarkNode => ({ children, id, index: 0, parentId: 'root', syncing: false, title });

/** A folder's item followed by its children's, as the expanded tree lists them. */
const listed = (node: BookmarkNode, depth = 0, ancestorIds: string[] = []): FlattenedTreeItem[] => [
  {
    ancestorIds,
    depth,
    index: node.index ?? 0,
    isFolder: !node.url,
    node,
    nodeId: node.id,
    parentId: node.parentId ?? 'root',
  },
  ...(node.children ?? []).flatMap((child) => listed(child, depth + 1, [...ancestorIds, node.id])),
];

const noRows: SplitRows = { panesByRowId: new Map(), rowIdByPaneId: new Map() };

const tabsByNodeId = {
  a: testTab({ id: 1, index: 3, splitViewId: 7 }),
  b: testTab({ id: 2, index: 0, splitViewId: -1 }),
  c: testTab({ id: 3, index: 2, splitViewId: 7 }),
  d: testTab({ id: 4, index: 5, splitViewId: 8 }),
};

describe('split view rows', () => {
  it('draws a split view folder as one row of its panes, in pane order', () => {
    const pair = folder('pair', [page('c', 'pair', 0), page('a', 'pair', 1)]);
    const { items, rows } = splitViewRows(
      [...listed(page('b')), ...listed(pair), ...listed(page('d'))],
      tabsByNodeId,
      2,
    );

    expect(items.map((item) => [item.nodeId, item.isFolder])).toEqual([
      ['b', false],
      ['pair', false],
      ['d', false],
    ]);
    expect(rows.panesByRowId.get('pair')?.map((pane) =>
      [pane.nodeId, pane.depth, pane.parentId, pane.ancestorIds])).toEqual([
      ['c', 0, 'pair', ['pair']],
      ['a', 0, 'pair', ['pair']],
    ]);
    expect([...rows.rowIdByPaneId]).toEqual([['c', 'pair'], ['a', 'pair']]);
  });

  it('draws a collapsed or nested split view folder as a row at its own depth', () => {
    const pair = folder('pair', [page('a', 'pair', 0), page('c', 'pair', 1)]);
    const outer = folder('outer', [{ ...pair, parentId: 'outer' }], tabFolderBookmarkTitle('Outer'));
    const { items, rows } = splitViewRows(listed(outer), tabsByNodeId, 2);
    const [outerItem, pairItem] = listed(outer) as [FlattenedTreeItem, FlattenedTreeItem];
    const collapsed = splitViewRows([pairItem], tabsByNodeId, 2);

    expect(items).toEqual([outerItem, { ...pairItem, isFolder: false }]);
    expect(rows.panesByRowId.get('pair')?.map((pane) => [pane.depth, pane.ancestorIds]))
      .toEqual([[1, ['outer', 'pair']], [1, ['outer', 'pair']]]);
    expect(collapsed.rows.panesByRowId.get('pair')?.map((pane) => pane.nodeId)).toEqual(['a', 'c']);
  });

  it('shows a split view folder as a folder where its tabs cannot be panes', () => {
    const pairOf = (...children: BookmarkNode[]) => listed(folder('pair', children));
    const unchanged = (items: FlattenedTreeItem[], capacity = 2) =>
      expect(splitViewRows(items, tabsByNodeId, capacity)).toEqual({ items, rows: noRows });

    unchanged(pairOf(page('a', 'pair'), page('c', 'pair')), 0);
    unchanged(pairOf(page('a', 'pair'), page('c', 'pair'), page('b', 'pair')));
    unchanged(pairOf(page('a', 'pair'), folder('inner', [page('c', 'inner')])));
    unchanged(pairOf(page('a', 'pair')));
    unchanged(pairOf(page('a', 'pair'), page('closed', 'pair')));
    unchanged(listed(folder('plain', [page('a', 'plain'), page('c', 'plain')], tabFolderBookmarkTitle('Plain'))));
  });

  it('splits only from the right half of a row, clear of its edges', () => {
    const rect = { height: 36, left: 10, top: 100, width: 200 };

    expect(pointerInSplitZone({ x: 160, y: 118 }, rect)).toBe(true);
    expect(pointerInSplitZone({ x: 60, y: 118 }, rect)).toBe(false);
    expect(pointerInSplitZone({ x: 160, y: 103 }, rect)).toBe(false);
    expect(pointerInSplitZone({ x: 160, y: 133 }, rect)).toBe(false);
  });
});

describe('split drops', () => {
  const tabSource = (tabId: number): SelectableDragItem => ({
    bookmarkable: true,
    index: 0,
    kind: 'tab',
    tabId,
    title: 'Tab',
    windowId: 1,
  });
  const bookmark = (nodeId: string, isFolder = false): SelectableDragItem => ({
    depth: 0,
    index: 0,
    isFolder,
    kind: 'tree',
    nodeId,
    parentId: 'root',
    title: nodeId,
  });
  const drop = (overrides: Partial<Parameters<typeof splitDropAt>[0]> = {}) => splitDropAt({
    capacity: 2,
    nodeId: 'b',
    pointer: { x: 160, y: 118 },
    rect: { height: 36, left: 10, top: 100, width: 200 },
    rows: noRows,
    sources: [tabSource(4)],
    tab: tabsByNodeId.b,
    tabs: Object.values(tabsByNodeId),
    urlOf: (nodeId) => nodeId === 'folder' ? undefined : `https://example.com/${nodeId}`,
    ...overrides,
  });

  it('splits a tab with one dragged tab or one bookmark\'s page', () => {
    expect(drop()).toEqual({ nodeId: 'b', tabId: 2, withTabId: 4 });
    expect(drop({ sources: [bookmark('saved')] }))
      .toEqual({ nodeId: 'b', tabId: 2, url: 'https://example.com/saved' });
  });

  it('offers no split the browser cannot show', () => {
    expect(drop({ capacity: 0 })).toBeUndefined();
    expect(drop({ nodeId: 'a', tab: tabsByNodeId.a })).toBeUndefined();
    expect(drop({ sources: [tabSource(2)] })).toBeUndefined();
    expect(drop({ sources: [tabSource(4), tabSource(5)] })).toBeUndefined();
    expect(drop({ sources: [bookmark('folder', true)] })).toBeUndefined();
    expect(drop({ pointer: { x: 60, y: 118 } })).toBeUndefined();
  });

  it('counts a pane row\'s stored panes, whatever the browser shows yet', () => {
    const { rows } = splitViewRows(
      listed(folder('pair', [page('a', 'pair'), page('b', 'pair')])),
      tabsByNodeId,
      3,
    );

    expect(drop({ rows })).toBeUndefined();
    expect(drop({ capacity: 3, rows })).toEqual({ nodeId: 'b', tabId: 2, withTabId: 4 });
  });
});
