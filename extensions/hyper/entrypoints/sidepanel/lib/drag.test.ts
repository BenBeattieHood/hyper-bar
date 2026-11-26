import { describe, expect, it } from 'vitest';
import type { BookmarkNode } from '../../lib/bookmarks';
import type { DragItemData } from '../types';
import {
  bookmarkRootScopeDestination,
  bookmarkDropCopies,
  copyModifierHeld,
  dragOverlayAction,
  draggedFolderNodeId,
  excludeForegroundDropTargets,
  flattenVisibleTree,
  indexedRootDropTarget,
  isCopyModifierKey,
  isInvalidFolderDrop,
  prioritiseForegroundDropTargets,
  projectedExternalTreeDepth,
  projectedTreeDepth,
  projectPointerTreeDrop,
  projectTreeDrop,
  rootTreeDropDestination,
  spaceDragView,
  spaceReorderAtIndexDestination,
  treeDropDestinationUnchanged,
  removeTreeDescendants,
  treeDropPointerPlacement,
  trashDropAction,
  type TreeDragSource,
  type TreeProjectionSource,
} from './drag';
import { isItemClick, type ItemGestureSnapshot } from './itemGesture';

const bookmark = (overrides: Partial<TreeDragSource> = {}): TreeDragSource => ({
  kind: 'tree',
  nodeId: 'bookmark',
  title: 'Bookmark',
  parentId: 'root',
  index: 0,
  depth: 0,
  isFolder: false,
  ...overrides,
});
const folder = bookmark({ nodeId: 'folder', title: 'Folder', isFolder: true });
const tab = (overrides: Partial<Extract<DragItemData, { kind: 'tab' }>> = {}) => ({
  kind: 'tab' as const,
  tabId: 1,
  title: 'Tab',
  windowId: 1,
  index: 0,
  bookmarkable: true,
  ...overrides,
});
const tabFolder = (overrides: Partial<Extract<DragItemData, { kind: 'tab-folder' }>> = {}) => ({
  kind: 'tab-folder' as const,
  nodeId: 'folder',
  title: 'Folder',
  parentId: 'tabs',
  index: 0,
  depth: 0,
  ...overrides,
});
const favourite = { kind: 'favourite' as const, nodeId: 'favourite', title: 'Favourite', index: 0 };
const space = (spaceId: string, rootId = spaceId) => ({ kind: 'space' as const, spaceId, rootId });
const separator = (index?: number) => ({
  id: 'separator',
  parentId: 'root',
  ...(index === undefined ? {} : { index }),
  title: '',
  type: 'separator',
  syncing: false,
}) as BookmarkNode & { type: 'separator' };

describe('visible bookmark tree', () => {
  it('omits Firefox separators instead of treating them as folders', () => {
    expect(flattenVisibleTree([separator()], 'root', new Set(), false)).toEqual([]);
  });
});

describe('space pagination reordering', () => {
  const spaces = [{ id: 'one' }, { id: 'two' }, { id: 'three' }];

  it.each([['one', 3], ['three', 0]] as const)(
    'uses gaps as browser bookmark insertion indices (%s to %i)',
    (id, index) => {
      expect(spaceReorderAtIndexDestination(spaces, id, index, 'spaces'))
        .toEqual({ parentId: 'spaces', index });
    },
  );

  it.each([['two', 1], ['two', 2], ['missing', 0]] as const)(
    'ignores both gaps adjacent to the dragged space (%s at %i)',
    (id, index) => {
      expect(spaceReorderAtIndexDestination(spaces, id, index, 'spaces')).toBeUndefined();
    },
  );
});

describe('space drag views', () => {
  it('opens a space to the list the dragged items land in', () => {
    expect(spaceDragView(bookmark())).toBe('bookmarks');
    expect(spaceDragView(tab())).toBe('tabs');
  });

  it('opens nothing for drags that do not belong in a space list', () => {
    expect(spaceDragView(undefined)).toBeUndefined();
    expect(spaceDragView({ kind: 'space', spaceId: 's' })).toBeUndefined();
    expect(spaceDragView(favourite)).toBeUndefined();
    // A tab folder moves to another space only by its tabs, from the space's button.
    expect(spaceDragView(tabFolder({ parentId: 'root' }))).toBeUndefined();
  });
});

