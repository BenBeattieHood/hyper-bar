import type { DragEndEvent, DragMoveEvent, DragOverEvent } from '@dnd-kit/core';
import { isSplitViewFolder, type BrowserTab } from '../../lib/bookmarks';
import { tabSplitViewId } from '../../lib/tabs';
import type { SelectableDragItem } from '../types';
import type { FlattenedTreeItem } from './drag';
import { dragData, dragPointer } from './dragDetection';

export interface SplitRows {
  /** Each split view row's panes, in pane order, keyed by the split view folder it draws. */
  panesByRowId: ReadonlyMap<string, readonly FlattenedTreeItem[]>;
  /** The split view row each pane is drawn in. */
  rowIdByPaneId: ReadonlyMap<string, string>;
}

/**
 * A split view folder draws as one row of panes where this browser can show
 * its tabs side by side: it holds two or more tabs, no more than a split can
 * show, and no folders. Any other split view folder draws as the folder it is.
 * Listed, the row is one item, so drops land before or after it, never inside.
 */
export function splitViewRows(
  items: readonly FlattenedTreeItem[],
  tabsByNodeId: Readonly<Record<string, BrowserTab | undefined>>,
  capacity: number,
): { items: FlattenedTreeItem[]; rows: SplitRows } {
  const panesByRowId = new Map<string, FlattenedTreeItem[]>();
  const rowIdByPaneId = new Map<string, string>();
  const listed: FlattenedTreeItem[] = [];
  for (const item of items) {
    if (item.ancestorIds.some((ancestorId) => panesByRowId.has(ancestorId))) continue;
    const children = item.node.children ?? [];
    if (
      !item.isFolder ||
      !isSplitViewFolder(item.node) ||
      children.length < 2 ||
      children.length > capacity ||
      !children.every((child) => child.url && tabsByNodeId[child.id])
    ) {
      listed.push(item);
      continue;
    }
    // Panes sit at their row's depth, where dragging one out starts from.
    panesByRowId.set(item.nodeId, children.map((child, index) => ({
      ancestorIds: [...item.ancestorIds, item.nodeId],
      depth: item.depth,
      index: child.index ?? index,
      isFolder: false,
      node: child,
      nodeId: child.id,
      parentId: item.nodeId,
    })));
    for (const child of children) rowIdByPaneId.set(child.id, item.nodeId);
    listed.push({ ...item, isFolder: false });
  }
  return { items: listed, rows: { panesByRowId, rowIdByPaneId } };
}

/** The right half of a row, clear of the top and bottom edges that place a drop beside it. */
export function pointerInSplitZone(
  pointer: { x: number; y: number },
  rect: { height: number; left: number; top: number; width: number },
): boolean {
  if (rect.width <= 0 || rect.height <= 0) return false;
  const across = (pointer.x - rect.left) / rect.width;
  const down = (pointer.y - rect.top) / rect.height;
  return across >= 0.5 && across <= 1 && down >= 0.25 && down <= 0.75;
}

export type SplitDrop = { nodeId: string; tabId: number } & (
  | { url: string }
  | { withTabId: number }
);

interface SplitBesideContext {
  capacity: number;
  nodeId: string;
  rows: SplitRows;
  sources: readonly SelectableDragItem[];
  tab?: BrowserTab;
  tabs: readonly BrowserTab[];
  urlOf: (nodeId: string) => string | undefined;
}

/**
 * Dropping on a tab's right half splits it with one dragged tab, or with one
 * bookmark's page, while the browser's split view has room for one more.
 */
export function splitDropAt({
  pointer,
  rect,
  ...context
}: SplitBesideContext & {
  pointer?: { x: number; y: number };
  rect?: { height: number; left: number; top: number; width: number };
}): SplitDrop | undefined {
  if (!pointer || !rect || !pointerInSplitZone(pointer, rect)) return undefined;
  return splitBeside(context);
}

/** The split that shows one tab, or one bookmark's page, beside `tab`, while its split has room. */
export function splitBeside({
  capacity,
  nodeId,
  rows,
  sources,
  tab,
  tabs,
  urlOf,
}: SplitBesideContext): SplitDrop | undefined {
  const [source] = sources;
  if (tab?.id === undefined || !source || sources.length > 1) return undefined;
  const rowId = rows.rowIdByPaneId.get(nodeId);
  const splitViewId = tabSplitViewId(tab);
  const shown = rowId !== undefined
    ? rows.panesByRowId.get(rowId)?.length ?? 1
    : splitViewId === undefined
      ? 1
      : tabs.filter((other) =>
          other.windowId === tab.windowId && tabSplitViewId(other) === splitViewId).length;
  if (shown + 1 > capacity) return undefined;
  if (source.kind === 'tab') {
    // The browser splits only tabs of one window.
    return source.tabId === tab.id || source.windowId !== tab.windowId
      ? undefined
      : { nodeId, tabId: tab.id, withTabId: source.tabId };
  }
  const url = source.kind === 'favourite' || source.kind === 'tree' && !source.isFolder
    ? urlOf(source.nodeId)
    : undefined;
  return url ? { nodeId, tabId: tab.id, url } : undefined;
}

/** The split a drag would make if dropped now, read from the tab row under the pointer. */
export function splitDropForDragEvent(
  event: DragMoveEvent | DragOverEvent | DragEndEvent,
  context: {
    capacity: number;
    rows: SplitRows;
    sources: readonly SelectableDragItem[];
    tabs: readonly BrowserTab[];
    tabsByNodeId: Readonly<Record<string, BrowserTab | undefined>>;
    urlOf: (nodeId: string) => string | undefined;
  },
): SplitDrop | undefined {
  const target = dragData(event.over?.data.current);
  if (target?.kind !== 'tab' || !target.nodeId) return undefined;
  return splitDropAt({
    ...context,
    nodeId: target.nodeId,
    pointer: dragPointer(event),
    rect: document.querySelector<HTMLElement>(
      `[data-tab-node-id="${CSS.escape(target.nodeId)}"]`,
    )?.getBoundingClientRect(),
    tab: context.tabsByNodeId[target.nodeId],
  });
}
