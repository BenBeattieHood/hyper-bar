import type { DragEndEvent, DragMoveEvent, DragOverEvent, DragStartEvent } from '@dnd-kit/core';
import { useEffect, useRef, useState, type RefObject } from 'react';
import type { BookmarkNode, Space } from '../../lib/bookmarks';
import {
  bookmarkDropCopies,
  confineDragEscape,
  copyModifierHeld,
  indexedRootDropTarget,
  isCopyModifierKey,
  isInvalidFolderDrop,
  projectedExternalTreeDepth,
  projectedTreeDepth,
  projectPointerTreeDrop,
  removeTreeDescendants,
  spaceDragView,
  type flattenVisibleTree,
} from '../lib/drag';
import { dragData, dragPointer, dragPointerY, treeIndentationWidth } from '../lib/dragDetection';
import { isSelectableDragItem } from '../lib/dragSelection';
import { externalDropLands } from '../lib/externalDrop';
import type {
  DropRequest,
  TabTreeDropIntent,
  TabTreeTarget,
  TreeDropIntent,
} from '../lib/dropActions';
import { sessionDropRefused } from '../lib/otherSessions';
import { isSharedDragTab, sharedDragToken, sharedTabsCanLand } from '../lib/sharedDragDrops';
import { splitDropForDragEvent, type SplitRows, type splitViewRows } from '../lib/splitRows';
import type { DragItemData } from '../types';
import type { useBrowserState } from './useBrowserState';
import type { useDragSession } from './useDragSession';
import type { useWorkspaceOverlay } from './useWorkspaceOverlay';
import { useSpaceDragArming } from './useSpaceDragArming';
import { listen } from '../lib/listen';

type BrowserStateApi = ReturnType<typeof useBrowserState>;

/** What the workspace showed when a drag began, so a drag that lands nowhere can return to it. */
interface DragOrigin {
  archiveOpen: boolean;
  bookmarksOpen: boolean;
  globalBookmarksOpen: boolean;
  spaceId: string | undefined;
}

/** Where the pointer sits, else the dragged overlay's centre, else the target's. */
function dragPointerYOnTarget(
  event: DragMoveEvent | DragOverEvent | DragEndEvent,
  targetRect: { height: number; top: number },
): number {
  const translated = event.active.rect.current.translated;
  return dragPointerY(event) ?? (translated
    ? translated.top + translated.height / 2
    : targetRect.top + targetRect.height / 2);
}

/** The row a drop lands on, measured live, else as dnd-kit last measured it. */
function targetRect(attribute: string, nodeId: string, event: DragMoveEvent | DragOverEvent | DragEndEvent) {
  return document.querySelector<HTMLElement>(`[${attribute}="${CSS.escape(nodeId)}"]`)?.getBoundingClientRect() ??
    event.over?.rect;
}

/** A drop projected at drag end if it still targets the row, else the last one projected over it. */
function dropOnto<Drop extends { target: { nodeId: string } }>(
  nodeId: string,
  projected: Drop | undefined,
  previous: Drop | undefined,
): Drop | undefined {
  return [projected, previous].find((drop) => drop?.target.nodeId === nodeId);
}

function sortableIndex(data: unknown): number | undefined {
  const index = (data as { sortable?: { index?: unknown } } | undefined)?.sortable?.index;
  return typeof index === 'number' ? index : undefined;
}

/**
 * Whether a space dragged over a pagination dot would land after it, by which half the pointer is on.
 * A keyboard drag has no pointer, so a step right lands after the dot and a step left before it.
 */
function spaceDropAfter(event: DragMoveEvent | DragOverEvent | DragEndEvent): boolean | undefined {
  const source = dragData(event.active.data.current);
  const target = dragData(event.over?.data.current);
  const rect = event.over?.rect;
  if (source?.kind !== 'space' || target?.kind !== 'space' || target.archived || !rect) return undefined;
  const pointerX = dragPointer(event)?.x;
  if (pointerX !== undefined) return pointerX > rect.left + rect.width / 2;
  const sourceIndex = source.archived ? undefined : sortableIndex(event.active.data.current);
  const targetIndex = sortableIndex(event.over?.data.current);
  if (sourceIndex !== undefined && targetIndex !== undefined) return sourceIndex < targetIndex;
  const translated = event.active.rect.current.translated;
  return translated !== null && translated.left + translated.width / 2 > rect.left + rect.width / 2;
}