describe('unchanged tree destinations', () => {
  const source = { parentId: 'root', index: 2 };

  it.each([
    [{ parentId: 'root', index: 2 }, true],
    [{ parentId: 'root', index: 3 }, true],
    [{ parentId: 'other', index: 2 }, false],
    [{ parentId: 'root', index: 4 }, false],
    [{ parentId: 'root' }, false],
  ])('treats %o as unchanged: %s', (destination, unchanged) => {
    expect(treeDropDestinationUnchanged(source, destination)).toBe(unchanged);
  });
});

describe('root-end drop targets', () => {
  it.each<[DragItemData, boolean]>([
    [{ kind: 'tree-zone', parentId: 'bookmarks', index: 3 }, true],
    [{ kind: 'tabs-zone', parentId: 'tabs', index: 4 }, true],
    [{ kind: 'tree-zone', parentId: 'bookmarks' }, false],
    [{ kind: 'tabs-zone' }, false],
  ])('recognises only indexed zones: %o', (target, indexed) => {
    expect(indexedRootDropTarget(target)).toBe(indexed);
  });
});

describe('dragged folder identity', () => {
  it('recognises bookmark and tab folders but not their child items', () => {
    expect(draggedFolderNodeId(folder)).toBe('folder');
    expect(draggedFolderNodeId(tabFolder({ nodeId: 'tab-folder' }))).toBe('tab-folder');
    expect(draggedFolderNodeId(bookmark())).toBeUndefined();
  });
});

describe('bookmark copy policy', () => {
  const global = { kind: 'global-bookmarks' as const };
  const target = bookmark({ nodeId: 'target', index: 1 });

  it.each<[string, DragItemData, DragItemData, boolean, boolean]>([
    ['bookmark to favourite slot', bookmark(), { kind: 'favourite-slot', index: 0 }, false, true],
    ['favourite to tree zone', favourite, { kind: 'tree-zone', parentId: 'root' }, false, true],
    ['bookmark into a space', bookmark(), space('research'), false, false],
    ['favourite into a space', favourite, space('research'), false, true],
    ['favourite onto the Tabs trigger', favourite, { kind: 'tabs-trigger' }, false, true],
    ['bookmark into the tabs zone', bookmark(), { kind: 'tabs-zone' }, false, true],
    ['folder onto the Tabs trigger', folder, { kind: 'tabs-trigger' }, false, false],
    ['bookmark within the tree', bookmark(), target, false, false],
    ['bookmark within the tree with the modifier', bookmark(), target, true, true],
    ['favourite into global bookmarks', favourite, global, false, true],
    ['bookmark into global bookmarks', bookmark(), global, false, false],
    ['bookmark into global bookmarks with the modifier', bookmark(), global, true, true],
    ['folder into global bookmarks with the modifier', folder, global, true, false],
    ['folder into favourites', folder, { kind: 'favourite-zone' }, true, false],
    ['bookmark onto the trash', bookmark(), { kind: 'trash' }, true, false],
    ['favourite onto a favourite slot', favourite, { kind: 'favourite-slot', index: 1 }, true, false],
  ])('%s copies: %s', (_name, source, dropTarget, modifier, copies) => {
    expect(bookmarkDropCopies(source, dropTarget, modifier)).toBe(copies);
  });
});

