import type { Space } from '../../lib/bookmarks';
import { paginationTrashLabel } from '../components/SpacePagination';
import type { DragItemData, SelectableDragItem } from '../types';
import { dragOverlayAction, trashDropAction } from './drag';
import { dragSelectionCount } from './dragSelection';

export function dragPresentation({
  activeDrag,
  activeDragItems,
  archivedSpaces,
  copyModifierActive,
  dragOverTarget,
  dropForbidden,
  spaces,
}: {
  activeDrag: DragItemData | undefined;
  activeDragItems: readonly SelectableDragItem[];
  archivedSpaces: readonly Space[];
  copyModifierActive: boolean;
  dragOverTarget: DragItemData | undefined;
  dropForbidden: boolean;
  spaces: readonly Space[];
}) {
  const activeDragSpace = activeDrag?.kind === 'space'
    ? [...spaces, ...archivedSpaces].find((space) => space.id === activeDrag.spaceId)
    : undefined;
  const activeDragTitle = activeDragSpace?.title ?? (activeDrag && 'title' in activeDrag
    ? activeDrag.title
    : 'Item');
  const mediaControlsDragDisabled = activeDrag?.kind === 'tab' ||
    activeDrag?.kind === 'tree' && activeDrag.isFolder;
  const activeDragCount = activeDrag?.kind === 'external'
    ? activeDrag.itemCount
    : dragSelectionCount(activeDragItems);
  const activeDragTrashLabel = activeDrag
    ? paginationTrashLabel(activeDrag, activeDragTitle, activeDragCount)
    : undefined;
  // The last shown space cannot go, but an archived one always can.
  const activeDragTrashDisabled = activeDrag?.kind === 'space'
    ? !activeDrag.archived && spaces.length <= 1
    : activeDrag
      ? !trashDropAction(activeDrag)
      : true;
  const dragAction = activeDrag && dragOverTarget
    ? dragOverlayAction(
        activeDrag,
        dragOverTarget,
        copyModifierActive,
        dropForbidden,
      )
    : undefined;
  return {
    activeDragCount,
    activeDragSpace,
    activeDragTitle,
    activeDragTrashDisabled,
    activeDragTrashLabel,
    dragAction,
    mediaControlsDragDisabled,
  };
}
