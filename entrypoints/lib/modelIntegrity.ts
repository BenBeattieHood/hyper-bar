import {
  BOOKMARKS_FOLDER_TITLE,
  FAVOURITES_FOLDER_TITLE,
  HYPER_FOLDER_TITLE,
  SPACES_FOLDER_TITLE,
  childFoldersTitled,
  findBookmarkBar,
  type BookmarkNode,
} from './bookmarks';

/**
 * Structural roots are the one part of the tree Hyper creates for itself, so a
 * missing root is indistinguishable from a fresh install unless the read is
 * first proven complete. Assessing health separately from deriving the model
 * keeps repair from ever running against a partial observation.
 */

export type StructuralRole = 'bookmarks' | 'favourites' | 'hyper' | 'spaces';

export interface AmbiguousRole {
  ids: readonly string[];
  role: StructuralRole;
}

export type StructureHealth =
  | { duplicates: readonly AmbiguousRole[]; status: 'ambiguous' }
  | { missing: readonly StructuralRole[]; status: 'incomplete' }
  | { status: 'absent' }
  | { status: 'healthy' }
  | { status: 'unreadable' };

const roleTitles: Readonly<Record<Exclude<StructuralRole, 'hyper'>, string>> = {
  bookmarks: BOOKMARKS_FOLDER_TITLE,
  favourites: FAVOURITES_FOLDER_TITLE,
  spaces: SPACES_FOLDER_TITLE,
};

export function assessStructureHealth(tree: readonly BookmarkNode[]): StructureHealth {
  const bookmarkBar = findBookmarkBar([...tree]);
  // A tree without a bookmark bar is a failed or partial read, never an install.
  if (!bookmarkBar) return { status: 'unreadable' };

  const hyperFolders = childFoldersTitled(bookmarkBar, HYPER_FOLDER_TITLE);
  if (hyperFolders.length === 0) return { status: 'absent' };
  if (hyperFolders.length > 1) {
    return {
      duplicates: [{ ids: hyperFolders.map((node) => node.id), role: 'hyper' }],
      status: 'ambiguous',
    };
  }

  const duplicates: AmbiguousRole[] = [];
  const missing: StructuralRole[] = [];
  for (const [role, title] of Object.entries(roleTitles)) {
    const matches = childFoldersTitled(hyperFolders[0], title);
    if (matches.length === 0) missing.push(role as StructuralRole);
    else if (matches.length > 1) {
      duplicates.push({ ids: matches.map((node) => node.id), role: role as StructuralRole });
    }
  }
  if (duplicates.length > 0) return { duplicates, status: 'ambiguous' };
  return missing.length > 0 ? { missing, status: 'incomplete' } : { status: 'healthy' };
}

/**
 * Repair only ever creates the roots that are absent. It never merges, moves, or
 * deletes, because every one of those choices can destroy content the user put
 * there, so an ambiguous tree is reported rather than resolved by guesswork.
 */
export function structuralRepairRoles(health: StructureHealth): readonly StructuralRole[] {
  if (health.status === 'absent') return ['hyper', 'favourites', 'spaces', 'bookmarks'];
  return health.status === 'incomplete' ? health.missing : [];
}

export function isModelUsable(health: StructureHealth): boolean {
  return health.status === 'healthy' || health.status === 'incomplete';
}

/**
 * A backing the user drags out of the hidden `tabs` folder stops being a
 * backing. The move is respected rather than reverted: the node stays where it
 * was put and its tab becomes loose, which is the only outcome that neither
 * fights the user nor leaves a hidden node in a visible folder.
 */
export type BackingRelocation =
  | { spaceId: string; status: 'reassigned' }
  | { status: 'released' }
  | { status: 'retained' };

export function classifyBackingRelocation(
  parentId: string | undefined,
  spaceIdsByTabsFolderId: ReadonlyMap<string, string>,
  previousSpaceId: string | undefined,
): BackingRelocation {
  const spaceId = parentId === undefined ? undefined : spaceIdsByTabsFolderId.get(parentId);
  if (spaceId === undefined) return { status: 'released' };
  return spaceId === previousSpaceId ? { status: 'retained' } : { spaceId, status: 'reassigned' };
}