describe('drag overlay action', () => {
  const sessionTab = { installationId: 'laptop', kind: 'session-tab' as const, nodeId: 'b1', title: 'B1' };
  const session = { installationId: 'desktop', kind: 'session-zone' as const };

  it.each<[string, DragItemData, DragItemData, boolean, ReturnType<typeof dragOverlayAction>]>([
    // A Plus when the source remains and the drop creates a target.
    ['bookmark onto Tabs', bookmark(), { kind: 'tabs-trigger' }, false, 'add'],
    ['tab onto Bookmarks', tab(), { kind: 'bookmarks-trigger' }, false, 'add'],
    ['tab into the tree', tab(), { kind: 'tree-zone', parentId: 'root' }, false, 'add'],
    ['tab folder into the tree', tabFolder(), { kind: 'tree-zone', parentId: 'root' }, false, 'add'],
    ['tab into global bookmarks', tab(), { kind: 'global-bookmarks' }, false, 'add'],
    // A Trash badge only for destructive drops.
    ['tab onto the trash', tab(), { kind: 'trash' }, false, 'delete'],
    ['bookmark onto the trash', bookmark(), { kind: 'trash' }, false, 'delete'],
    ['space onto the trash', space('space'), { kind: 'trash' }, false, 'delete'],
    // Moves and invalid add flows stay unbadged.
    ['folder into a space', folder, space('space'), false, undefined],
    ['tab into a space', tab(), space('other'), false, undefined],
    ['unbookmarkable tab onto Bookmarks', tab({ bookmarkable: false }), { kind: 'bookmarks-trigger' }, false, undefined],
    ['bookmark within the tree', bookmark(), bookmark({ nodeId: 'target', index: 1 }), false, undefined],
    // Tabs move between sessions, and a Plus shows only when Alt, Ctrl or Cmd copies them.
    ['tab into a session', tab(), session, false, undefined],
    ['tab copied into a session', tab(), session, true, 'add'],
    ['session tab into tabs', sessionTab, { kind: 'tabs-zone' }, false, undefined],
    ['session tab copied into tabs', sessionTab, { kind: 'tabs-zone' }, true, 'add'],
    // In the bookmarks it always becomes a bookmark; on the bin it closes.
    ['session tab into global bookmarks', sessionTab, { kind: 'global-bookmarks' }, false, 'add'],
    ['session tab into the tree', sessionTab, { kind: 'tree-zone', parentId: 'bookmarks' }, false, 'add'],
    ['session tab onto the trash', sessionTab, { kind: 'trash' }, false, 'delete'],
  ])('%s shows %s', (_name, source, target, modifier, action) => {
    expect(dragOverlayAction(source, target, modifier)).toBe(action);
  });

  it('uses a no-drop badge instead of another action for forbidden targets', () => {
    expect(dragOverlayAction(tab(), { kind: 'trash' }, false, true)).toBe('forbidden');
  });

  it('treats Alt, Ctrl and Cmd as copy modifiers', () => {
    for (const key of ['Alt', 'Control', 'Meta']) expect(isCopyModifierKey(key)).toBe(true);
    expect(isCopyModifierKey('Shift')).toBe(false);
    expect(copyModifierHeld({ altKey: false, ctrlKey: false, metaKey: true })).toBe(true);
    expect(copyModifierHeld({ altKey: false, ctrlKey: false, metaKey: false })).toBe(false);
  });
});

describe('drag tray policy', () => {
  it('keeps visible footer targets ahead of covered tree zones', () => {
    const collisions = [
      { id: 'tree', target: { kind: 'tree-zone' as const, parentId: 'work' } },
      { id: 'trash', target: { kind: 'trash' as const } },
      { id: 'space', target: space('other') },
    ];
    const targetOf = (collision: { target: DragItemData }) => collision.target;

    expect(prioritiseForegroundDropTargets(collisions, targetOf).map(({ id }) => id))
      .toEqual(['trash', 'space']);
    expect(prioritiseForegroundDropTargets(collisions.slice(0, 1), targetOf))
      .toEqual(collisions.slice(0, 1));
    expect(excludeForegroundDropTargets(collisions, targetOf).map(({ id }) => id))
      .toEqual(['tree']);
  });

  it.each<[DragItemData, ReturnType<typeof trashDropAction>]>([
    [tab({ tabId: 7, title: 'Draft' }), { kind: 'close-tab', tabId: 7, title: 'Draft' }],
    [favourite, { kind: 'remove-bookmark', nodeId: 'favourite', title: 'Favourite' }],
    [folder, { kind: 'remove-bookmark', nodeId: 'folder', title: 'Folder' }],
    [bookmark(), { kind: 'remove-bookmark', nodeId: 'bookmark', title: 'Bookmark' }],
    [
      { installationId: 'laptop', kind: 'session-tab', nodeId: 'b1', title: 'B1' },
      { kind: 'close-session-tab', nodeId: 'b1', title: 'B1' },
    ],
    [tabFolder({ virtual: true }), undefined],
    [space('work'), undefined],
  ])('maps only tabs and bookmark items to destructive actions: %o', (source, action) => {
    expect(trashDropAction(source)).toEqual(action);
  });
});

