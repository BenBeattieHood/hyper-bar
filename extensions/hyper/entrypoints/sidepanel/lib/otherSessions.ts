import {
  deriveSpaces,
  isTabBackingBookmark,
  tabBackingInstallationId,
  type BookmarkNode,
} from '../../lib/bookmarks';
import type { MoveSessionTabPayload } from '../../lib/modelIntentPayloads';
import type { DragItemData, SelectableDragItem } from '../types';
import { autoTabFolderIdentity, projectAutoTabFolders } from '../../lib/autoTabFolders';

/** The tabs another session keeps in a space: another device's, or an installation of Hyper this one replaced. */
export interface OtherSession {
  /** The installation ID its backings carry; empty for backings from before installations had one. */
  id: string;
  /** When it last kept a new tab, in any space. */
  lastKeptAt?: number;
  /** Its backings in the space, in the order the space's tab tree holds them. */
  tabs: BookmarkNode[];
}

/** Every session but this installation's, the most recently active first, with its tabs in `spaceId`. */
export function otherSessions(
  tree: BookmarkNode[],
  spaceId: string | undefined,
  localInstallationId: string | undefined,
): OtherSession[] {
  if (!localInstallationId) return [];
  const sessions = new Map<string, OtherSession>();
  for (const space of deriveSpaces(tree)) {
    for (const backing of space.children) {
      if (!isTabBackingBookmark(backing)) continue;
      const id = tabBackingInstallationId(backing) ?? '';
      if (id === localInstallationId) continue;
      const session = sessions.get(id) ?? { id, tabs: [] };
      if (backing.dateAdded !== undefined) {
        session.lastKeptAt = Math.max(session.lastKeptAt ?? 0, backing.dateAdded);
      }
      if (space.id === spaceId) session.tabs.push(backing);
      sessions.set(id, session);
    }
  }
  return [...sessions.values()].sort((left, right) => (right.lastKeptAt ?? 0) - (left.lastKeptAt ?? 0));
}

/** A session's tabs gathered into a folder per site, as autofolders gather this window's top-level tabs. */
export function sessionTabFolders(tabs: readonly BookmarkNode[]): BookmarkNode[] {
  return projectAutoTabFolders(tabs, 'other-session', (node) => autoTabFolderIdentity({ url: node.url })).nodes;
}

const landsInWindow = (target: DragItemData) =>
  target.kind === 'tab' || target.kind === 'tab-folder' || target.kind === 'tabs-zone';

/** Where a page dropped in the bookmarks lands as a bookmark. */
export const landsInBookmarks = (target: DragItemData) =>
  target.kind === 'tree' || target.kind === 'tree-zone' ||
  target.kind === 'bookmarks-trigger' || target.kind === 'global-bookmarks';

export type SessionTabItem = Extract<SelectableDragItem, { kind: 'session-tab' }>;

/** Other sessions' tabs a drag or paste carries: the selection's, when it holds the one grabbed. */
export function sessionTabsIn(
  source: DragItemData | undefined,
  selected: readonly SelectableDragItem[],
): SessionTabItem[] {
  if (source?.kind !== 'session-tab') return [];
  const tabs = selected.filter((item): item is SessionTabItem => item.kind === 'session-tab');
  return tabs.some((item) => item.nodeId === source.nodeId) ? tabs : [source];
}

/**
 * A drop between sessions that cannot happen: another session's tab anywhere
 * but this window's tab tree, the bookmarks, the bin or a session, or a
 * session given anything but this window's backed tabs.
 */
export function sessionDropRefused(
  source: DragItemData | undefined,
  target: DragItemData,
  selected: readonly SelectableDragItem[],
): boolean {
  if (source?.kind === 'session-tab') {
    return !landsInWindow(target) && !landsInBookmarks(target) &&
      target.kind !== 'session-zone' && target.kind !== 'trash';
  }
  if (target.kind !== 'session-zone') return false;
  const items: readonly DragItemData[] = selected.length > 0 ? selected : source ? [source] : [];
  return !target.installationId || items.length === 0 ||
    items.some((item) => item.kind !== 'tab' || !item.backingId);
}

type WindowDestination = Extract<MoveSessionTabPayload['destination'], { tree: unknown }>;
type BookmarkDestination = Extract<MoveSessionTabPayload['destination'], { bookmarks: unknown }>['bookmarks'];

/** The `offset`th of several tabs going to one place, each after the one before. */
const nthDestination = (
  destination: WindowDestination | { bookmarks: BookmarkDestination } | { installationId: string },
  offset: number,
): MoveSessionTabPayload['destination'] => {
  if ('tree' in destination) {
    return {
      index: destination.index < 0 ? destination.index : destination.index + offset,
      tree: {
        ...destination.tree,
        ...(destination.tree.index === undefined ? {} : { index: destination.tree.index + offset }),
      },
    };
  }
  if ('bookmarks' in destination && destination.bookmarks.index !== undefined) {
    return { bookmarks: { ...destination.bookmarks, index: destination.bookmarks.index + offset } };
  }
  return destination;
};

/**
 * What a drop moves between sessions, or undefined for a drop that is not
 * between them. `windowDestination` is where a tab dropped among this window's
 * tabs goes, and `bookmarkDestination` where one dropped in the bookmarks
 * does. Another session's tabs dropped on the bin close, which is not a move.
 */
export function sessionTabMoves({
  bookmarkDestination,
  copy,
  selected,
  source,
  target,
  windowDestination,
}: {
  bookmarkDestination?: BookmarkDestination;
  copy: boolean;
  selected: readonly SelectableDragItem[];
  source: DragItemData;
  target: DragItemData;
  windowDestination?: WindowDestination;
}): MoveSessionTabPayload[] | undefined {
  if (source.kind === 'session-tab') {
    if (target.kind === 'trash') return undefined;
    const tabs = sessionTabsIn(source, selected).filter((item) =>
      target.kind !== 'session-zone' || item.installationId !== target.installationId);
    const destination = target.kind === 'session-zone'
      ? target.installationId ? { installationId: target.installationId } : undefined
      : landsInWindow(target)
        ? windowDestination
        : landsInBookmarks(target) && bookmarkDestination ? { bookmarks: bookmarkDestination } : undefined;
    return destination
      ? tabs.map((item, offset) => ({
          copy,
          destination: nthDestination(destination, offset),
          source: { backingId: item.nodeId },
        }))
      : [];
  }
  if (target.kind !== 'session-zone') return undefined;
  if (sessionDropRefused(source, target, selected)) return [];
  return (selected.length > 0 ? selected : [source]).flatMap((item) => item.kind === 'tab'
    ? [{ copy, destination: { installationId: target.installationId }, source: { tabId: item.tabId } }]
    : []);
}
