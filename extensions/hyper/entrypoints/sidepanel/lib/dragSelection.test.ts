import { describe, expect, it } from 'vitest';
import {
  dragSelectionCount,
  dragSelectionId,
  isLiftedRow,
  isSelectableDragItem,
  liftedDragNodeIds,
  replaceDragSelection,
  topLevelDragSelection,
  updateDragSelection,
  type DragSelectionState,
} from './dragSelection';
import type { SelectableDragItem } from '../types';

const bookmarks: SelectableDragItem[] = [
  {
    kind: 'tree',
    nodeId: 'folder',
    title: 'Folder',
    parentId: 'root',
    index: 0,
    depth: 0,
    isFolder: true,
    itemCount: 3,
  },
  {
    kind: 'tree',
    nodeId: 'child',
    title: 'Child',
    parentId: 'folder',
    index: 0,
    depth: 1,
    isFolder: false,
    ancestorIds: ['folder'],
  },
  {
    kind: 'tree',
    nodeId: 'last',
    title: 'Last',
    parentId: 'root',
    index: 1,
    depth: 0,
    isFolder: false,
  },
];

describe('drag selection', () => {
  it('toggles individual items and selects contiguous ranges', () => {
    let selection: DragSelectionState = { items: [] };
    selection = updateDragSelection(selection, bookmarks[0]!, bookmarks, {
      range: false,
      toggle: true,
    });
    selection = updateDragSelection(selection, bookmarks[2]!, bookmarks, {
      range: true,
      toggle: false,
    });
    expect(selection.items.map(dragSelectionId)).toEqual([
      'tree:folder',
      'tree:child',
      'tree:last',
    ]);
  });

  it('keeps a group when a selected item starts a plain drag', () => {
    const selection: DragSelectionState = {
      anchorId: 'tree:folder',
      items: [bookmarks[0]!, bookmarks[2]!],
      scope: 'bookmarks',
    };
    expect(updateDragSelection(selection, bookmarks[2]!, bookmarks, {
      range: false,
      toggle: false,
    })).toBe(selection);
  });

  it('starts a new selection when the source family changes', () => {
    const tab: SelectableDragItem = {
      kind: 'tab',
      tabId: 7,
      title: 'Tab',
      windowId: 1,
      index: 0,
      bookmarkable: true,
    };
    const selection = updateDragSelection(
      { anchorId: 'tree:folder', items: bookmarks, scope: 'bookmarks' },
      tab,
      [tab],
      { range: false, toggle: false },
    );
    expect(selection).toEqual({ anchorId: 'tab:7', items: [tab], scope: 'tabs' });
  });

  it('replaces a selection with unique items from one scope', () => {
    expect(replaceDragSelection([
      bookmarks[0]!,
      bookmarks[2]!,
      bookmarks[0]!,
    ])).toEqual({
      anchorId: 'tree:last',
      items: [bookmarks[0], bookmarks[2]],
      scope: 'bookmarks',
    });
    expect(replaceDragSelection([])).toEqual({ items: [] });
  });

  it('omits selected descendants from operations without undercounting folders', () => {
    expect(topLevelDragSelection(bookmarks).map(dragSelectionId)).toEqual([
      'tree:folder',
      'tree:last',
    ]);
    expect(dragSelectionCount(bookmarks)).toBe(4);
  });

  it('normalizes mixed tab rows and folders to top-level operations', () => {
    const tabItems: SelectableDragItem[] = [
      {
        kind: 'tab-folder',
        nodeId: 'tab-folder',
        title: 'Tab folder',
        parentId: 'tabs-root',
        index: 0,
        depth: 0,
        itemCount: 3,
      },
      {
        kind: 'tab',
        tabId: 8,
        title: 'Nested tab',
        windowId: 1,
        index: 0,
        bookmarkable: true,
        ancestorIds: ['tab-folder'],
      },
      {
        kind: 'tab',
        tabId: 9,
        title: 'Root tab',
        windowId: 1,
        index: 1,
        bookmarkable: true,
      },
    ];

    expect(topLevelDragSelection(tabItems).map(dragSelectionId)).toEqual([
      'tab-folder:tab-folder',
      'tab:9',
    ]);
    expect(dragSelectionCount(tabItems)).toBe(4);
  });

  it('keeps other sessions\u2019 tabs in a selection of their own', () => {
    const remote: SelectableDragItem = { installationId: 'laptop', kind: 'session-tab', nodeId: 'r1', title: 'R1' };
    const other: SelectableDragItem = { installationId: 'desktop', kind: 'session-tab', nodeId: 'r2', title: 'R2' };
    expect(isSelectableDragItem(remote)).toBe(true);
    expect(dragSelectionId(remote)).toBe('session-tab:r1');
    let selection = updateDragSelection({ items: [] }, remote, [remote, other], { range: false, toggle: false });
    selection = updateDragSelection(selection, other, [remote, other], { range: false, toggle: true });
    expect(selection).toMatchObject({ items: [remote, other], scope: 'sessions' });
    expect(updateDragSelection(selection, bookmarks[2]!, bookmarks, { range: false, toggle: true }))
      .toMatchObject({ items: [bookmarks[2]], scope: 'bookmarks' });
  });

  it('does not admit spaces to multi-selection', () => {
    expect(isSelectableDragItem({
      kind: 'space',
      spaceId: 'space',
      rootId: 'root',
    })).toBe(false);
  });

  it('lifts the rest of the selection with a grabbed selected row, and nothing with any other', () => {
    const selected = new Set(['tree:folder', 'tree:last']);

    expect([...liftedDragNodeIds(bookmarks, selected, 'last')]).toEqual(['folder']);
    expect([...liftedDragNodeIds(bookmarks, selected, 'child')]).toEqual([]);
    expect([...liftedDragNodeIds(bookmarks, selected, undefined)]).toEqual([]);
    const lifted = liftedDragNodeIds(bookmarks, selected, 'last');
    expect(isLiftedRow({ ancestorIds: ['folder'], nodeId: 'child' }, lifted)).toBe(true);
    expect(isLiftedRow({ ancestorIds: [], nodeId: 'last' }, lifted)).toBe(false);
  });
});