import {
  containsNode,
  isBookmarkFolder,
  isBookmarkSeparator,
  type BookmarkNode,
  type Space,
} from '../../lib/bookmarks';
import type { DragItemData, TreeDropPosition } from '../types';
import { externalDropLands } from './externalDrop';

export type TreeDragSource = Extract<DragItemData, { kind: 'tree' }>;

/** Alt copies, and so do Ctrl and Cmd, as they do between sessions. */
export function isCopyModifierKey(key: string): boolean {
  return key === 'Alt' || key === 'Control' || key === 'Meta';
}

export function copyModifierHeld(event: { altKey: boolean; ctrlKey: boolean; metaKey: boolean }): boolean {
  return event.altKey || event.ctrlKey || event.metaKey;
}

/** Escape mid-drag goes only to the drag sensors, which listen on the document. */
export function confineDragEscape(event: KeyboardEvent): boolean {
  if (event.key !== 'Escape' || !event.isTrusted) return false;
  event.preventDefault();
  event.stopPropagation();
  document.dispatchEvent(new KeyboardEvent('keydown', { code: event.code, key: event.key }));
  return true;
}

export function bookmarkRootScopeDestination(
  source: Pick<TreeDragSource, 'parentId'>,
  target: Extract<DragItemData, { kind: 'space' }>,
): { parentId: string } | undefined {
  const parentId = target.rootId;
  if (!parentId) return undefined;
  return source.parentId === parentId ? undefined : { parentId };
}

/** The list a drag held over a space opens that space to: where its items land. */
export function spaceDragView(
  source: DragItemData | undefined,
): 'tabs' | 'bookmarks' | undefined {
  if (source?.kind === 'tree') return 'bookmarks';
  if (source?.kind === 'tab') return 'tabs';
  return undefined;
}

export function draggedFolderNodeId(
  source: DragItemData | undefined,
): string | undefined {
  if (source?.kind === 'tab-folder') return source.nodeId;
  return source?.kind === 'tree' && source.isFolder
    ? source.nodeId
    : undefined;
}

export type IndexedRootDropTarget = (
  Extract<DragItemData, { kind: 'tree-zone' }> |
  Extract<DragItemData, { kind: 'tabs-zone' }>
) & { parentId: string; index: number };

export function indexedRootDropTarget(
  target: DragItemData | undefined,
): target is IndexedRootDropTarget {
  return Boolean(
    target &&
    (target.kind === 'tree-zone' || target.kind === 'tabs-zone') &&
    typeof target.parentId === 'string' &&
    typeof target.index === 'number',
  );
}

export type TrashDropAction =
  | { kind: 'close-tab'; tabId: number; title: string }
  | { kind: 'close-session-tab'; nodeId: string; title: string }
  | { kind: 'remove-tab-folder'; nodeId: string; title: string }
  | { kind: 'remove-bookmark'; nodeId: string; title: string };

export interface TreeDropDestination {
  parentId: string;
  index?: number;
}

export function treeDropDestinationUnchanged(
  source: Pick<TreeProjectionSource, 'parentId' | 'index'>,
  destination: TreeDropDestination,
): boolean {
  return destination.parentId === source.parentId &&
    destination.index !== undefined &&
    (destination.index === source.index || destination.index === source.index + 1);
}

export function rootTreeDropDestination(
  source: Pick<TreeProjectionSource, 'parentId' | 'depth'>,
  destination: TreeDropDestination,
): TreeDropDestination {
  return source.depth === 0 && source.parentId !== destination.parentId
    ? { parentId: source.parentId }
    : destination;
}

export function spaceReorderAtIndexDestination(
  spaces: ReadonlyArray<Pick<Space, 'id'>>,
  sourceSpaceId: string,
  insertionIndex: number,
  parentId: string,
): TreeDropDestination | undefined {
  const sourceIndex = spaces.findIndex((space) => space.id === sourceSpaceId);
  if (
    sourceIndex < 0 ||
    insertionIndex < 0 ||
    insertionIndex > spaces.length ||
    insertionIndex === sourceIndex ||
    insertionIndex === sourceIndex + 1
  ) return undefined;
  return { parentId, index: insertionIndex };
}

export interface FlattenedTreeItem {
  node: BookmarkNode;
  nodeId: string;
  parentId: string;
  index: number;
  depth: number;
  isFolder: boolean;
  ancestorIds: string[];
}

export interface TreeProjectionSource {
  nodeId: string;
  parentId: string;
  index: number;
  depth: number;
  isFolder: boolean;
}

