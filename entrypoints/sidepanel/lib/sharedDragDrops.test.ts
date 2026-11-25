import { describe, expect, it } from 'vitest';
import type { BookmarkNode } from '../../lib/bookmarks';
import { testTab } from '../../lib/testFixtures';
import type { SelectableDragItem } from '../types';
import {
  isSharedDragTab,
  sharedDragItems,
  sharedDragReferences,
  sharedDragStandInId,
  sharedDragToken,
  sharedTabsCanLand,
  sharedTabsDestination,
} from './sharedDragDrops';

const tab = (tabId: number): SelectableDragItem => ({
  bookmarkable: true,
  index: 0,
  kind: 'tab',
  tabId,
  title: 'Tab',
  windowId: 1,
});

describe('shared drag items', () => {
  it('offers tabs and bookmarks, but no drag holding a tab folder', () => {
    expect(sharedDragReferences([tab(7), { index: 0, kind: 'favourite', nodeId: 'fav', title: 'F' }]))
      .toEqual([{ kind: 'tab', tabId: 7 }, { kind: 'favourite', nodeId: 'fav' }]);
    expect(sharedDragReferences([tab(7), {
      depth: 0, index: 0, kind: 'tab-folder', nodeId: 'folder', parentId: 'root', title: 'Folder',
    }])).toBeUndefined();
    expect(sharedDragReferences([])).toBeUndefined();
  });

  it('drags another window\'s tabs as opaque stand-ins and its bookmarks as the rows here', () => {
    const docs: BookmarkNode = { id: 'docs', index: 3, parentId: 'shelf', syncing: false, title: 'Docs', url: 'https://docs.test/' };
    const shelf: BookmarkNode = { children: [docs], id: 'shelf', parentId: 'root', syncing: false, title: 'Shelf' };
    const items = sharedDragItems(
      { items: [{ kind: 'tab' }, { kind: 'tree', nodeId: 'shelf' }, { kind: 'favourite', nodeId: 'docs' }, { kind: 'tree', nodeId: 'gone' }], token: 't' },
      new Map([['docs', docs], ['shelf', shelf]]),
      [undefined, docs],
    );

    expect(items).toEqual([
      { bookmarkable: false, index: -1, kind: 'tab', tabId: -1, title: 'Tab', windowId: -1 },
      { depth: 0, index: 0, isFolder: true, kind: 'tree', nodeId: 'shelf', parentId: 'root', title: 'Shelf' },
      { index: 1, kind: 'favourite', nodeId: 'docs', title: 'Docs' },
    ]);
    expect(items.map(isSharedDragTab)).toEqual([true, false, false]);
    expect(isSharedDragTab(tab(7))).toBe(false);
    expect(sharedDragToken(sharedDragStandInId('t'))).toBe('t');
    expect(sharedDragToken('tab:7')).toBeUndefined();
  });
});

describe('shared tab destinations', () => {
  const destination = (
    target: Parameters<typeof sharedTabsDestination>[0]['target'],
    tabTreeDrop?: Parameters<typeof sharedTabsDestination>[0]['tabTreeDrop'],
  ) => sharedTabsDestination({
    realDestination: (place) => place,
    rootId: 'root',
    spaceId: 'space',
    spaceTabs: [testTab({ id: 1, index: 4 }), testTab({ id: 2, index: 6 })],
    tabTreeDrop,
    target,
  });

  it('puts tabs beside the row they were dropped on, in the tab strip and the tree', () => {
    const row = { bookmarkable: true, index: 6, kind: 'tab' as const, nodeId: 'b', tabId: 2, title: 'B', windowId: 1 };

    expect(destination(row, { destination: { index: 2, parentId: 'root' }, position: 'before' }))
      .toEqual({ index: 6, tree: { index: 2, parentId: 'root', spaceId: 'space' } });
    expect(destination(row, { destination: { index: 3, parentId: 'root' }, position: 'after' }))
      .toEqual({ index: 7, tree: { index: 3, parentId: 'root', spaceId: 'space' } });
    expect(destination(
      { depth: 0, index: 0, kind: 'tab-folder', nodeId: 'f', parentId: 'root', title: 'F' },
      { destination: { index: 0, parentId: 'f' }, position: 'inside' },
    )).toEqual({ index: 7, tree: { index: 0, parentId: 'f', spaceId: 'space' } });
    expect(destination(row)).toBeUndefined();
  });

  it('appends them to the list, to a space by its dot, and refuses every other place', () => {
    expect(destination({ kind: 'tabs-zone' })).toEqual({ index: 7, tree: { parentId: 'root', spaceId: 'space' } });
    expect(destination({ kind: 'tabs-trigger' })).toEqual({ index: 7, tree: { parentId: 'root', spaceId: 'space' } });
    expect(destination({ kind: 'space', spaceId: 'other' })).toEqual({ index: -1, tree: { spaceId: 'other' } });
    expect(destination({ kind: 'trash' })).toBeUndefined();
    expect(destination({ kind: 'tree-zone', parentId: 'bookmarks' })).toBeUndefined();
    expect([{ kind: 'trash' as const }, { kind: 'favourite-zone' as const }, { kind: 'bookmarks-trigger' as const }]
      .some(sharedTabsCanLand)).toBe(false);
  });
});
