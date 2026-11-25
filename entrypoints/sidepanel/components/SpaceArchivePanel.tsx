import { useDroppable } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS as DndCSS } from '@dnd-kit/utilities';
import { Archive, X } from 'lucide-react';
import { type MouseEvent, type ReactNode } from 'react';
import type { Space } from '../../lib/bookmarks';
import { groupColourStyle } from '../lib/groupColour';
import type { DragItemData } from '../types';
import { sortableMenuKeyDown } from './ContextMenu';
import { WorkspaceOverlayStack } from './GlobalBookmarksPanel';
import type { SpaceDragPreview } from './SpacePagination';

const PANEL_ID = 'space-archive-panel';

/** Opens the archived spaces, and archives a space dropped on it. */
export function SpaceArchiveButton({
  activeDrag,
  arming,
  onToggle,
  open,
}: {
  activeDrag: DragItemData | undefined;
  arming: boolean;
  onToggle(): void;
  open: boolean;
}) {
  const dropZone = useDroppable({
    id: 'space-archive',
    data: { kind: 'space-archive' },
    disabled: activeDrag?.kind !== 'space',
  });
  const label = activeDrag?.kind === 'space' ? 'Archive space' : open ? 'Close archived spaces' : 'Archived spaces';
  return (
    <button
      ref={dropZone.setNodeRef}
      type="button"
      className={`space-pagination-action space-pagination-tail-action space-archive-button${open ? ' is-active' : ''}${dropZone.isOver ? ' is-over' : ''}${arming ? ' is-drag-arming' : ''}`}
      aria-label={label}
      aria-expanded={open}
      aria-controls={PANEL_ID}
      title={label}
      onClick={onToggle}
    >
      {open && !activeDrag
        ? <X size={14} aria-hidden="true" />
        : <Archive size={14} aria-hidden="true" />}
    </button>
  );
}

const groupColour = (space: Space) => groupColourStyle('--group-colour', space.colour);

/** What follows the pointer while a space is dragged: its pagination dot, or for an archived row the pill it returns as. */
export function SpaceDragOverlay({
  active,
  archived,
  overDot,
  preview,
  space,
}: {
  active: boolean;
  archived: boolean;
  /** Over a pagination dot, the preview lets the bar marking where it lands show through. */
  overDot: boolean;
  preview: SpaceDragPreview | undefined;
  space: Space;
}) {
  if (archived) {
    // The overlay takes the row's full width, so the pill is centred in it, on the pointer.
    return (
      <div className="space-drag-overlay-frame">
        <div
          className={`space-drag-overlay is-archived${overDot ? ' is-over-dot' : ''}`}
          data-group-colour={space.colour}
          style={groupColour(space)}
        >
          <span className="space-pagination-label" aria-hidden="true">{space.title}</span>
        </div>
      </div>
    );
  }
  return (
    <div
      className={`space-drag-overlay${active ? ' is-active' : ''}${preview?.dotMode ? ' is-dot-mode' : ''}${preview?.truncated ? ' is-truncated' : ''}${overDot ? ' is-over-dot' : ''}`}
      data-group-colour={space.colour}
      style={{ ...groupColour(space), ...(preview ? { width: preview.width, height: preview.height } : {}) }}
    >
      <span className="space-pagination-label" aria-hidden="true">
        {space.title}
      </span>
    </div>
  );
}

function ArchivedSpaceRow({
  activeDrag,
  onMenu,
  space,
}: {
  activeDrag: DragItemData | undefined;
  onMenu(event: MouseEvent<HTMLElement>, space: Space): void;
  space: Space;
}) {
  const sortable = useSortable({
    id: `archived-space:${space.id}`,
    data: { kind: 'space', spaceId: space.id, rootId: space.rootId, archived: true },
    // Only a space can be put among the archived ones.
    disabled: { draggable: false, droppable: Boolean(activeDrag && activeDrag.kind !== 'space') },
  });
  // A shown space dropped on a row lands before it; a row moved within the list shifts the others aside instead.
  const insertsBefore = sortable.isOver && activeDrag?.kind === 'space' && !activeDrag.archived;
  return (
    <li
      ref={sortable.setNodeRef}
      className={`archived-space-row${sortable.isDragging ? ' is-dragging' : ''}${insertsBefore ? ' is-insert-before' : ''}`}
      data-space-id={space.id}
      style={{
        ...groupColourStyle('--space-dot-colour', space.colour),
        transform: DndCSS.Transform.toString(sortable.transform),
        transition: sortable.transition,
      }}
      aria-label={space.title}
      {...sortable.attributes}
      {...sortable.listeners}
      onKeyDown={sortableMenuKeyDown(sortable.listeners)}
      onContextMenu={(event) => {
        // A drag owns the pointer; a menu opening over it would strand the drop.
        if (activeDrag) event.preventDefault();
        else onMenu(event, space);
      }}
    >
      <span className="archived-space-swatch" aria-hidden="true" />
      <span className="archived-space-title">{space.title}</span>
    </li>
  );
}

/** The space beneath the list, which takes a space dropped below every row as archived last. */
function ArchivedSpaceList({
  activeDrag,
  archivedSpaces,
  onMenu,
}: {
  activeDrag: DragItemData | undefined;
  archivedSpaces: readonly Space[];
  onMenu(event: MouseEvent<HTMLElement>, space: Space): void;
}) {
  const dropZone = useDroppable({
    id: 'space-archive-list',
    data: { kind: 'space-archive' },
    disabled: activeDrag?.kind !== 'space',
  });
  const appends = dropZone.isOver && activeDrag?.kind === 'space';
  return (
    <div ref={dropZone.setNodeRef} className={`archived-space-list${appends ? ' is-over' : ''}`}>
      {archivedSpaces.length === 0 ? (
        <p className="archived-space-empty">
          {activeDrag?.kind === 'space' ? 'Drop a space here to archive it' : 'No archived spaces'}
        </p>
      ) : (
        <ul aria-label="Archived spaces">
          <SortableContext
            items={archivedSpaces.map((space) => `archived-space:${space.id}`)}
            strategy={verticalListSortingStrategy}
          >
            {archivedSpaces.map((space) => (
              <ArchivedSpaceRow key={space.id} activeDrag={activeDrag} onMenu={onMenu} space={space} />
            ))}
          </SortableContext>
        </ul>
      )}
    </div>
  );
}

/**
 * Shows the archived spaces in place of the active space's tabs and bookmarks,
 * revealed from the pagination's archive button as the global bookmarks are
 * from theirs.
 */
export function SpaceArchiveStack({
  activeDrag,
  archivedSpaces,
  children,
  onMenu,
  open,
  reduceMotion,
}: {
  activeDrag: DragItemData | undefined;
  archivedSpaces: readonly Space[];
  /** The space's own panel. */
  children: ReactNode;
  onMenu(event: MouseEvent<HTMLElement>, space: Space): void;
  open: boolean;
  reduceMotion: boolean;
}) {
  return (
    <WorkspaceOverlayStack
      label="Archived spaces"
      open={open}
      panelId={PANEL_ID}
      reduceMotion={reduceMotion}
      content={<ArchivedSpaceList activeDrag={activeDrag} archivedSpaces={archivedSpaces} onMenu={onMenu} />}
    >
      {children}
    </WorkspaceOverlayStack>
  );
}