export interface ProjectedTreeDrop {
  destination: Required<TreeDropDestination>;
  depth: number;
  position: TreeDropPosition;
  indicatorNodeId?: string;
  unchanged?: boolean;
}

type DragTarget<Kind extends DragItemData['kind']> = Extract<DragItemData, { kind: Kind }>;

export function targetsFavourites(
  target: DragItemData | undefined,
): target is DragTarget<'favourite' | 'favourite-slot' | 'favourite-zone'> {
  return target?.kind === 'favourite' || target?.kind === 'favourite-slot' || target?.kind === 'favourite-zone';
}

export function targetsTabs(
  target: DragItemData | undefined,
): target is DragTarget<'tabs-trigger' | 'tab' | 'tabs-zone'> {
  return target?.kind === 'tabs-trigger' || target?.kind === 'tab' || target?.kind === 'tabs-zone';
}

/** Targets a drop turns into a bookmark: the tree, its trigger, and the global bookmarks. */
function targetsBookmarks(target: DragItemData): boolean {
  return target.kind === 'tree' || target.kind === 'tree-zone' ||
    target.kind === 'bookmarks-trigger' || target.kind === 'global-bookmarks';
}

export function bookmarkDropCopies(
  source: DragItemData,
  target: DragItemData,
  modifierActive: boolean,
): boolean {
  const targetsTree = target.kind === 'tree' || target.kind === 'tree-zone';
  if (source.kind === 'favourite') {
    return targetsTree || target.kind === 'space' || targetsTabs(target) || target.kind === 'global-bookmarks';
  }
  if (source.kind !== 'tree' || source.isFolder) return false;
  return targetsFavourites(target) || targetsTabs(target) ||
    ((targetsTree || target.kind === 'global-bookmarks') && modifierActive);
}

export function dragOverlayAction(
  source: DragItemData,
  target: DragItemData,
  modifierActive: boolean,
  forbidden = false,
): 'add' | 'delete' | 'forbidden' | undefined {
  if (forbidden) return 'forbidden';
  if (source.kind === 'external') return externalDropLands(target) ? 'add' : undefined;
  if (source.kind === 'session-tab') {
    if (target.kind === 'trash') return 'delete';
    // Dropped in the bookmarks it becomes a bookmark, moved or not.
    if (targetsBookmarks(target)) return 'add';
    return modifierActive ? 'add' : undefined;
  }
  if (target.kind === 'session-zone') {
    return modifierActive ? 'add' : undefined;
  }
  if (target.kind === 'trash') {
    if (source.kind === 'space') return 'delete';
    return trashDropAction(source) ? 'delete' : undefined;
  }
  if (source.kind === 'tree' && source.isFolder && targetsTabs(target)) return 'add';
  if (bookmarkDropCopies(source, target, modifierActive)) return 'add';
  if (source.kind === 'tab-folder') return targetsBookmarks(target) ? 'add' : undefined;
  if (source.kind !== 'tab' || !source.bookmarkable) return undefined;
  return targetsBookmarks(target) || targetsFavourites(target) ? 'add' : undefined;
}

function isForegroundDropTarget(
  target: DragItemData | undefined,
): boolean {
  return target?.kind === 'space' || target?.kind === 'space-archive' || target?.kind === 'trash' ||
    target?.kind === 'session-zone' || target?.kind === 'global-bookmarks';
}

export function prioritiseForegroundDropTargets<T>(
  candidates: T[],
  targetForCandidate: (candidate: T) => DragItemData | undefined,
): T[] {
  const foreground = candidates.filter((candidate) =>
    isForegroundDropTarget(targetForCandidate(candidate)));
  return foreground.length > 0 ? foreground : candidates;
}

export function excludeForegroundDropTargets<T>(
  candidates: T[],
  targetForCandidate: (candidate: T) => DragItemData | undefined,
): T[] {
  return candidates.filter((candidate) =>
    !isForegroundDropTarget(targetForCandidate(candidate)));
}

export function trashDropAction(
  source: DragItemData,
): TrashDropAction | undefined {
  if (source.kind === 'tab') {
    return { kind: 'close-tab', tabId: source.tabId, title: source.title };
  }
  if (source.kind === 'session-tab') {
    return { kind: 'close-session-tab', nodeId: source.nodeId, title: source.title };
  }
  if (source.kind === 'tab-folder') {
    if (source.virtual) return undefined;
    return {
      kind: 'remove-tab-folder',
      nodeId: source.nodeId,
      title: source.title,
    };
  }
  if (source.kind === 'tree' || source.kind === 'favourite') {
    return { kind: 'remove-bookmark', nodeId: source.nodeId, title: source.title };
  }
  return undefined;
}

