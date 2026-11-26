import { withNamedAsyncLock } from './async';
import {
  deriveSpaces,
  neighbourShownSpace,
  spaceBookmarkTitleWithArchived,
  tabBackingTitleInWindow,
} from './bookmarks';
import {
  bookmarkById,
  ensureHyperBookmarkStructure,
  installationId,
  type TabBackingLocation,
} from './bookmarkStorage';
import type { SetSpaceArchivedPayload } from './modelIntentPayloads';
import { loadTabOwnerships, tabsOwnedBySpace, type TabOwnership } from './tabOwnership';
import type { WindowSpaceChoice } from './windowSpaceChoice';
import { getWindowActiveSpaceId } from './windowState';

export interface SpaceArchiveDependencies {
  closeTabs(tabIds: number[]): Promise<void>;
  persistTabOwnership(tabId: number, ownership: TabOwnership): Promise<void>;
  queueMutation<Result>(operation: () => Promise<Result>): Promise<Result>;
  tabBackingLocations: Map<number, TabBackingLocation>;
  /** Read when archiving runs: the background builds this before its window choice. */
  windowSpaces(): Pick<WindowSpaceChoice, 'select' | 'switchTo'>;
}

const mutationLock = (spaceId: string) => `hyper:space-mutation:${spaceId}`;

async function readSpaces() {
  const structure = await ensureHyperBookmarkStructure();
  return { spaces: deriveSpaces(await browser.bookmarks.getTree()), spacesFolderId: structure.spaces.id };
}

/**
 * Archiving hides a space from pagination and parks its tabs; unarchiving
 * brings it back, and its parked tabs reopen when a window next shows it. The
 * space keeps its folder, bookmarks and backings throughout, so nothing in it
 * is lost either way.
 */
export function createSpaceArchive(dependencies: SpaceArchiveDependencies) {
  /** Flags the folder and moves it before `beforeSpaceId`, or last among the spaces without one. */
  const place = async ({ archived, beforeSpaceId, spaceId }: SetSpaceArchivedPayload) => {
    const { spaces, spacesFolderId } = await readSpaces();
    const space = spaces.find((candidate) => candidate.id === spaceId);
    if (!space) throw new Error('This space no longer exists.');
    if (archived && !space.archived && !neighbourShownSpace(spaces, spaceId)) {
      throw new Error('At least one space must stay unarchived.');
    }
    const [folder] = await browser.bookmarks.get(spaceId);
    if (!folder) throw new Error('This space no longer exists.');
    const title = spaceBookmarkTitleWithArchived(folder, archived);
    if (title !== folder.title) await browser.bookmarks.update(spaceId, { title });
    const before = await bookmarkById(beforeSpaceId);
    const index = before?.parentId === spacesFolderId ? before.index : undefined;
    // The browser counts a move's index before taking the folder out, so a folder's own index places it before its successor.
    await browser.bookmarks.move(spaceId, {
      parentId: spacesFolderId,
      ...(index === undefined ? {} : { index }),
    });
  };

  /** Each normal window showing the space, and the shown space each moves to. */
  const windowsShowing = async (spaceId: string) => {
    const { spaces } = await readSpaces();
    const replacement = neighbourShownSpace(spaces, spaceId);
    if (!replacement) throw new Error('At least one space must stay unarchived.');
    const windows = await browser.windows.getAll({ windowTypes: ['normal'] });
    const showing = await Promise.all(windows.map(async (window) =>
      window.id !== undefined && !window.incognito && await getWindowActiveSpaceId(window.id) === spaceId
        ? [window.id]
        : []));
    return { replacement: replacement.id, windowIds: showing.flat() };
  };

  /**
   * Closes the space's tabs in every window while keeping their backings,
   * which forget their window so the space reopens them wherever it is next
   * shown. Each tab lets go of its backing first, so its closing removes none.
   */
  const parkSpaceTabs = async (spaceId: string) => {
    const tabs = await browser.tabs.query({});
    const ownerships = await loadTabOwnerships(tabs);
    const owned = tabsOwnedBySpace(tabs, ownerships, spaceId).filter((tab) => !tab.pinned);
    const installation = await installationId();
    for (const tab of owned) {
      const tabId = tab.id as number;
      const ownership = ownerships[tabId];
      const backing = await bookmarkById(ownership?.backingId);
      if (backing?.url) {
        await browser.bookmarks.update(backing.id, {
          title: tabBackingTitleInWindow(backing.title, undefined, installation),
        });
      }
      dependencies.tabBackingLocations.delete(tabId);
      await dependencies.persistTabOwnership(tabId, {
        spaceId,
        ...(ownership?.windowId === undefined ? {} : { windowId: ownership.windowId }),
      });
    }
    await dependencies.closeTabs(owned.map((tab) => tab.id as number));
  };

  const archive = async (payload: SetSpaceArchivedPayload) => {
    const { spaceId } = payload;
    // Windows leave the space while it is still shown, so none is left on a space it cannot show.
    const { replacement, windowIds } = await dependencies.queueMutation(() => windowsShowing(spaceId));
    for (const windowId of windowIds) {
      // A full switch, as the sidebar makes, so a window with no tabs in the replacement opens one.
      const client = { role: 'sidebar', windowId };
      dependencies.windowSpaces().select(replacement, client);
      await dependencies.windowSpaces().switchTo(replacement, client);
    }
    await dependencies.queueMutation(() => withNamedAsyncLock(mutationLock(spaceId), async () => {
      await place(payload);
      await parkSpaceTabs(spaceId);
    }));
  };

  const setSpaceArchived = (payload: SetSpaceArchivedPayload) => payload.archived
    ? archive(payload)
    : dependencies.queueMutation(() => withNamedAsyncLock(mutationLock(payload.spaceId), () => place(payload)));

  return { setSpaceArchived };
}
