import { createPageBookmark } from './bookmarkOperations';
import { isTabBackingBookmark } from './bookmarks';
import {
  bookmarkById,
  copyBackingToSession,
  installationId as localInstallationId,
  moveBackingToSession,
  sessionBackingPage,
} from './bookmarkStorage';
import type { MoveSessionTabPayload } from './modelIntentPayloads';
import { setTabOwnership, type TabOwnership } from './tabOwnership';
import { tabById } from './tabs';

export interface SessionTabDependencies {
  getTabOwnership(tabId: number): Promise<TabOwnership | undefined>;
  markIntentionalTab(tabId: number): void;
  moveTabTreeNodes(
    spaceId: string,
    nodeIds: readonly string[],
    destination: { index?: number; parentId: string },
  ): Promise<void>;
  routeTab(tabId: number, fallbackSpaceId?: string): Promise<void>;
}

type WindowDestination = Extract<MoveSessionTabPayload['destination'], { tree: unknown }>;
type BookmarkDestination = Extract<MoveSessionTabPayload['destination'], { bookmarks: unknown }>;

/**
 * Bookmarks another session's tab in a folder. Moving it there also takes it
 * out of its session; a device still running that session keeps its own tab
 * open, since no browser lets an extension close another device's tabs.
 */
async function bookmarkInFolder(
  backingId: string,
  copy: boolean,
  { bookmarks }: BookmarkDestination,
): Promise<void> {
  const page = await sessionBackingPage(backingId);
  await createPageBookmark(page, bookmarks, {
    createBookmark: (details) => browser.bookmarks.create(details),
    getBookmarkChildren: (parentId) => browser.bookmarks.getChildren(parentId),
  });
  if (!copy) await browser.bookmarks.remove(backingId);
}

/** Opens another session's tab in this window, where it was dropped in the space's tab tree. */
async function openInWindow(
  backingId: string,
  copy: boolean,
  windowId: number,
  { index, tree }: WindowDestination,
  dependencies: SessionTabDependencies,
): Promise<void> {
  // Taking a tab over keeps its backing, with its name and place; a copy gets a backing of its own.
  const location = copy ? undefined : await moveBackingToSession(backingId, {
    installationId: await localInstallationId(),
    spaceId: tree.spaceId,
    windowId,
  });
  const kept = location ? undefined : await bookmarkById(backingId);
  const url = location?.url ?? (kept && isTabBackingBookmark(kept) ? kept.url : undefined);
  if (!url) throw new Error('That tab is no longer kept in a space.');
  const place = async (nodeId: string) => {
    if (tree.parentId === undefined) return;
    await dependencies.moveTabTreeNodes(tree.spaceId, [nodeId], {
      parentId: tree.parentId,
      ...(tree.index === undefined ? {} : { index: tree.index }),
    });
  };
  if (location) await place(location.backingId);
  const tab = await browser.tabs.create({ active: false, url, windowId, ...(index >= 0 ? { index } : {}) });
  if (tab.id === undefined) throw new Error('The tab could not be opened.');
  dependencies.markIntentionalTab(tab.id);
  if (location) await setTabOwnership(tab.id, location);
  await dependencies.routeTab(tab.id, tree.spaceId);
  if (location) return;
  const ownership = await dependencies.getTabOwnership(tab.id);
  if (ownership?.spaceId === tree.spaceId && ownership.backingId) await place(ownership.backingId);
}

/**
 * Moves a tab between this session and the others Hyper keeps tabs for: other
 * devices, and installations this one replaced, each named by the installation
 * ID on its backings. Another session keeps a tab parked until it opens the
 * tab's space; moving one hands its backing over, and copying keeps another.
 * Another session's tab can also become a bookmark, leaving its session when
 * moved.
 */
export async function moveSessionTab(
  { copy, destination, source }: MoveSessionTabPayload,
  windowId: number,
  dependencies: SessionTabDependencies,
): Promise<void> {
  if ('bookmarks' in destination) {
    if (!('backingId' in source)) throw new Error('A tab of this window is bookmarked as itself.');
    await bookmarkInFolder(source.backingId, copy, destination);
    return;
  }
  if (!('installationId' in destination)) {
    if (!('backingId' in source)) throw new Error('A tab of this window stays in this session.');
    await openInWindow(source.backingId, copy, windowId, destination, dependencies);
    return;
  }
  if (destination.installationId === await localInstallationId()) {
    throw new Error('This session keeps its tabs in its windows.');
  }
  if ('backingId' in source) {
    if (copy) await copyBackingToSession(source.backingId, destination.installationId);
    else await moveBackingToSession(source.backingId, { installationId: destination.installationId });
    return;
  }
  const [tab, ownership] = await Promise.all([
    tabById(source.tabId),
    dependencies.getTabOwnership(source.tabId),
  ]);
  if (tab?.windowId !== windowId || !ownership?.backingId) {
    throw new Error('That tab cannot be kept by another session.');
  }
  await copyBackingToSession(ownership.backingId, destination.installationId);
  // Closing the tab removes its own backing, leaving the other session's in its place.
  if (!copy) await browser.tabs.remove(source.tabId);
}
