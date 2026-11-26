import { useDroppable } from '@dnd-kit/core';
import { useSortable } from '@dnd-kit/sortable';
import { CSS as DndCSS } from '@dnd-kit/utilities';
import { Trash2 } from 'lucide-react';
import {
  AnimatePresence,
  motion,
  useIsPresent,
  usePresenceData,
  type Variants,
} from 'motion/react';
import {
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import type { Space } from '../../lib/bookmarks';
import { shortcutButtonProps, type ShortcutId } from '../../lib/shortcuts';
import type { TabGroupColour } from '../../lib/tabGroups';
import { groupColourStyle } from '../lib/groupColour';
import type { DragItemData } from '../types';
import { sortableMenuKeyDown } from './ContextMenu';
import { presenceMotion } from './WorkspaceMotion';

export function SpacePaginationButton({
  space,
  active,
  dragArming,
  dropActive,
  dropDisabled,
  hovered,
  colour,
  insertion,
  reduceMotion,
  onHover,
  onHoverEnd,
  onMenu,
  onSelect,
  shortcutId,
}: {
  space: Space;
  active: boolean;
  dragArming: boolean;
  dropActive: boolean;
  dropDisabled: boolean;
  hovered: boolean;
  colour: TabGroupColour | undefined;
  /** Which side of this dot a dragged space would land. */
  insertion?: 'before' | 'after';
  reduceMotion: boolean;
  onHover: (spaceId: string) => void;
  onHoverEnd: (spaceId: string) => void;
  onMenu: (event: ReactMouseEvent<HTMLElement>) => void;
  onSelect: () => void;
  /** The key that opens this space, while it can be opened. */
  shortcutId?: ShortcutId;
}) {
  const [arrivalEdge, setArrivalEdge] = useState<HorizontalPointerEdge>('left');
  const [departureEdge, setDepartureEdge] = useState<HorizontalPointerEdge>('right');
  const sortable = useSortable({
    id: `space:${space.id}`,
    data: { kind: 'space', spaceId: space.id, rootId: space.rootId },
    disabled: dropDisabled,
  });
  const shortcutProps = shortcutId && !dropDisabled
    ? shortcutButtonProps(shortcutId, space.title)
    : undefined;

  return (
    <button
      ref={sortable.setNodeRef}
      type="button"
      className={`space-pagination-dot${active ? ' is-active' : ''}${dropActive ? ' is-drop-target' : ''}${dropDisabled ? ' is-drop-disabled' : ''}${dropActive && !dropDisabled && sortable.isOver ? ' is-over' : ''}${sortable.isDragging ? ' is-dragging' : ''}${insertion ? ` is-insert-${insertion}` : ''}`}
      data-space-id={space.id}
      data-group-colour={colour}
      style={{
        ...groupColourStyle('--group-colour', colour),
        transform: DndCSS.Transform.toString(sortable.transform),
        '--space-sortable-transition': sortable.transition,
      } as CSSProperties}
      {...sortable.attributes}
      {...sortable.listeners}
      onKeyDown={sortableMenuKeyDown(sortable.listeners)}
      onContextMenu={onMenu}
      onPointerEnter={(event) => {
        const edge = horizontalPointerEdge(event);
        setArrivalEdge(edge);
        onHover(space.id);
      }}
      onPointerLeave={(event) => {
        const edge = horizontalPointerEdge(event);
        setDepartureEdge(edge);
        const relatedTarget = event.relatedTarget;
        if (
          relatedTarget instanceof Element &&
          relatedTarget.closest('.space-pagination-dot')
        ) return;
        onHoverEnd(space.id);
      }}
      onClick={onSelect}
      aria-label={`${dropDisabled ? 'Already in' : dropActive ? 'Drop in' : 'Open'} ${space.title}`}
      aria-current={active ? 'page' : undefined}
      {...shortcutProps}
      title={dropDisabled ? `Already in ${space.title}` : shortcutProps?.title ?? space.title}
      disabled={dropDisabled}
    >
      <span className="space-pagination-dot-visual">
        <AnimatePresence initial={!reduceMotion} custom={departureEdge}>
          {hovered && (
            <SpacePaginationHoverHighlight
              arrivalEdge={arrivalEdge}
              reduceMotion={reduceMotion}
            />
          )}
        </AnimatePresence>
        {dragArming && <span className="space-pagination-drag-arming" aria-hidden="true" />}
        <span className="space-pagination-label" aria-hidden="true">
          {space.title}
        </span>
      </span>
    </button>
  );
}

type HorizontalPointerEdge = 'left' | 'right';

function horizontalPointerEdge(
  event: ReactPointerEvent<HTMLElement>,
): HorizontalPointerEdge {
  const bounds = event.currentTarget.getBoundingClientRect();
  return event.clientX < bounds.left + bounds.width / 2 ? 'left' : 'right';
}

const spacePaginationHighlightVariants: Variants = {
  hidden: { scaleX: 0 },
  visible: { scaleX: 1 },
};

function SpacePaginationHoverHighlight({
  arrivalEdge,
  reduceMotion,
}: {
  arrivalEdge: HorizontalPointerEdge;
  reduceMotion: boolean;
}) {
  const isPresent = useIsPresent();
  const departureEdge = usePresenceData() as HorizontalPointerEdge | undefined;
  const edge = isPresent ? arrivalEdge : departureEdge ?? arrivalEdge;

  return (
    <motion.span
      className="space-pagination-hover-highlight"
      style={{ transformOrigin: `${edge} center` }}
      variants={spacePaginationHighlightVariants}
      animate="visible"
      {...presenceMotion(reduceMotion, 'hidden', 'hidden', { scaleX: { duration: 0.18, ease: [0.2, 0.75, 0.25, 1] } })}
      aria-hidden="true"
    />
  );
}

export interface SpaceDragPreview {
  width: number;
  height: number;
  dotMode: boolean;
  truncated: boolean;
}

const SPACE_PAGINATION_MIN_ITEM_WIDTH = 28;
const SPACE_PAGINATION_DOT_ITEM_WIDTH = 18;

export function updateSpacePaginationLayout(items: HTMLElement): void {
  const dots = Array.from(
    items.querySelectorAll<HTMLElement>('.space-pagination-dot'),
  );
  if (dots.length === 0) return;
  const tailActions = Array.from(items.querySelectorAll<HTMLElement>(
    '.space-pagination-tail-action',
  ));
  if (tailActions.length === 0) return;
  items.classList.remove('hide-add-space');
  clipSpacePaginationDots(items, false);
  const itemsStyle = getComputedStyle(items);
  const gap = Number.parseFloat(itemsStyle.columnGap) || 0;
  const tailActionsWidth = tailActions.reduce((width, action) => {
    const actionStyle = getComputedStyle(action);
    return width + action.getBoundingClientRect().width +
      (Number.parseFloat(actionStyle.marginLeft) || 0) +
      (Number.parseFloat(actionStyle.marginRight) || 0);
  }, 0);
  const totalGapWidth = gap * Math.max(0, dots.length + tailActions.length - 1);
  const availableWidth = items.getBoundingClientRect().width;
  const textMinimumWidth = dots.length * SPACE_PAGINATION_MIN_ITEM_WIDTH +
    tailActionsWidth + totalGapWidth;
  const dotMode = textMinimumWidth > availableWidth;
  items.classList.toggle('is-dot-mode', dotMode);
  if (dotMode) {
    dots.forEach((dot) => dot.classList.remove('is-truncated'));
    items.style.removeProperty('--space-pagination-item-cap');
    const dotsWithAddWidth = dots.length * SPACE_PAGINATION_DOT_ITEM_WIDTH +
      tailActionsWidth + totalGapWidth;
    items.classList.toggle('hide-add-space', dotsWithAddWidth > availableWidth);
    clipSpacePaginationDots(items, true);
    return;
  }
  const availableItemWidth = availableWidth - tailActionsWidth - totalGapWidth;
  const intrinsicWidths = dots.map((dot) => {
    const label = dot.querySelector<HTMLElement>('.space-pagination-label');
    return Math.max(
      SPACE_PAGINATION_MIN_ITEM_WIDTH,
      (label?.scrollWidth ?? 0) + 8,
    );
  }).sort((left, right) => left - right);
  let remainingWidth = availableItemWidth;
  let remainingItems = intrinsicWidths.length;
  let itemCap = intrinsicWidths.at(-1) ?? SPACE_PAGINATION_MIN_ITEM_WIDTH;
  for (const intrinsicWidth of intrinsicWidths) {
    const sharedWidth = remainingWidth / remainingItems;
    if (intrinsicWidth > sharedWidth) {
      itemCap = Math.max(SPACE_PAGINATION_MIN_ITEM_WIDTH, sharedWidth);
      break;
    }
    remainingWidth -= intrinsicWidth;
    remainingItems -= 1;
  }
  items.style.setProperty('--space-pagination-item-cap', `${itemCap}px`);
  dots.forEach((dot) => {
    const label = dot.querySelector<HTMLElement>('.space-pagination-label');
    dot.classList.toggle(
      'is-truncated',
      Boolean(label && label.scrollWidth > label.clientWidth + 0.5),
    );
  });
}

/**
 * Dots too many for their row stay on it, clipped: the row scrolls to centre
 * the active space's dot as far as it can, and fades at each edge that clips
 * a dot.
 */
function clipSpacePaginationDots(items: HTMLElement, dotMode: boolean): void {
  const row = items.querySelector<HTMLElement>('.space-pagination-dots');
  if (!row) return;
  const overflow = dotMode ? row.scrollWidth - row.clientWidth : 0;
  const clipped = overflow > 0.5;
  items.classList.toggle('is-clipped', clipped);
  const active = clipped ? row.querySelector<HTMLElement>('.space-pagination-dot.is-active') : null;
  const centre = active
    ? active.getBoundingClientRect().left + active.getBoundingClientRect().width / 2 -
      row.getBoundingClientRect().left + row.scrollLeft
    : 0;
  const scroll = active ? Math.min(overflow, Math.max(0, centre - row.clientWidth / 2)) : 0;
  row.scrollLeft = scroll;
  row.classList.toggle('clips-start', scroll > 0.5);
  row.classList.toggle('clips-end', clipped && scroll < overflow - 0.5);
}

export function SpacePaginationTrashTarget({
  disabled,
  label,
}: {
  disabled: boolean;
  label: string;
}) {
  const dropZone = useDroppable({
    id: 'trash',
    data: { kind: 'trash' },
    disabled,
  });

  return (
    <button
      ref={dropZone.setNodeRef}
      type="button"
      className={`space-pagination-action space-pagination-tail-action space-pagination-trash-target${dropZone.isOver ? ' is-over' : ''}`}
      aria-label={label}
      title={label}
      disabled={disabled}
    >
      <span className="space-pagination-trash-visual" aria-hidden="true">
        <Trash2 size={14} />
        <span className="space-pagination-trash-label">{label}</span>
      </span>
    </button>
  );
}

export function paginationTrashLabel(
  source: DragItemData,
  title: string,
  itemCount: number,
): string {
  if (source.kind === 'space') return `Delete ${title}`;
  if (source.kind === 'external') return 'Nothing to delete';
  if (itemCount > 1) {
    if (source.kind === 'tab' || source.kind === 'session-tab') return `Close ${itemCount} tabs`;
    if (source.kind === 'tab-folder') return `Delete ${itemCount} tab folders`;
    return `Delete ${itemCount} bookmarks`;
  }
  if (source.kind === 'tab' || source.kind === 'session-tab') return `Close ${title} tab`;
  if (source.kind === 'tab-folder') return `Delete ${title} tab folder`;
  if (source.kind === 'tree' && source.isFolder) return `Delete ${title} bookmark folder`;
  return `Delete ${title} bookmark`;
}
