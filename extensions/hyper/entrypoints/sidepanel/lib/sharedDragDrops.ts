import { visibleBookmarkTitle, type BookmarkNode, type BrowserTab } from '../../lib/bookmarks';
import type { MoveTabsPayload, SharedDragReference } from '../../lib/modelIntentPayloads';
import type { ProjectedSharedDrag } from '../../lib/sharedDrag';
import type { DragItemData, SelectableDragItem, TreeDropPosition } from '../types';

/** A drag shared from another window plays out on this draggable, named for its token. */
const STAND_IN_PREFIX = 'shared-drag:';

export function sharedDragStandInId(token: string): string {
  return `${STAND_IN_PREFIX}${token}`;
}

export function sharedDragToken(activeId: string | number): string | undefined {
  return typeof activeId === 'string' && activeId.startsWith(STAND_IN_PREFIX)
    ? activeId.slice(STAND_IN_PREFIX.length)
    : undefined;
}

/** What a drag holds, as another window's sidebar may take it; undefined when part of it cannot leave. */
export function sharedDragReferences(
  items: readonly SelectableDragItem[],
): SharedDragReference[] | undefined {
  const references = items.flatMap((item): SharedDragReference[] => {
    if (item.kind === 'tab') return [{ kind: 'tab', tabId: item.tabId }];
    if (item.kind === 'tree' || item.kind === 'favourite') return [{ kind: item.kind, nodeId: item.nodeId }];
    return [];
  });
  return references.length > 0 && references.length === items.length ? references : undefined;
}

/**
 * A shared drag as this sidebar drags it: bookmarks as the rows it already has,
 * and another window's tabs as opaque stand-ins that no intent ever names.
 */
export function sharedDragItems(
  drag: ProjectedSharedDrag,
  nodes: ReadonlyMap<string, BookmarkNode>,
  favouriteSlots: readonly (BookmarkNode | undefined)[],
): SelectableDragItem[] {
  return drag.items.flatMap((item, index): SelectableDragItem[] => {
    if (item.kind === 'tab') {
      return [{ bookmarkable: false, index: -1, kind: 'tab', tabId: -1 - index, title: 'Tab', windowId: -1 }];
    }
    const node = nodes.get(item.nodeId);
    if (!node) return [];
    const title = visibleBookmarkTitle(node) || node.url || 'Untitled folder';
    if (item.kind === 'favourite') {
      const slot = favouriteSlots.findIndex((slotNode) => slotNode?.id === node.id);
      return slot < 0 ? [] : [{ index: slot, kind: 'favourite', nodeId: node.id, title }];
    }
    return [{
      depth: 0,
      index: node.index ?? 0,
      isFolder: !node.url,
      kind: 'tree',
      nodeId: node.id,
      parentId: node.parentId ?? '',
      title,
    }];
  });
}

/** Another window's tab, which this sidebar knows only as part of a shared drag. */
export function isSharedDragTab(item: DragItemData | undefined): boolean {
  return item?.kind === 'tab' && item.windowId === -1;
}

/** Only the tab list and the space dots take tabs from another window. */
export function sharedTabsCanLand(target: DragItemData): boolean {
  return target.kind === 'tab' || target.kind === 'tab-folder' || target.kind === 'tabs-zone' ||
    target.kind === 'tabs-trigger' || target.kind === 'space';
}

/**
 * Where tabs dragged in from another window go: into this window at a tab strip
 * index, and into a space at a place in its tab tree. Only the tab list and the
 * space dots take them.
 */
export function sharedTabsDestination({
  realDestination,
  rootId,
  spaceId,
  spaceTabs,
  tabTreeDrop,
  target,
}: {
  realDestination(destination: { index?: number; parentId: string }): { index?: number; parentId: string };
  rootId: string;
  spaceId: string;
  spaceTabs: readonly BrowserTab[];
  tabTreeDrop?: { destination: { index?: number; parentId: string }; position: TreeDropPosition };
  target: DragItemData;
}): { index: number; tree: NonNullable<MoveTabsPayload['tree']> } | undefined {
  if (!sharedTabsCanLand(target)) return undefined;
  const afterSpace = spaceTabs.length > 0
    ? Math.max(...spaceTabs.map((tab) => tab.index)) + 1
    : -1;
  if (target.kind === 'space') return { index: -1, tree: { spaceId: target.spaceId } };
  if (target.kind === 'tabs-trigger') return { index: afterSpace, tree: { parentId: rootId, spaceId } };
  if (target.kind === 'tabs-zone') {
    return {
      index: afterSpace,
      tree: {
        spaceId,
        ...realDestination({
          parentId: target.parentId ?? rootId,
          ...(target.index === undefined ? {} : { index: target.index }),
        }),
      },
    };
  }
  if ((target.kind !== 'tab' && target.kind !== 'tab-folder') || !tabTreeDrop) return undefined;
  const index = target.kind === 'tab' && tabTreeDrop.position !== 'inside'
    ? target.index + (tabTreeDrop.position === 'after' ? 1 : 0)
    : afterSpace;
  return { index, tree: { spaceId, ...realDestination(tabTreeDrop.destination) } };
}