export function projectedTreeDepth(
  sourceDepth: number,
  horizontalOffset: number,
  indentationWidth: number,
): number {
  if (!Number.isFinite(horizontalOffset) || indentationWidth <= 0) {
    return sourceDepth;
  }
  return Math.max(0, sourceDepth + Math.round(horizontalOffset / indentationWidth));
}

export function projectedExternalTreeDepth(
  entryDepth: number,
  horizontalOffset: number,
  entryHorizontalOffset: number,
  indentationWidth: number,
): number {
  return projectedTreeDepth(
    entryDepth,
    horizontalOffset - entryHorizontalOffset,
    indentationWidth,
  );
}

export function treeDropPointerPlacement(
  pointerY: number,
  targetTop: number,
  targetHeight: number,
  targetIsFolder: boolean,
  targetIsSource: boolean,
  projectedDepth: number,
  targetDepth: number,
): { dropAfter: boolean; dropAsChild: boolean } {
  const position = targetHeight > 0
    ? (pointerY - targetTop) / targetHeight
    : 0.5;
  const dropAsChild = targetIsFolder && !targetIsSource &&
    position >= 0.25 && position <= 0.75;
  return {
    dropAfter: dropAsChild
      ? true
      : position > (targetIsFolder ? 0.75 : 0.5),
    dropAsChild: dropAsChild || (
      position > 0.5 &&
      targetIsFolder &&
      !targetIsSource &&
      projectedDepth > targetDepth
    ),
  };
}

export function flattenVisibleTree(
  nodes: BookmarkNode[],
  rootId: string,
  collapsedIds: Set<string>,
  searching: boolean,
  depth = 0,
  ancestorIds: string[] = [],
): FlattenedTreeItem[] {
  return nodes.flatMap((node, localIndex) => {
    if (isBookmarkSeparator(node)) return [];
    const isFolder = isBookmarkFolder(node);
    const item: FlattenedTreeItem = {
      node,
      nodeId: node.id,
      parentId: node.parentId ?? rootId,
      index: node.index ?? localIndex,
      depth,
      isFolder,
      ancestorIds,
    };
    const children = isFolder && (!collapsedIds.has(node.id) || searching)
      ? flattenVisibleTree(
          node.children ?? [],
          rootId,
          collapsedIds,
          searching,
          depth + 1,
          [...ancestorIds, node.id],
        )
      : [];
    return [item, ...children];
  });
}

export function removeTreeDescendants(
  items: FlattenedTreeItem[],
  parentId: string,
): FlattenedTreeItem[] {
  return items.filter((item) => !item.ancestorIds.includes(parentId));
}