describe('tree drag depth', () => {
  it.each([
    [1, 7, 16, 1],
    [1, 8, 16, 2],
    [2, -16, 16, 1],
    [0, -64, 16, 0],
    // Without pointer geometry the source depth stays.
    [2, Number.NaN, 16, 2],
    [2, 32, 0, 2],
  ])('steps depth %i by offset %d at width %i to %i', (depth, offset, width, expected) => {
    expect(projectedTreeDepth(depth, offset, width)).toBe(expected);
  });

  it('measures external indentation from where the source entered the tree', () => {
    expect(projectedExternalTreeDepth(1, 240, 240, 16)).toBe(1);
    expect(projectedExternalTreeDepth(1, 256, 240, 16)).toBe(2);
    expect(projectedExternalTreeDepth(1, 224, 240, 16)).toBe(0);
  });

  it.each([
    ['keeps the upper edge before a folder even at child depth', 104, false, 1, false, false],
    ['uses the middle of a folder row as an explicit inside target', 118, false, 0, true, true],
    ['keeps the lower edge after a folder', 132, false, 0, true, false],
    ['nests at the lower edge of a folder when the pointer is indented', 132, false, 1, true, true],
    ['never treats the dragged folder itself as an inside target', 118, true, 1, false, false],
  ])('%s', (_name, pointerY, targetIsSource, depth, dropAfter, dropAsChild) => {
    expect(treeDropPointerPlacement(pointerY, 100, 36, true, targetIsSource, depth, 0))
      .toEqual({ dropAfter, dropAsChild });
  });
});

describe('tree drop intent', () => {
  it('rejects moving a folder into itself or one of its descendants', () => {
    const child: BookmarkNode = { id: 'child', parentId: 'source', title: 'Child', syncing: false, children: [] };
    const sourceNode: BookmarkNode = {
      id: 'source',
      parentId: 'root',
      title: 'Source',
      syncing: false,
      children: [child],
    };
    const source = bookmark({ nodeId: 'source', title: 'Source', isFolder: true });

    expect(isInvalidFolderDrop(source, sourceNode, { parentId: 'source' })).toBe(true);
    expect(isInvalidFolderDrop(source, sourceNode, { parentId: 'child' })).toBe(true);
    expect(isInvalidFolderDrop(source, sourceNode, { parentId: 'other' })).toBe(false);
  });
});

