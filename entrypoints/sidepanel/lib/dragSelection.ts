import type { SelectableDragItem } from '../types';

export type DragSelectionScope = 'bookmarks' | 'favourites' | 'sessions' | 'tabs';

export interface DragSelectionState {
  anchorId?: string;
  items: SelectableDragItem[];
  scope?: DragSelectionScope;
}

export interface DragSelectionModifiers {
  range: boolean;
  toggle: boolean;
}

export function isSelectableDragItem(
  item: unknown,
): item is SelectableDragItem {
  if (!item || typeof item !== 'object' || !('kind' in item)) return false;
  const kind = (item as { kind?: string }).kind;
  return kind === 'tree' || kind === 'favourite' || kind === 'tab' ||
    kind === 'tab-folder' || kind === 'session-tab';
}

export function dragSelectionId(item: SelectableDragItem): string {
  if (item.kind === 'tab') return `tab:${item.tabId}`;
  return `${item.kind}:${item.nodeId}`;
}

export function dragSelectionScope(
  item: SelectableDragItem,
): DragSelectionScope {
  if (item.kind === 'tab' || item.kind === 'tab-folder') return 'tabs';
  // Other sessions' tabs act together, never with this window's.
  if (item.kind === 'session-tab') return 'sessions';
  return item.kind === 'favourite' ? 'favourites' : 'bookmarks';
}

export function updateDragSelection(
  current: DragSelectionState,
  source: SelectableDragItem,
  orderedItems: readonly SelectableDragItem[],
  modifiers: DragSelectionModifiers,
): DragSelectionState {
  const scope = dragSelectionScope(source);
  const sourceId = dragSelectionId(source);
  const scopedItems = current.scope === scope ? current.items : [];
  const orderedById = new Map(orderedItems.map((item) => [dragSelectionId(item), item]));

  if (modifiers.range && current.scope === scope && current.anchorId) {
    const anchorIndex = orderedItems.findIndex(
      (item) => dragSelectionId(item) === current.anchorId,
    );
    const sourceIndex = orderedItems.findIndex(
      (item) => dragSelectionId(item) === sourceId,
    );
    if (anchorIndex >= 0 && sourceIndex >= 0) {
      const rangeItems = orderedItems.slice(
        Math.min(anchorIndex, sourceIndex),
        Math.max(anchorIndex, sourceIndex) + 1,
      );
      const items = modifiers.toggle
        ? [...new Map(
            [...scopedItems, ...rangeItems].map((item) => [dragSelectionId(item), item]),
          ).values()]
        : [...rangeItems];
      return { anchorId: current.anchorId, items, scope };
    }
  }

  if (modifiers.toggle) {
    const selected = scopedItems.some((item) => dragSelectionId(item) === sourceId);
    const items = selected
      ? scopedItems.filter((item) => dragSelectionId(item) !== sourceId)
      : [...scopedItems, orderedById.get(sourceId) ?? source];
    return {
      anchorId: sourceId,
      items,
      scope: items.length > 0 ? scope : undefined,
    };
  }

  if (
    scopedItems.length > 1 &&
    scopedItems.some((item) => dragSelectionId(item) === sourceId)
  ) {
    return current;
  }
  return { anchorId: sourceId, items: [orderedById.get(sourceId) ?? source], scope };
}

export function replaceDragSelection(
  items: readonly SelectableDragItem[],
): DragSelectionState {
  const first = items[0];
  if (!first) return { items: [] };
  const scope = dragSelectionScope(first);
  const scopedItems = [...new Map(items
    .filter((item) => dragSelectionScope(item) === scope)
    .map((item) => [dragSelectionId(item), item])).values()];
  const anchor = scopedItems.at(-1);
  return anchor
    ? { anchorId: dragSelectionId(anchor), items: scopedItems, scope }
    : { items: [] };
}

export function topLevelDragSelection(
  items: readonly SelectableDragItem[],
): SelectableDragItem[] {
  const selectedFolderIds = new Set(items.flatMap((item) =>
    item.kind === 'tab-folder' || item.kind === 'tree' && item.isFolder
      ? [item.nodeId]
      : []));
  return items.filter((item) => {
    const ancestorIds = 'ancestorIds' in item ? item.ancestorIds ?? [] : [];
    return !ancestorIds.some((ancestorId) => selectedFolderIds.has(ancestorId));
  });
}

export function dragSelectionCount(items: readonly SelectableDragItem[]): number {
  return topLevelDragSelection(items).reduce(
    (count, item) => count + (item.itemCount ?? 1),
    0,
  );
}

const NO_ROWS: ReadonlySet<string> = new Set();

/**
 * The rows a drag carries besides the one it grabbed: the rest of the
 * selection, when it grabbed a selected row, as the drag itself decides.
 */
export function liftedDragNodeIds(
  items: readonly SelectableDragItem[],
  selectedIds: ReadonlySet<string>,
  grabbedNodeId: string | undefined,
): ReadonlySet<string> {
  const grabbed = grabbedNodeId === undefined
    ? undefined
    : items.find((item) => 'nodeId' in item && item.nodeId === grabbedNodeId);
  if (!grabbed || !selectedIds.has(dragSelectionId(grabbed))) return NO_ROWS;
  return new Set(items.flatMap((item) =>
    item !== grabbed && 'nodeId' in item && item.nodeId && selectedIds.has(dragSelectionId(item))
      ? [item.nodeId]
      : []));
}

/** Whether a drag carries this row, itself or inside a folder it carries. */
export function isLiftedRow(
  row: { ancestorIds: readonly string[]; nodeId: string },
  liftedIds: ReadonlySet<string>,
): boolean {
  return liftedIds.size > 0 &&
    (liftedIds.has(row.nodeId) || row.ancestorIds.some((id) => liftedIds.has(id)));
}