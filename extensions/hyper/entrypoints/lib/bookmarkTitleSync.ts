import {
  bookmarkTitleUpdatesFollowingPageTitle,
  customBookmarkTitleMatches,
  findHyperBookmarkStructure,
  isSpaceBookmarksFolder,
  tabBackingBookmarkLink,
  type BookmarkNode,
  type BrowserTab,
} from './bookmarks';
import { isAppliedTabName } from './tabBookmarkLink';
import { canSyncBookmarkTitleFromTab, isPlaceholderTabTitle } from './tabs';
import { tabUrl } from './urlIdentity';

/**
 * A page title lands on every Hyper bookmark that points at the same page, not
 * just the one backing the tab. The tab's own backing is checked first: a
 * bookmark the user has renamed keeps its name, and renaming it is a statement
 * about the page, so the rest of the tree is left alone too.
 */
export interface BookmarkTitleSyncPorts {
  get: (id: string) => Promise<BookmarkNode[]>;
  getTree: () => Promise<BookmarkNode[]>;
  update: (id: string, changes: { title: string }) => Promise<unknown>;
}

export async function syncBookmarkTitlesFollowingPage(
  ports: BookmarkTitleSyncPorts,
  page: { title: string; url: string | undefined },
  backingId: string | undefined,
): Promise<void> {
  // A bookmark keeps its words rather than take the browser's stand-in for an unknown title.
  if (isPlaceholderTabTitle(page.title, page.url)) return;
  if (backingId !== undefined) {
    const [backing] = await ports.get(backingId).catch(() => []);
    if (backing && customBookmarkTitleMatches(backing, page.title)) return;
    const link = backing ? tabBackingBookmarkLink(backing) : {};
    const namingBookmarkId = link.linkedBookmarkId ?? link.declinedBookmarkId;
    const [namingBookmark] = namingBookmarkId
      ? await ports.get(namingBookmarkId).catch(() => [])
      : [];
    if (isAppliedTabName(page.title, namingBookmark)) return;
  }
  const structure = findHyperBookmarkStructure(await ports.getTree());
  if (!structure) return;
  const updates = bookmarkTitleUpdatesFollowingPageTitle(
    [
      structure.favourites,
      ...(structure.bookmarks ? [structure.bookmarks] : []),
      ...(structure.spaces.children ?? []).flatMap((space) =>
        space.children?.filter(isSpaceBookmarksFolder) ?? []),
    ],
    page.url,
    page.title,
  );
  await Promise.all(updates.map(async ({ id }) => {
    // The tree read and the write are separate turns, so each node is checked
    // again against its current title rather than the one it had when listed.
    const [current] = await ports.get(id).catch(() => []);
    if (!current) return;
    const [update] = bookmarkTitleUpdatesFollowingPageTitle(
      [current],
      page.url,
      page.title,
    );
    if (update) await ports.update(update.id, { title: update.title });
  }));
}

const browserPorts: BookmarkTitleSyncPorts = {
  get: (id) => browser.bookmarks.get(id),
  getTree: () => browser.bookmarks.getTree(),
  update: (id, changes) => browser.bookmarks.update(id, changes),
};

/** The background's entry point: a tab whose title has just changed. */
export async function syncBookmarkTitlesFollowingTab(
  tab: BrowserTab,
  backingId: string | undefined,
): Promise<void> {
  if (!canSyncBookmarkTitleFromTab(tab)) return;
  await syncBookmarkTitlesFollowingPage(
    browserPorts,
    { title: tab.title ?? '', url: tabUrl(tab) },
    backingId,
  );
}