export function projectTreeDrop(
  items: FlattenedTreeItem[],
  source: TreeProjectionSource,
  overId: string,
  projectedDepth: number,
  dropAfter: boolean,
  rootId: string,
): ProjectedTreeDrop | undefined {
  const sourceItem = items.find((item) => item.nodeId === source.nodeId);
  if (sourceItem?.nodeId === overId) {
    return {
      destination: {
        parentId: source.parentId,
        index: source.index + (dropAfter ? 1 : 0),
      },
      depth: source.depth,
      position: dropAfter ? 'after' : 'before',
      unchanged: true,
    };
  }

  const candidates = removeTreeDescendants(items, source.nodeId)
    .filter((item) => item.nodeId !== source.nodeId);
  const overIndex = candidates.findIndex((item) => item.nodeId === overId);
  const overItem = candidates[overIndex];
  if (!overItem) return undefined;

  const insertAfter = dropAfter;
  const ancestorId = projectedDepth < overItem.depth
    ? overItem.ancestorIds[projectedDepth]
    : undefined;
  const ancestorIndex = ancestorId
    ? candidates.findIndex((item) => item.nodeId === ancestorId)
    : -1;
  let insertionIndex = ancestorIndex >= 0
    ? ancestorIndex + (insertAfter ? 1 : 0)
    : overIndex + (insertAfter ? 1 : 0);
  const subtreeRoot = candidates[ancestorIndex] ?? overItem;
  if (insertAfter && projectedDepth <= subtreeRoot.depth) {
    while (
      insertionIndex < candidates.length &&
      candidates[insertionIndex]?.ancestorIds.includes(subtreeRoot.nodeId)
    ) {
      insertionIndex += 1;
    }
  }
  const previousItem = candidates[insertionIndex - 1];
  const nextItem = candidates[insertionIndex];
  const maxDepth = previousItem
    ? previousItem.depth + (previousItem.isFolder ? 1 : 0)
    : 0;
  const minDepth = nextItem?.depth ?? 0;
  let depth = projectedDepth;
  if (projectedDepth >= maxDepth) depth = maxDepth;
  else if (projectedDepth < minDepth) depth = minDepth;

  let parentId = sourceItem?.depth === 0 ? source.parentId : rootId;
  if (depth > 0) {
    if (previousItem?.depth === depth) {
      parentId = previousItem.parentId;
    } else if (previousItem?.depth === depth - 1 && previousItem.isFolder) {
      parentId = previousItem.nodeId;
    } else {
      const parent = candidates
        .slice(0, insertionIndex)
        .reverse()
        .find((item) => item.depth === depth - 1 && item.isFolder);
      if (parent) parentId = parent.nodeId;
      else depth = 0;
    }
  }

  const position = parentId === overId
    ? 'inside'
    : insertAfter ? 'after' : 'before';
  const previousSibling = candidates
    .slice(0, insertionIndex)
    .findLast((item) => item.parentId === parentId);
  const nextSibling = candidates
    .slice(insertionIndex)
    .find((item) => item.parentId === parentId);
  const visibleIndex = candidates
    .slice(0, insertionIndex)
    .filter((item) => item.parentId === parentId)
    .length;
  const index = position === 'inside'
    ? 0
    : position === 'before' && nextSibling?.node.index !== undefined
      ? nextSibling.node.index
      : position === 'after' && previousSibling?.node.index !== undefined
        ? previousSibling.node.index + 1
        : sourceItem && source.parentId === parentId && visibleIndex > source.index
          ? visibleIndex + 1
          : visibleIndex;
  const indicatorNodeId = position === 'before'
    ? candidates[insertionIndex]?.nodeId
    : position === 'after'
      ? candidates[insertionIndex - 1]?.nodeId
      : undefined;
  const relocatedIndicatorNodeId = indicatorNodeId !== overId
    ? indicatorNodeId
    : undefined;
  const destination = { parentId, index };
  const staysAtCurrentLocation = sourceItem &&
    treeDropDestinationUnchanged(source, destination);

  return {
    destination,
    depth,
    position,
    ...(staysAtCurrentLocation ? { unchanged: true } : {}),
    ...(relocatedIndicatorNodeId
      ? { indicatorNodeId: relocatedIndicatorNodeId }
      : {}),
  };
}

export type PointerTreeDrop = ProjectedTreeDrop & { indicatorNodeId: string };

/**
 * Places a drop on a tree row from where the pointer sits on it, the same way
 * for bookmark and tab trees: the middle of a folder nests, its edges and every
 * other row insert beside it at the depth the drag has been pulled to.
 */
export function projectPointerTreeDrop({
  items,
  pointerY,
  projectedDepth,
  rootId,
  source,
  target,
  targetRect,
}: {
  items: FlattenedTreeItem[];
  pointerY: number;
  projectedDepth: number;
  rootId: string;
  source: TreeProjectionSource;
  target: { depth: number; isFolder: boolean; nodeId: string };
  targetRect: { height: number; top: number };
}): PointerTreeDrop | undefined {
  const { dropAfter, dropAsChild } = treeDropPointerPlacement(
    pointerY,
    targetRect.top,
    targetRect.height,
    target.isFolder,
    source.nodeId === target.nodeId,
    projectedDepth,
    target.depth,
  );
  const projection = projectTreeDrop(
    items,
    source,
    target.nodeId,
    dropAsChild ? target.depth + 1 : projectedDepth,
    dropAfter,
    rootId,
  );
  if (!projection) return undefined;
  return {
    ...projection,
    indicatorNodeId: dropAsChild
      ? target.nodeId
      : projection.indicatorNodeId ?? target.nodeId,
  };
}

export function isInvalidFolderDrop(
  source: TreeDragSource,
  sourceNode: BookmarkNode | undefined,
  destination: TreeDropDestination,
): boolean {
  if (!source.isFolder || !sourceNode) return false;
  return destination.parentId === source.nodeId ||
    containsNode(sourceNode, destination.parentId);
}