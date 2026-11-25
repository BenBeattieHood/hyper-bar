import {
  KeyboardSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type DragStartEvent,
} from '@dnd-kit/core';
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import { useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { BookmarkNode } from '../../lib/bookmarks';
import type { SpaceDragPreview } from '../components/SpacePagination';
import { copyModifierHeld, draggedFolderNodeId } from '../lib/drag';
import { dragData } from '../lib/dragDetection';
import {
  dragSelectionId,
  isSelectableDragItem,
  replaceDragSelection,
  topLevelDragSelection,
  updateDragSelection,
  type DragSelectionModifiers,
  type DragSelectionState,
} from '../lib/dragSelection';
import type { TabTreeDropIntent, TreeDropIntent } from '../lib/dropActions';
import { expandFolders } from '../lib/folderReveal';
import { NativeDragSensor, PointerOnlyMouseSensor, type NativeDragSensorOptions } from '../lib/nativeDrag';
import { sharedDragToken } from '../lib/sharedDragDrops';
import type { DragItemData, SelectableDragItem, TreeDropIndicator } from '../types';
import type { useBrowserState } from './useBrowserState';
import { useExternalDrag } from './useExternalDrag';
import { useHoldTimer } from './useHoldTimer';
import { useSharedDrag } from './useSharedDrag';

const TREE_AUTO_EXPAND_DELAY = 2_300;

type BrowserStateApi = ReturnType<typeof useBrowserState>;

export function useDragSession({
  browserState,
  clearViewSwitchTimer,
  collapsedIds,
  favouriteSlots,
  nodeMap,
  setCollapsedIds,
}: {
  browserState: BrowserStateApi;
  clearViewSwitchTimer(): void;
  collapsedIds: ReadonlySet<string>;
  favouriteSlots: readonly (BookmarkNode | undefined)[];
  nodeMap: ReadonlyMap<string, BookmarkNode>;
  setCollapsedIds: Dispatch<SetStateAction<Set<string>>>;
}) {
  const [activeDrag, setActiveDrag] = useState<DragItemData>();
  const activeDragRef = useRef<DragItemData | undefined>(undefined);
  const [spaceDragPreview, setSpaceDragPreview] = useState<SpaceDragPreview>();
  const [dragSelection, setDragSelection] = useState<DragSelectionState>({ items: [] });
  const dragSelectionRef = useRef<DragSelectionState>({ items: [] });
  const [activeDragItems, setActiveDragItems] = useState<SelectableDragItem[]>([]);
  const activeDragItemsRef = useRef<SelectableDragItem[]>([]);
  const dragExpandedFolderRef = useRef<string | undefined>(undefined);
  const keyboardTreeDragRef = useRef(false);
  const keyboardTreeStepRef = useRef(0);
  const [dragOverTarget, setDragOverTarget] = useState<DragItemData>();
  const [copyModifierActive, setCopyModifierActive] = useState(false);
  const copyModifierActiveRef = useRef(false);
  const [treeDropIndicator, setTreeDropIndicator] = useState<TreeDropIndicator>();
  const [dropForbidden, setDropForbidden] = useState(false);
  const treeDropIntentRef = useRef<TreeDropIntent | undefined>(undefined);
  const tabTreeDropIntentRef = useRef<TabTreeDropIntent | undefined>(undefined);
  const treeEntryHorizontalOffsetRef = useRef<number | undefined>(undefined);
  const treeExpansion = useHoldTimer<string>(TREE_AUTO_EXPAND_DELAY);
  const clearTreeExpandTimer = treeExpansion.disarm;
  const expandFolder = (nodeId: string) => setCollapsedIds((current) => expandFolders(current, [nodeId]));
  const setCopyModifier = (active: boolean) => {
    copyModifierActiveRef.current = active;
    setCopyModifierActive(active);
  };
  const commitDragSelection = (next: DragSelectionState) => {
    dragSelectionRef.current = next;
    setDragSelection(next);
  };
  /** Forgets where the drag was over and what dropping there would do. */
  const clearDropProjection = () => {
    setDragOverTarget(undefined);
    treeDropIntentRef.current = undefined;
    tabTreeDropIntentRef.current = undefined;
    treeEntryHorizontalOffsetRef.current = undefined;
    setTreeDropIndicator(undefined);
  };
  const resetDragSession = () => {
    clearViewSwitchTimer();
    clearTreeExpandTimer();
    const expandedFolderId = dragExpandedFolderRef.current;
    dragExpandedFolderRef.current = undefined;
    if (expandedFolderId) expandFolder(expandedFolderId);
    activeDragRef.current = undefined;
    activeDragItemsRef.current = [];
    keyboardTreeDragRef.current = false;
    keyboardTreeStepRef.current = 0;
    setActiveDrag(undefined);
    setSpaceDragPreview(undefined);
    setActiveDragItems([]);
    commitDragSelection({ items: [] });
    setCopyModifier(false);
    clearDropProjection();
    setDropForbidden(false);
    sharedDrag.finish();
    externalDrag.finish();
  };
  const updateSelectedDragItems = (
    source: SelectableDragItem,
    orderedItems: readonly SelectableDragItem[],
    modifiers: DragSelectionModifiers,
  ) => commitDragSelection(updateDragSelection(dragSelectionRef.current, source, orderedItems, modifiers));
  const replaceSelectedDragItems = (items: readonly SelectableDragItem[]) =>
    commitDragSelection(replaceDragSelection(items));
  const clearSelectedTabs = () => {
    if (dragSelectionRef.current.scope === 'tabs') commitDragSelection({ items: [] });
  };
  const clearSelectedTabsAfter = async <Result,>(
    operation: Promise<Result>,
  ): Promise<Result> => {
    const result = await operation;
    clearSelectedTabs();
    return result;
  };
  const armTreeExpansion = (nodeId: string) => treeExpansion.arm(nodeId, nodeId, () => expandFolder(nodeId));
  const sharedDrag = useSharedDrag({
    dragging: () => Boolean(activeDragRef.current),
    favouriteSlots,
    nodes: nodeMap,
    offer: browserState.offerDrag,
    outgoingItems: () => activeDragItemsRef.current,
    shared: browserState.sharedDrag,
    withdraw: browserState.withdrawDrag,
  });
  const externalDrag = useExternalDrag({ dragging: () => Boolean(activeDragRef.current) });
  const { accept: acceptExternal } = externalDrag;
  const nativeDragOptions = useMemo<NativeDragSensorOptions>(
    () => ({ ...sharedDrag.sensorOptions, acceptsExternal: acceptExternal }),
    [acceptExternal, sharedDrag.sensorOptions],
  );
  const sensors = useSensors(
    useSensor(PointerOnlyMouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(NativeDragSensor, nativeDragOptions),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 180, tolerance: 8 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
      // Enter opens a row, so only Space picks one up.
      keyboardCodes: { cancel: ['Escape'], end: ['Space', 'Enter'], start: ['Space'] },
    }),
  );

  const handleDragStart = (event: DragStartEvent) => {
    clearViewSwitchTimer();
    clearTreeExpandTimer();
    const activatorEvent = event.activatorEvent as MouseEvent | KeyboardEvent;
    const modifierActive = copyModifierHeld(activatorEvent);
    const source = dragData(event.active.data.current);
    const selectedItems = sharedDragToken(event.active.id) !== undefined
      ? sharedDrag.incoming?.items ?? []
      : isSelectableDragItem(source)
        ? topLevelDragSelection(
            dragSelectionRef.current.items.some((item) =>
              dragSelectionId(item) === dragSelectionId(source))
              ? dragSelectionRef.current.items
              : [source],
          )
        : [];
    activeDragItemsRef.current = selectedItems;
    setActiveDragItems(selectedItems);
    if (!isSelectableDragItem(source)) commitDragSelection({ items: [] });
    const folderId = draggedFolderNodeId(source);
    const expandedFolderId = folderId && !collapsedIds.has(folderId)
      ? folderId
      : undefined;
    dragExpandedFolderRef.current = expandedFolderId;
    if (expandedFolderId) {
      setCollapsedIds((current) => new Set(current).add(expandedFolderId));
    }
    keyboardTreeDragRef.current = activatorEvent instanceof KeyboardEvent &&
      source?.kind === 'tree';
    keyboardTreeStepRef.current = 0;
    setCopyModifier(modifierActive);
    activeDragRef.current = source;
    if (source?.kind === 'space') {
      const sourceElement = document.querySelector<HTMLElement>(
        `.space-pagination-dot[data-space-id="${CSS.escape(source.spaceId)}"]`,
      );
      const visual = sourceElement?.querySelector<HTMLElement>(
        '.space-pagination-dot-visual',
      );
      const bounds = visual?.getBoundingClientRect();
      setSpaceDragPreview(bounds ? {
        width: bounds.width,
        height: bounds.height,
        dotMode: Boolean(sourceElement?.closest('.space-pagination-items.is-dot-mode')),
        truncated: Boolean(sourceElement?.classList.contains('is-truncated')),
      } : undefined);
    } else {
      setSpaceDragPreview(undefined);
    }
    setActiveDrag(source);
    clearDropProjection();
  };

  return {
    activeDrag,
    activeDragItems,
    activeDragItemsRef,
    activeDragRef,
    armTreeExpansion,
    clearSelectedTabs,
    clearSelectedTabsAfter,
    clearTreeExpandTimer,
    copyModifierActive,
    copyModifierActiveRef,
    dragOverTarget,
    dragSelection,
    dragSelectionRef,
    dropForbidden,
    externalDrag,
    handleDragStart,
    keyboardTreeDragRef,
    keyboardTreeStepRef,
    replaceSelectedDragItems,
    resetDragSession,
    sensors,
    setCopyModifier,
    setDragOverTarget,
    setDropForbidden,
    setTreeDropIndicator,
    sharedDrag,
    spaceDragPreview,
    tabTreeDropIntentRef,
    treeDropIndicator,
    treeDropIntentRef,
    treeEntryHorizontalOffsetRef,
    treeExpandingNodeId: treeExpansion.armed,
    updateSelectedDragItems,
  };
}
