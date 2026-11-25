import { describe, expect, it } from 'vitest';
import { findBookmarkNode, type BookmarkNode, type BrowserTab } from '../../lib/bookmarks';
import {
  activateTabOptimistically,
  moveBookmarkOptimistically,
  moveTabsOptimistically,
  removeBookmarkOptimistically,
  removeTabsOptimistically,
  updateBookmarkOptimistically,
} from './backingOperations';
import { testTab } from '../../lib/testFixtures';

const tab = (
  id: number,
  windowId: number,
  index: number,
  active: boolean,
): BrowserTab => testTab({
  id,
  windowId,
  index,
  active,
  selected: active,
});

const tabs: BrowserTab[] = [
  tab(1, 7, 0, true),
  tab(2, 7, 1, false),
  tab(3, 7, 2, false),
  tab(4, 8, 0, true),
];

const bookmarkTree: BookmarkNode[] = [{
  id: 'root',
  title: 'root',
  syncing: false,
  children: [{
    id: 'bookmarks',
    parentId: 'root',
    index: 0,
    title: 'bookmarks',
    syncing: false,
    children: [
      { id: 'one', parentId: 'bookmarks', index: 0, title: 'One', url: 'https://one.test', syncing: false },
      {
        id: 'folder',
        parentId: 'bookmarks',
        index: 1,
        title: 'Folder',
        syncing: false,
        children: [{
          id: 'nested',
          parentId: 'folder',
          index: 0,
          title: 'Nested',
          url: 'https://nested.test',
          syncing: false,
        }],
      },
      { id: 'two', parentId: 'bookmarks', index: 2, title: 'Two', url: 'https://two.test', syncing: false },
    ],
  }],
}];

function childrenOf(tree: BookmarkNode[], nodeId: string): BookmarkNode[] {
  for (const node of tree) {
    if (node.id === nodeId) return node.children ?? [];
    const children = childrenOf(node.children ?? [], nodeId);
    if (children.length > 0) return children;
  }
  return [];
}

describe('optimistic tab operations', () => {
  it('activates the selected tab without changing another window', () => {
    const result = activateTabOptimistically(tabs, 2);
    expect(result.filter((tab) => tab.windowId === 7).map((tab) => tab.active))
      .toEqual([false, true, false]);
    expect(result.find((tab) => tab.id === 4)?.active).toBe(true);
  });

  it('removes several tabs as one indexed operation', () => {
    const removed = removeTabsOptimistically(tabs, [1, 3, 4]);
    expect(removed.map((tab) => [tab.id, tab.windowId, tab.index]))
      .toEqual([[2, 7, 0]]);
  });

  it('moves several tabs as one ordered block', () => {
    const moved = moveTabsOptimistically(tabs, [2, 1], 7, 1);

    expect(moved.filter((candidate) => candidate.windowId === 7)
      .sort((left, right) => left.index - right.index)
      .map((candidate) => candidate.id))
      .toEqual([3, 2, 1]);
  });
});

describe('optimistic bookmark operations', () => {
  it('converts the browser same-parent move index into final sibling order', () => {
    const moved = moveBookmarkOptimistically(
      bookmarkTree,
      'one',
      { parentId: 'bookmarks', index: 3 },
    );
    expect(childrenOf(moved, 'bookmarks').map((node) => [node.id, node.index]))
      .toEqual([['folder', 0], ['two', 1], ['one', 2]]);
  });

  it('moves a bookmark into a folder and preserves its subtree siblings', () => {
    const moved = moveBookmarkOptimistically(
      bookmarkTree,
      'two',
      { parentId: 'folder', index: 0 },
    );
    expect(childrenOf(moved, 'bookmarks').map((node) => node.id))
      .toEqual(['one', 'folder']);
    expect(childrenOf(moved, 'folder').map((node) => [node.id, node.index]))
      .toEqual([['two', 0], ['nested', 1]]);
  });

  it('leaves the tree unchanged when the destination parent is missing', () => {
    expect(moveBookmarkOptimistically(
      bookmarkTree,
      'one',
      { parentId: 'missing', index: 0 },
    )).toBe(bookmarkTree);
  });

  it('removes and updates bookmark nodes immediately', () => {
    const removed = removeBookmarkOptimistically(bookmarkTree, 'folder');
    expect(childrenOf(removed, 'bookmarks').map((node) => [node.id, node.index]))
      .toEqual([['one', 0], ['two', 1]]);

    const updated = updateBookmarkOptimistically(bookmarkTree, 'one', {
      title: 'Updated',
      url: 'https://updated.test',
    });
    expect(childrenOf(updated, 'bookmarks')[0]).toMatchObject({
      title: 'Updated',
      url: 'https://updated.test',
    });
    expect(findBookmarkNode(updated, 'one')?.title).toBe('Updated');

    const titleOnly = updateBookmarkOptimistically(bookmarkTree, 'one', {
      title: 'Title only',
    });
    expect(findBookmarkNode(titleOnly, 'one')?.url).toBe('https://one.test');
    expect(findBookmarkNode(titleOnly, 'two')).toBe(findBookmarkNode(bookmarkTree, 'two'));
  });
});
