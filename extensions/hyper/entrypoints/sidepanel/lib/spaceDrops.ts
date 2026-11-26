import type { BookmarkNode, Space } from '../../lib/bookmarks';
import type { useBrowserState } from '../hooks/useBrowserState';
import type { useSpaceDeletion } from '../components/SpaceDeletePrompt';
import type { DragItemData } from '../types';
import { spaceReorderAtIndexDestination } from './drag';

type SpaceDragItem = Extract<DragItemData, { kind: 'space' }>;

export interface SpaceDropDependencies {
  archivedSpaces: readonly Space[];
  browserState: Pick<ReturnType<typeof useBrowserState>, 'moveBookmark' | 'setSpaceArchived' | 'spacesFolderId'>;
  nodeMap: ReadonlyMap<string, BookmarkNode>;
  spaceDeletion: Pick<ReturnType<typeof useSpaceDeletion>, 'request'>;
  /** The spaces pagination shows. */
  spaces: readonly Space[];
}

/**
 * Where a space dragged over another lands: the pagination and the archived
 * list each keep their own order, and a space crossing between them archives
 * or unarchives it. `after` says which half of a pagination dot it was dropped
 * on, so a space lands beside that dot's nearer edge.
 */
export async function performSpaceDrop(
  source: SpaceDragItem,
  target: DragItemData,
  after: boolean,
  { archivedSpaces, browserState, nodeMap, spaceDeletion, spaces }: SpaceDropDependencies,
): Promise<void> {
  const keepsAShownSpace = source.archived || spaces.length > 1;
  if (target.kind === 'trash') {
    const node = nodeMap.get(source.spaceId);
    if (node && keepsAShownSpace) await spaceDeletion.request(node);
    return;
  }
  if (target.kind === 'space-archive') {
    if (keepsAShownSpace) await browserState.setSpaceArchived(source.spaceId, true);
    return;
  }
  if (target.kind !== 'space' || target.spaceId === source.spaceId) return;
  if (target.archived) {
    if (!keepsAShownSpace) return;
    const sourceIndex = archivedSpaces.findIndex((space) => space.id === source.spaceId);
    const targetIndex = archivedSpaces.findIndex((space) => space.id === target.spaceId);
    if (targetIndex < 0) return;
    // A row moved down the list lands after the row it was dropped on, as the list shifted to show.
    const beforeSpaceId = sourceIndex >= 0 && sourceIndex < targetIndex
      ? archivedSpaces[targetIndex + 1]?.id
      : target.spaceId;
    await browserState.setSpaceArchived(source.spaceId, true, beforeSpaceId);
    return;
  }
  const targetIndex = spaces.findIndex((space) => space.id === target.spaceId);
  if (targetIndex < 0) return;
  if (source.archived) {
    await browserState.setSpaceArchived(
      source.spaceId,
      false,
      after ? spaces[targetIndex + 1]?.id : target.spaceId,
    );
    return;
  }
  const sourceIndex = spaces.findIndex((space) => space.id === source.spaceId);
  const spacesFolderId = browserState.spacesFolderId;
  if (sourceIndex < 0 || !spacesFolderId) return;
  const destination = spaceReorderAtIndexDestination(
    spaces,
    source.spaceId,
    targetIndex + (after ? 1 : 0),
    spacesFolderId,
  );
  if (destination?.index === undefined) return;
  // Archived spaces sit between shown ones in the folder, so a pagination position is not a folder index.
  const folder = nodeMap.get(spacesFolderId)?.children ?? [];
  const beforeSpace = spaces[destination.index];
  const anchor = folder.findIndex((node) => node.id === (beforeSpace ?? spaces.at(-1))?.id);
  if (anchor < 0) return;
  await browserState.moveBookmark(source.spaceId, {
    parentId: spacesFolderId,
    index: beforeSpace ? anchor : anchor + 1,
  });
}