export function useWorkspaceDrop({
  activeSpace,
  archivePanel,
  armWorkspaceView,
  bookmarksOpenRef,
  bookmarksRootId,
  browserState,
  clearViewSwitchTimer,
  collapsedIds,
  dragSession,
  dropActions,
  globalPanel,
  listsSideBySide,
  nodeMap,
  selectSpace,
  showWorkspaceView,
  splitRows,
  tabTreeItems,
  tabTreeRootId,
  tabsByNodeId,
  visibleTreeItems,
  wideWorkspace,
}: {
  activeSpace: Space | undefined;
  /** Holding a space's drag over the pagination's archive button opens the archived spaces. */
  archivePanel: ReturnType<typeof useWorkspaceOverlay>;
  armWorkspaceView(nextView: 'tabs' | 'bookmarks'): void;
  bookmarksOpenRef: RefObject<boolean>;
  bookmarksRootId: string | undefined;
  browserState: BrowserStateApi;
  clearViewSwitchTimer(): void;
  collapsedIds: ReadonlySet<string>;
  dragSession: ReturnType<typeof useDragSession>;
  dropActions: { perform(request: DropRequest): Promise<void> };
  /** Holding a drag over the favourites bar's bookmarks button opens the global bookmarks. */
  globalPanel: ReturnType<typeof useWorkspaceOverlay>;
  /** Tabs and bookmarks show together, so a space shows both lists at once. */
  listsSideBySide: boolean;
  nodeMap: ReadonlyMap<string, BookmarkNode>;
  selectSpace(spaceId: string): Promise<boolean>;
  showWorkspaceView(view: 'tabs' | 'bookmarks'): void;
  splitRows: SplitRows;
  tabTreeItems: ReturnType<typeof splitViewRows>['items'];
  tabTreeRootId: string;
  tabsByNodeId: Record<string, Browser.tabs.Tab>;
  visibleTreeItems: ReturnType<typeof flattenVisibleTree>;
  wideWorkspace: boolean;
}) {
  const {
    activeDrag,
    activeDragItemsRef,
    activeDragRef,
    armTreeExpansion,
    dropForbidden,
    clearTreeExpandTimer,
    copyModifierActiveRef,
    keyboardTreeDragRef,
    keyboardTreeStepRef,
    resetDragSession,
    setCopyModifier,
    setDragOverTarget,
    setDropForbidden,
    setTreeDropIndicator,
    tabTreeDropIntentRef,
    treeDropIntentRef,
    treeEntryHorizontalOffsetRef,
  } = dragSession;
  const spaceArming = useSpaceDragArming({
    dragActive: Boolean(activeDrag),
    showing: ({ spaceId, view }) => spaceId === activeSpace?.id && !globalPanel.open && !archivePanel.open &&
      (listsSideBySide || bookmarksOpenRef.current === (view === 'bookmarks')),
    open: ({ spaceId, view }) => {
      globalPanel.close();
      archivePanel.close();
      if (!listsSideBySide) showWorkspaceView(view);
      void selectSpace(spaceId);
    },
  });

  /** The rows a keyboard drag of a bookmark steps through, which skip its own descendants. */
  const keyboardTreeRows = (nodeId: string) => {
    const keyboardItems = removeTreeDescendants(visibleTreeItems, nodeId);
    return { keyboardItems, sourceIndex: keyboardItems.findIndex((item) => item.nodeId === nodeId) };
  };
  const dragSource = (event: DragMoveEvent | DragOverEvent | DragEndEvent) =>
    dragData(event.active.data.current) ?? activeDragRef.current;
  const dragOrigin = useRef<DragOrigin | undefined>(undefined);
  /** Where a space dragged over the pagination would land. */
  const [spaceInsertion, setSpaceInsertion] = useState<{ after: boolean; spaceId: string }>();
  const handleDragStart = (event: DragStartEvent) => {
    dragOrigin.current = {
      archiveOpen: archivePanel.open,
      bookmarksOpen: Boolean(bookmarksOpenRef.current),
      globalBookmarksOpen: globalPanel.open,
      spaceId: activeSpace?.id,
    };
    dragSession.handleDragStart(event);
  };
  /** Undoes the spaces, views and global bookmarks a held drag opened along the way. */
  const returnToDragOrigin = () => {
    const origin = dragOrigin.current;
    dragOrigin.current = undefined;
    if (!origin) return;
    if (!listsSideBySide && Boolean(bookmarksOpenRef.current) !== origin.bookmarksOpen) {
      showWorkspaceView(origin.bookmarksOpen ? 'bookmarks' : 'tabs');
    }
    if (globalPanel.open !== origin.globalBookmarksOpen || origin.spaceId !== activeSpace?.id) {
      globalPanel.restore(origin.globalBookmarksOpen, origin.spaceId);
    }
    if (archivePanel.open !== origin.archiveOpen || origin.spaceId !== activeSpace?.id) {
      archivePanel.restore(origin.archiveOpen, origin.spaceId);
    }
    if (origin.spaceId && origin.spaceId !== activeSpace?.id) void selectSpace(origin.spaceId);
  };
  const handleDragCancel = () => {
    setSpaceInsertion(undefined);
    resetDragSession();
    returnToDragOrigin();
  };

  useEffect(() => {
    if (!activeDrag) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (confineDragEscape(event)) return;
      if (isCopyModifierKey(event.key)) setCopyModifier(true);
      if (
        keyboardTreeDragRef.current &&
        activeDrag.kind === 'tree' &&
        (event.key === 'ArrowUp' || event.key === 'ArrowDown')
      ) {
        const { keyboardItems, sourceIndex } = keyboardTreeRows(activeDrag.nodeId);
        if (sourceIndex >= 0) {
          const nextStep = keyboardTreeStepRef.current +
            (event.key === 'ArrowUp' ? -1 : 1);
          keyboardTreeStepRef.current = Math.max(
            -sourceIndex,
            Math.min(keyboardItems.length - sourceIndex - 1, nextStep),
          );
        }
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (isCopyModifierKey(event.key)) setCopyModifier(copyModifierHeld(event));
    };
    // A native drag sends no key events, but every dragover carries the modifiers.
    const onDragOver = (event: DragEvent) => {
      if (copyModifierHeld(event) !== copyModifierActiveRef.current) setCopyModifier(copyModifierHeld(event));
    };
    const onBlur = () => setCopyModifier(false);
    return listen(
      [window, 'keydown', onKeyDown, true],
      [window, 'keyup', onKeyUp],
      [window, 'dragover', onDragOver, true],
      [window, 'blur', onBlur],
    );
  }, [activeDrag, visibleTreeItems]);

  const updateBookmarksDragIntent = (event: DragMoveEvent | DragOverEvent) => {
    const target = dragData(event.over?.data.current);
    globalPanel.arm(target?.kind === 'global-bookmarks');
    archivePanel.arm(target?.kind === 'space-archive');
    const source = dragSource(event);
    const spaceView = target?.kind === 'space' ? spaceDragView(source) : undefined;
    spaceArming.arm(target?.kind === 'space' && spaceView ? { spaceId: target.spaceId, view: spaceView } : undefined);
    if (wideWorkspace) {
      clearViewSwitchTimer();
      return;
    }
    const switchableSource = source?.kind === 'tab' || source?.kind === 'favourite' ||
      source?.kind === 'tree' || source?.kind === 'external';
    const nextView = switchableSource && !bookmarksOpenRef.current &&
      target?.kind === 'bookmarks-trigger'
      ? 'bookmarks' as const
      : switchableSource && bookmarksOpenRef.current && target?.kind === 'tabs-trigger'
        ? 'tabs' as const
        : undefined;
    if (!nextView) {
      clearViewSwitchTimer();
      return;
    }
    armWorkspaceView(nextView);
  };

  const treeDropForEvent = (
    event: DragMoveEvent | DragOverEvent | DragEndEvent,
  ): TreeDropIntent | undefined => {
    const source = dragSource(event);
    if (!source) return undefined;
    const keyboardDrag = source.kind === 'tree' && keyboardTreeDragRef.current;
    const keyboardRows = keyboardDrag ? keyboardTreeRows(source.nodeId) : undefined;
    const keyboardTargetItem = keyboardRows?.keyboardItems[keyboardRows.sourceIndex + keyboardTreeStepRef.current];
    if (keyboardDrag && keyboardTreeStepRef.current === 0) return undefined;
    const target: DragItemData | undefined = keyboardTargetItem
      ? {
          kind: 'tree',
          nodeId: keyboardTargetItem.nodeId,
          title: keyboardTargetItem.node.title,
          parentId: keyboardTargetItem.parentId,
          index: keyboardTargetItem.index,
          depth: keyboardTargetItem.depth,
          isFolder: keyboardTargetItem.isFolder,
        }
      : dragData(event.over?.data.current);
    if (!target || target.kind !== 'tree') return undefined;
    if (
      source.kind !== 'tree' && source.kind !== 'favourite' && source.kind !== 'tab' && source.kind !== 'external' &&
      source.kind !== 'session-tab'
    ) {
      return undefined;
    }
    const rect = targetRect('data-bookmark-node-id', target.nodeId, event);
    if (!rect) return undefined;
    const dragCenterY = keyboardDrag
      ? keyboardTreeStepRef.current > 0
        ? rect.bottom - 1
        : keyboardTreeStepRef.current < 0
          ? rect.top + 1
          : rect.top + rect.height / 2
      : dragPointerYOnTarget(event, rect);
    if (activeSpace) {
      const copiesSource = bookmarkDropCopies(
        source,
        target,
        copyModifierActiveRef.current,
      );
      const currentSource = source.kind === 'tree' && !copiesSource
        ? visibleTreeItems.find((item) => item.nodeId === source.nodeId)
        : undefined;
      const projectionSource = currentSource
        ? {
            nodeId: currentSource.nodeId,
            parentId: currentSource.parentId,
            index: currentSource.index,
            depth: currentSource.depth,
            isFolder: currentSource.isFolder,
          }
        : source.kind === 'tree'
          ? copiesSource
            ? {
                ...source,
                nodeId: `copy:${source.nodeId}`,
                parentId: bookmarksRootId ?? '',
                index: visibleTreeItems.length,
                depth: 0,
              }
            : source
          : {
              nodeId: source.kind === 'favourite'
                ? source.nodeId
                : source.kind === 'external'
                  ? 'external-drag'
                  : source.kind === 'session-tab' ? `session-tab:${source.nodeId}` : `tab:${source.tabId}`,
              parentId: bookmarksRootId ?? '',
              index: visibleTreeItems.length,
              depth: 0,
              isFolder: false,
            };
      const indentationWidth = treeIndentationWidth();
      const projectedDepth = source.kind === 'tree'
        ? projectedTreeDepth(
            source.depth,
          keyboardDrag ? 0 : event.delta.x,
            indentationWidth,
          )
        : projectedExternalTreeDepth(
            target.depth,
            event.delta.x,
            treeEntryHorizontalOffsetRef.current ??= event.delta.x,
            indentationWidth,
          );
      const projection = projectPointerTreeDrop({
        items: visibleTreeItems,
        pointerY: dragCenterY,
        projectedDepth,
        rootId: bookmarksRootId ?? '',
        source: projectionSource,
        target,
        targetRect: rect,
      });
      if (!projection) return undefined;
      const invalid = source.kind === 'tree'
        ? isInvalidFolderDrop(
            source,
            nodeMap.get(source.nodeId),
            projection.destination,
          )
        : source.kind === 'tab' && !source.bookmarkable;
      return { ...projection, target, invalid };
    }
    return undefined;
  };

  const tabTreeDropForEvent = (
    event: DragMoveEvent | DragOverEvent | DragEndEvent,
  ): TabTreeDropIntent | undefined => {
    if (!activeSpace) return undefined;
    const source = dragSource(event);
    const rawTarget = dragData(event.over?.data.current);
    const target = rawTarget?.kind === 'tab-folder'
      ? rawTarget
      : rawTarget?.kind === 'tab' && rawTarget.nodeId
        ? rawTarget as TabTreeTarget
        : undefined;
    if (!target) return undefined;
    const projectionSource = source?.kind === 'tab-folder'
      ? {
          nodeId: source.nodeId,
          parentId: source.parentId,
          index: source.index,
          depth: source.depth,
          isFolder: true,
        }
      : source?.kind === 'tab' && source.backingId && source.nodeId &&
          source.parentId !== undefined && source.treeIndex !== undefined &&
          source.depth !== undefined
        ? {
            nodeId: source.nodeId,
            parentId: source.parentId,
            index: source.treeIndex,
            depth: source.depth,
            isFolder: false,
          }
        : isSharedDragTab(source) || source?.kind === 'session-tab'
          ? { nodeId: 'shared-drag-tab', parentId: tabTreeRootId, index: tabTreeItems.length, depth: 0, isFolder: false }
          : undefined;
    if (!projectionSource) return undefined;
    // A pane over its own split's row is going nowhere.
    const sourceRowId = splitRows.rowIdByPaneId.get(projectionSource.nodeId);
    if (sourceRowId !== undefined && sourceRowId === splitRows.rowIdByPaneId.get(target.nodeId)) return undefined;
    const rect = targetRect('data-tab-node-id', target.nodeId, event);
    if (!rect) return undefined;
    const pointerY = dragPointerYOnTarget(event, rect);
    const overNodeId = splitRows.rowIdByPaneId.get(target.nodeId) ?? target.nodeId;
    const targetItem = tabTreeItems.find((item) => item.nodeId === overNodeId);
    if (!targetItem) return undefined;
    const projection = projectPointerTreeDrop({
      items: tabTreeItems,
      pointerY,
      // Tabs from another window or session have no depth here to pull away from, so they keep the row's.
      projectedDepth: projectionSource.nodeId === 'shared-drag-tab' ? targetItem.depth : projectedTreeDepth(
        projectionSource.depth,
        event.delta.x,
        treeIndentationWidth(),
      ),
      rootId: tabTreeRootId,
      source: projectionSource,
      target: {
        depth: targetItem.depth,
        isFolder: target.kind === 'tab-folder',
        nodeId: overNodeId,
      },
      targetRect: rect,
    });
    if (!projection) return undefined;
    const sourceItem = tabTreeItems.find(
      (item) => item.nodeId === projectionSource.nodeId,
    );
    const invalid = projectionSource.isFolder && Boolean(
      projection.destination.parentId === projectionSource.nodeId ||
      sourceItem && tabTreeItems.some((item) =>
        item.nodeId === projection.destination.parentId &&
        item.ancestorIds.includes(projectionSource.nodeId)),
    );
    return { ...projection, target, invalid };
  };

  const splitDropForEvent = (event: DragMoveEvent | DragOverEvent | DragEndEvent) =>
    splitDropForDragEvent(event, {
      capacity: browserState.commandCapabilities.splitViewTabs,
      rows: splitRows,
      sources: activeDragItemsRef.current,
      tabs: browserState.tabs,
      tabsByNodeId,
      urlOf: (nodeId) => nodeMap.get(nodeId)?.url,
    });

  const updateTreeDropIntent = (event: DragMoveEvent | DragOverEvent) => {
    const source = dragSource(event);
    const target = dragData(event.over?.data.current);
    if (
      (source?.kind === 'tab' || source?.kind === 'favourite' || source?.kind === 'external') &&
      target?.kind !== 'tree' &&
      target?.kind !== 'tree-zone'
    ) {
      treeEntryHorizontalOffsetRef.current = undefined;
    }
    const splitDrop = splitDropForEvent(event);
    if (splitDrop) {
      tabTreeDropIntentRef.current = undefined;
      treeDropIntentRef.current = undefined;
      clearTreeExpandTimer();
      setDropForbidden(false);
      setTreeDropIndicator({ invalid: false, nodeId: splitDrop.nodeId, position: 'split' });
      return;
    }
    const tabTreeDrop = tabTreeDropForEvent(event);
    tabTreeDropIntentRef.current = tabTreeDrop;
    const treeDrop = tabTreeDrop ? undefined : treeDropForEvent(event);
    treeDropIntentRef.current = treeDrop;
    const activeDrop = tabTreeDrop ?? treeDrop;
    const rootTarget = indexedRootDropTarget(target) ? target : undefined;
    const rootDropAllowed = Boolean(source && rootTarget && (
      rootTarget.kind === 'tree-zone'
        ? source.kind === 'tree' || source.kind === 'favourite' || source.kind === 'external' ||
          source.kind === 'session-tab' || source.kind === 'tab' && source.bookmarkable
        : source.kind === 'tab-folder' || source.kind === 'favourite' || source.kind === 'external' ||
          source.kind === 'tree' && !source.isFolder || source.kind === 'tab' || source.kind === 'session-tab'
    ));
    const rootDropBlocked = Boolean(rootTarget && source && !rootDropAllowed);
    const sharedTabsRefused = Boolean(target && (isSharedDragTab(source) && !sharedTabsCanLand(target) ||
      source?.kind === 'external' && !externalDropLands(target) ||
      sessionDropRefused(source, target, activeDragItemsRef.current)));
    setDropForbidden(Boolean(activeDrop?.invalid || rootDropBlocked || sharedTabsRefused));
    if (
      activeDrop?.position === 'inside' &&
      !activeDrop.invalid &&
      collapsedIds.has(activeDrop.indicatorNodeId)
    ) {
      armTreeExpansion(activeDrop.indicatorNodeId);
    } else {
      clearTreeExpandTimer();
    }
    if (activeDrop && !activeDrop.invalid) {
      setTreeDropIndicator({
        nodeId: activeDrop.indicatorNodeId,
        position: activeDrop.position,
        invalid: false,
        depth: activeDrop.depth,
      });
      return;
    }
    const structuredTabTreeSource = Boolean(
      source?.kind === 'tab-folder' || source?.kind === 'tab' && source.backingId,
    );
    const lastRootItem = rootTarget?.kind === 'tabs-zone'
      ? structuredTabTreeSource
        ? tabTreeItems.findLast((item) =>
            !item.nodeId.startsWith('unsupported-tab:'))
        : tabTreeItems.at(-1)
      : rootTarget?.kind === 'tree-zone'
        ? source?.kind === 'tree' && source.depth === 0
          ? visibleTreeItems.findLast((item) =>
              item.depth === 0 && item.parentId === source.parentId)
          : visibleTreeItems.at(-1)
        : undefined;
    setTreeDropIndicator(
      rootDropAllowed && !rootDropBlocked && lastRootItem
        ? {
            nodeId: lastRootItem.nodeId,
            position: 'after',
            invalid: false,
            depth: 0,
          }
        : undefined,
    );
  };

  const updateSpaceInsertion = (event: DragMoveEvent | DragOverEvent) => {
    const after = spaceDropAfter(event);
    const target = dragData(event.over?.data.current);
    const next = after === undefined || target?.kind !== 'space' ? undefined : { after, spaceId: target.spaceId };
    setSpaceInsertion((current) =>
      current?.after === next?.after && current?.spaceId === next?.spaceId ? current : next);
  };

  const handleDragMove = (event: DragMoveEvent) => {
    const source = dragSource(event);
    if (source?.kind === 'space') {
      updateSpaceInsertion(event);
      return;
    }
    updateBookmarksDragIntent(event);
    updateTreeDropIntent(event);
  };

  const handleDragOver = (event: DragOverEvent) => {
    updateBookmarksDragIntent(event);
    updateTreeDropIntent(event);
    const target = dragData(event.over?.data.current);
    setDragOverTarget(target);
    updateSpaceInsertion(event);
  };

  const handleDragEnd = async (event: DragEndEvent) => {
    const source = dragSource(event);
    const selectedSources = activeDragItemsRef.current.length > 0
      ? activeDragItemsRef.current
      : isSelectableDragItem(source)
        ? [source]
        : [];
    const rawTarget = dragData(event.over?.data.current);
    const projectedTabTreeDrop = tabTreeDropForEvent(event);
    const projectedTreeDrop = treeDropForEvent(event);
    const target = projectedTabTreeDrop?.target ?? projectedTreeDrop?.target ?? rawTarget;
    const tabTreeDrop = target?.kind === 'tab-folder' || target?.kind === 'tab'
      ? dropOnto(target.nodeId ?? '', projectedTabTreeDrop, tabTreeDropIntentRef.current)
      : undefined;
    const treeDrop = target?.kind === 'tree'
      ? dropOnto(target.nodeId, projectedTreeDrop, treeDropIntentRef.current)
      : undefined;
    const modifierActive = copyModifierActiveRef.current;
    const copiesBookmark = Boolean(source && target && bookmarkDropCopies(
      source,
      target,
      modifierActive,
    ));
    const splitDrop = splitDropForEvent(event);
    const sharedToken = sharedDragToken(event.active.id);
    const externalDrop = source?.kind === 'external' ? dragSession.externalDrag.take() : undefined;
    const landsNowhere = !source || !target || dropForbidden;
    const dropsAfter = spaceDropAfter(event);
    setSpaceInsertion(undefined);
    resetDragSession();
    if (landsNowhere) {
      returnToDragOrigin();
      return;
    }
    dragOrigin.current = undefined;
    await dropActions.perform({
      copiesBookmark, externalDrop, modifierActive, selectedSources, sharedToken, source, splitDrop, tabTreeDrop, target,
      treeDrop, ...(dropsAfter === undefined ? {} : { spaceDropAfter: dropsAfter }),
    });
  };

  return {
    armingSpaceId: spaceArming.armingSpaceId, handleDragCancel, spaceInsertion, handleDragEnd, handleDragMove, handleDragOver, handleDragStart,
  };
}
