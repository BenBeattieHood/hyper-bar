import { useSortable } from '@dnd-kit/sortable';
import type { BookmarkNode, Space, SpaceIdentityIndex } from '../../lib/bookmarks';
import { Folder, FolderOpen, X } from 'lucide-react';
import { useContext, useMemo, type ButtonHTMLAttributes, type MouseEvent, type PointerEvent } from 'react';
import { useMarqueeSelection } from '../hooks/useMarqueeSelection';
import { useTreeKeyboard } from '../hooks/useTreeKeyboard';
import type { FlattenedTreeItem } from '../lib/drag';
import {
  dragSelectionId,
  isLiftedRow,
  liftedDragNodeIds,
  type DragSelectionModifiers,
} from '../lib/dragSelection';
import { ItemActionsContext } from '../lib/itemActions';
import { useItemGesture } from '../lib/itemGesture';
import type { SelectableDragItem, TreeDropIndicator } from '../types';
import { useTitleDoubleClick } from '@hyper/ui';
import { TreeDropPlaceholder } from './SortableTree';

/** What every sortable row of a tree needs to drag, drop and join the selection. */
export interface TreeRowDragProps {
  item: FlattenedTreeItem;
  lifted: boolean;
  dropDisabled?: boolean;
  draggedNodeId?: string;
  dropIndicator?: TreeDropIndicator;
  selectedDragItemIds: ReadonlySet<string>;
  orderedDragItems: readonly SelectableDragItem[];
  onDragSelectionPointerDown: (
    source: SelectableDragItem,
    orderedItems: readonly SelectableDragItem[],
    modifiers: DragSelectionModifiers,
  ) => void;
}

/** What the tab and bookmark trees share: their spaces, dragging, selection and folding, and bookmark sync. */
export interface TreeSurfaceProps extends Pick<
  TreeRowDragProps,
  'dropDisabled' | 'draggedNodeId' | 'dropIndicator' | 'selectedDragItemIds' | 'onDragSelectionPointerDown'
> {
  spaces: Space[];
  localSpaceIdsByPageIdentity: SpaceIdentityIndex;
  spaceIdsByPageIdentity: SpaceIdentityIndex;
  activeSpaceId: string;
  foremostPageIdentity?: string;
  foremostSpaceId?: string;
  spaceColours: Record<string, string>;
  extensionOrigin: string;
  collapsedIds: Set<string>;
  dragArmingNodeId?: string;
  onDragSelectionChange: (items: readonly SelectableDragItem[]) => void;
  onToggleFolder: (id: string) => void;
  onUpdateBookmarkUrl: (bookmark: BookmarkNode, url: string) => Promise<void>;
  onRevertBookmark: (tabId: number, url: string) => Promise<void>;
  onInteractionError: (message: string) => void;
}

/** A row's sortable state and the props its drag handle spreads. */
export function useTreeRow(
  {
    item,
    lifted,
    dropDisabled,
    draggedNodeId,
    dropIndicator,
    selectedDragItemIds,
    orderedDragItems,
    onDragSelectionPointerDown,
  }: TreeRowDragProps,
  sortableId: string,
  dragData: SelectableDragItem,
  { locked = false, pane = false }: { locked?: boolean; pane?: boolean } = {},
) {
  const gesture = useItemGesture();
  const titleDoubleClick = useTitleDoubleClick();
  const sortable = useSortable({
    id: sortableId,
    // A boolean would disable only dragging; a carried row must stop being a drop target too.
    disabled: {
      draggable: dropDisabled || lifted || locked ||
        Boolean(draggedNodeId && item.ancestorIds.includes(draggedNodeId)),
      droppable: lifted,
    },
    data: dragData,
  });
  const selectionId = dragSelectionId(dragData);
  const selected = selectedDragItemIds.has(selectionId);
  return {
    /** Reads a plain primary click: undefined when the row ignores it, otherwise whether it asks to rename. */
    plainClick: (event: MouseEvent<HTMLElement>, altRenames = false) => {
      if (event.button !== 0 || !gesture.isClick(event)) return undefined;
      const modified = event.metaKey || event.ctrlKey || event.shiftKey;
      const rename = titleDoubleClick(event, !modified && (altRenames || !event.altKey));
      return modified ? undefined : rename;
    },
    sortable,
    selected,
    selectionId,
    dropPosition: !pane && dropIndicator?.nodeId === item.nodeId ? dropIndicator.position : undefined,
    sourceDragging: draggedNodeId === item.nodeId,
    handleProps: {
      'aria-selected': selected,
      'data-item-drag': 'true',
      ...sortable.attributes,
      ...sortable.listeners,
      onPointerDownCapture: (event: PointerEvent<HTMLElement>) => {
        gesture.onPointerDownCapture(event);
        onDragSelectionPointerDown(dragData, orderedDragItems, {
          range: event.shiftKey,
          toggle: event.metaKey || event.ctrlKey,
        });
      },
    },
  };
}