describe('sortable tree projection', () => {
  const node = (id: string, parentId: string, index: number, children?: BookmarkNode[]): BookmarkNode => ({
    id,
    parentId,
    index,
    title: id,
    syncing: false,
    ...(children ? { children } : { url: `https://example.com/${id}` }),
  });
  const alpha = node('alpha', 'root', 0, [node('alpha-one', 'alpha', 0), node('alpha-two', 'alpha', 1)]);
  const bookmarkNode = node('bookmark', 'root', 1);
  const omega = node('omega', 'root', 2, []);
  const items = flattenVisibleTree([alpha, bookmarkNode, omega], 'root', new Set(), false);
  const source = (
    nodeId: string,
    index: number,
    isFolder = false,
    parentId = 'root',
    depth = 0,
  ): TreeProjectionSource => ({ nodeId, parentId, index, depth, isFolder });
  const external = source('external', 3);
  const project = (
    from: TreeProjectionSource,
    overId: string,
    depth: number,
    dropAfter: boolean,
    list = items,
  ) => projectTreeDrop(list, from, overId, depth, dropAfter, 'root');
  const at = (parentId: string, index: number) => ({ parentId, index });

  it('flattens visible descendants with their depth and ancestry', () => {
    expect(items.map(({ nodeId, depth, ancestorIds }) => ({ nodeId, depth, ancestorIds })))
      .toEqual([
        { nodeId: 'alpha', depth: 0, ancestorIds: [] },
        { nodeId: 'alpha-one', depth: 1, ancestorIds: ['alpha'] },
        { nodeId: 'alpha-two', depth: 1, ancestorIds: ['alpha'] },
        { nodeId: 'bookmark', depth: 0, ancestorIds: [] },
        { nodeId: 'omega', depth: 0, ancestorIds: [] },
      ]);
  });

  it('omits collapsed descendants outside search', () => {
    expect(flattenVisibleTree([alpha, bookmarkNode], 'root', new Set(['alpha']), false)
      .map(({ nodeId }) => nodeId)).toEqual(['alpha', 'bookmark']);
    expect(flattenVisibleTree([alpha], 'root', new Set(['alpha']), true)
      .map(({ nodeId }) => nodeId)).toEqual(['alpha', 'alpha-one', 'alpha-two']);
  });

  it('preserves hidden separator indices when projecting visible siblings', () => {
    const separatedItems = flattenVisibleTree([
      { ...alpha, index: 0 },
      separator(1),
      { ...bookmarkNode, index: 2 },
      { ...omega, index: 3 },
    ], 'root', new Set(), false);
    const destination = (from: TreeProjectionSource, overId: string, dropAfter: boolean) =>
      project(from, overId, 0, dropAfter, separatedItems)?.destination;

    expect(destination(source('external', 4), 'alpha', true)).toEqual(at('root', 1));
    expect(destination(source('external', 4), 'bookmark', false)).toEqual(at('root', 2));
    expect(destination(source('alpha', 0, true), 'omega', true)).toEqual(at('root', 4));
    expect(destination(source('omega', 3, true), 'bookmark', false)).toEqual(at('root', 2));
  });

  it('preserves a local root folder parent while reordering it', () => {
    const mixedItems = flattenVisibleTree(
      [alpha, node('local-alpha', 'space-work', 0, []), node('local-omega', 'space-work', 1, [])],
      'root',
      new Set(),
      false,
    );

    expect(project(source('local-omega', 1, true, 'space-work'), 'local-alpha', 0, false, mixedItems)
      ?.destination).toEqual(at('space-work', 0));
  });

  it('moves bookmarks and folders between space roots', () => {
    const work = space('space-work', 'space-work-bookmarks');
    expect(bookmarkRootScopeDestination({ parentId: 'space-home-bookmarks' }, work))
      .toEqual({ parentId: 'space-work-bookmarks' });
    expect(bookmarkRootScopeDestination({ parentId: 'space-work-bookmarks' }, work)).toBeUndefined();
    expect(bookmarkRootScopeDestination({ parentId: 'nested-folder' }, work))
      .toEqual({ parentId: 'space-work-bookmarks' });
  });

  it('preserves each selected local root parent at the root-end target', () => {
    const destination = at('root', 4);

    expect(rootTreeDropDestination({ parentId: 'space-work', depth: 0 }, destination))
      .toEqual({ parentId: 'space-work' });
    expect(rootTreeDropDestination({ parentId: 'nested-folder', depth: 1 }, destination))
      .toEqual(destination);
    expect(rootTreeDropDestination({ parentId: 'root', depth: 0 }, destination))
      .toEqual(destination);
  });

  it('preserves mixed root ownership for either row-target scope', () => {
    const global = { parentId: 'root', depth: 0 };
    const local = { parentId: 'space-work', depth: 0 };

    expect(rootTreeDropDestination(global, at('root', 1))).toEqual(at('root', 1));
    expect(rootTreeDropDestination(local, at('root', 2))).toEqual({ parentId: 'space-work' });
    expect(rootTreeDropDestination(global, at('space-work', 1))).toEqual({ parentId: 'root' });
    expect(rootTreeDropDestination(local, at('space-work', 2))).toEqual(at('space-work', 2));
  });

  it('removes a dragged folder descendants from the sortable sequence', () => {
    expect(removeTreeDescendants(items, 'alpha').map(({ nodeId }) => nodeId))
      .toEqual(['alpha', 'bookmark', 'omega']);
  });

  it.each<[string, TreeProjectionSource, string, number, boolean, object]>([
    ['projects an indented row as the first child of a folder',
      source('bookmark', 1), 'alpha', 1, true,
      { destination: at('alpha', 0), depth: 1, position: 'inside' }],
    ['enters the tree as a sibling after a row',
      external, 'omega', 0, true,
      { destination: at('root', 3), depth: 0, position: 'after' }],
    ['enters the tree as a child of an indented folder',
      external, 'omega', 1, true,
      { destination: at('omega', 0), depth: 1, position: 'inside' }],
    ['drops before an expanded folder',
      external, 'alpha', 0, false,
      { destination: at('root', 0), depth: 0, position: 'before' }],
    ['drops after an expanded folder subtree',
      external, 'alpha', 0, true,
      { destination: at('root', 1), depth: 0, position: 'after', indicatorNodeId: 'alpha-two' }],
    ['drops inside an expanded folder',
      external, 'alpha', 1, true,
      { destination: at('alpha', 0), depth: 1, position: 'inside' }],
    ['snaps a shallower drop before a descendant to its subtree start',
      external, 'alpha-one', 0, false,
      { destination: at('root', 0), depth: 0, position: 'before', indicatorNodeId: 'alpha' }],
    ['snaps a shallower drop after a descendant to its subtree end',
      external, 'alpha-one', 0, true,
      { destination: at('root', 1), depth: 0, position: 'after', indicatorNodeId: 'alpha-two' }],
    ['clamps a row beside a bookmark and marks an unchanged result',
      source('omega', 2, true), 'bookmark', 3, true,
      { destination: at('root', 2), depth: 0, position: 'after', unchanged: true }],
    ['marks dropping before itself unchanged',
      source('bookmark', 1), 'bookmark', 0, false,
      { destination: at('root', 1), depth: 0, position: 'before', unchanged: true }],
    ['marks dropping after the previous sibling unchanged',
      source('bookmark', 1), 'alpha', 0, true,
      { destination: at('root', 1), depth: 0, position: 'after', indicatorNodeId: 'alpha-two', unchanged: true }],
    ['marks dropping before the next sibling unchanged',
      source('bookmark', 1), 'omega', 0, false,
      { destination: at('root', 2), depth: 0, position: 'before', unchanged: true }],
    ['removes descendants while projecting a folder move',
      source('alpha', 0, true), 'omega', 0, true,
      { destination: at('root', 3), depth: 0, position: 'after' }],
    ['projects a nested child back to the space root',
      source('alpha-two', 1, false, 'alpha', 1), 'bookmark', 0, false,
      { destination: at('root', 1), depth: 0, position: 'before' }],
  ])('%s', (_name, from, overId, depth, dropAfter, expected) => {
    expect(project(from, overId, depth, dropAfter)).toEqual(expected);
  });

  it.each(['alpha-one', 'copy:alpha-one'])('preserves nested browser indexes for %s', (nodeId) => {
    expect(project(source(nodeId, 0, false, 'alpha', 1), 'alpha-two', 1, true)).toEqual({
      destination: at('alpha', 2),
      depth: 1,
      position: 'after',
    });
  });

  it.each([
    [102, { destination: at('root', 0), depth: 0, indicatorNodeId: 'alpha', position: 'before' }],
    [120, { destination: at('alpha', 0), depth: 1, indicatorNodeId: 'alpha', position: 'inside' }],
    [138, { destination: at('root', 1), depth: 0, indicatorNodeId: 'alpha-two', position: 'after' }],
  ])('places a pointer drop at %i on a folder row by where it sits', (pointerY, expected) => {
    expect(projectPointerTreeDrop({
      items,
      pointerY,
      projectedDepth: 0,
      rootId: 'root',
      source: external,
      target: { depth: 0, isFolder: true, nodeId: 'alpha' },
      targetRect: { height: 40, top: 100 },
    })).toEqual(expected);
  });
});

describe('item click gesture', () => {
  const start: ItemGestureSnapshot = { time: 100, pointerX: 20, pointerY: 30, selectionModified: false };
  const end = (overrides: Partial<ItemGestureSnapshot> = {}): ItemGestureSnapshot => ({
    ...start,
    time: 899,
    ...overrides,
  });

  it.each<[string, ItemGestureSnapshot, ItemGestureSnapshot, boolean]>([
    ['accepts a short press without movement', start, end(), true],
    ['rejects a press held for 800ms or longer', start, end({ time: 900 }), false],
    ['accepts movement up to three pixels', start, end({ pointerX: 23 }), true],
    ['rejects pointer movement beyond three pixels', start, end({ pointerX: 23.01 }), false],
    ['rejects a selection-modified start', { ...start, selectionModified: true }, end(), false],
    ['rejects a selection-modified end', start, end({ selectionModified: true }), false],
  ])('%s', (_name, from, to, click) => {
    expect(isItemClick(from, to)).toBe(click);
  });
});