/** A row's drop line and the guides marking its depth. */
export function TreeRowGuides({
  depth,
  dropIndicator,
  guides = true,
  position,
}: {
  depth: number;
  dropIndicator?: TreeDropIndicator;
  guides?: boolean;
  position?: TreeDropIndicator['position'];
}) {
  return (
    <>
      {(position === 'before' || position === 'after') && (
        <TreeDropPlaceholder
          depth={dropIndicator?.depth ?? depth}
          invalid={Boolean(dropIndicator?.invalid)}
          position={position}
        />
      )}
      {guides && depth > 0 && <span className="tree-depth-guides" aria-hidden="true" />}
    </>
  );
}

/** A closed folder shows how many items it holds. */
export function FolderIcon({ collapsed, count }: { collapsed: boolean; count: number }) {
  return (
    <span className="bookmark-folder-icon" aria-hidden="true">
      {collapsed ? (
        <>
          <Folder size={17} />
          <span className="folder-count">{count > 9 ? '9+' : count}</span>
        </>
      ) : (
        <FolderOpen size={17} />
      )}
    </span>
  );
}

/** A row's trailing icon button, a close button unless it is given other content. */
export function RowIconButton({
  children = <X size={14} aria-hidden="true" />,
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" className={`row-icon-button ${className}`} {...props}>
      {children}
    </button>
  );
}

/**
 * What a tree's surface shares: rows by node, the rows a drag carries, marquee
 * selection, and its keys.
 */
export function useTreeSurface({
  collapsedIds,
  draggedNodeId,
  listedItems,
  nodeAttribute,
  onDragSelectionChange,
  onToggle,
  orderedDragItems,
  pasteKind,
  selectedDragItemIds,
}: {
  collapsedIds: ReadonlySet<string>;
  draggedNodeId?: string;
  listedItems: readonly FlattenedTreeItem[];
  nodeAttribute: 'data-bookmark-node-id' | 'data-tab-node-id';
  onDragSelectionChange: (items: readonly SelectableDragItem[]) => void;
  onToggle: (id: string) => void;
  orderedDragItems: readonly SelectableDragItem[];
  pasteKind: 'bookmark-folder' | 'tab-folder';
  selectedDragItemIds: ReadonlySet<string>;
}) {
  const actions = useContext(ItemActionsContext);
  const dragItemsByNodeId = useMemo(() => new Map(
    orderedDragItems.flatMap((item) =>
      'nodeId' in item && item.nodeId ? [[item.nodeId, item] as const] : []),
  ), [orderedDragItems]);
  const liftedIds = useMemo(
    () => liftedDragNodeIds(orderedDragItems, selectedDragItemIds, draggedNodeId),
    [orderedDragItems, draggedNodeId, selectedDragItemIds],
  );
  const marquee = useMarqueeSelection({
    items: orderedDragItems,
    selectedItemIds: selectedDragItemIds,
    onSelectionChange: onDragSelectionChange,
  });
  const keyItems = useMemo(() => listedItems.flatMap((item) => {
    const dragItem = dragItemsByNodeId.get(item.nodeId);
    return dragItem ? [{ ...item, title: dragItem.title }] : [];
  }), [dragItemsByNodeId, listedItems]);
  const onKeyDown = useTreeKeyboard({
    collapsedIds,
    disabled: Boolean(draggedNodeId),
    items: keyItems,
    nodeAttribute,
    onToggle,
    onClipboard: (key, nodeId) => {
      const dragItem = dragItemsByNodeId.get(nodeId);
      if (!actions || !dragItem) return;
      if (key !== 'paste') {
        actions.clipboard(key, actions.itemsFor(dragItem));
        return;
      }
      const folder = listedItems.find((item) => item.nodeId === nodeId);
      if (folder?.isFolder) actions.paste({ folder, kind: pasteKind });
    },
  });
  return {
    dragItemsByNodeId,
    lifted: (item: FlattenedTreeItem) => isLiftedRow(item, liftedIds),
    surfaceProps: (className: string) => ({
      className: `${className} drag-selection-surface${marquee.marqueeSelecting ? ' is-marquee-selecting' : ''}`,
      ...marquee.marqueeHandlers,
      onKeyDown,
    }),
    marqueeOverlay: marquee.marqueeStyle && (
      <div className="drag-selection-marquee" style={marquee.marqueeStyle} aria-hidden="true" />
    ),
  };
}
