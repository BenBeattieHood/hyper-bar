import {
  bookmarkCustomName,
  bookmarkTitleWithCustomName,
  bookmarkTitleWithHyper,
  bookmarkTitleWithoutCustomName,
  tabBackingBookmarkLink,
  tabBackingTitleWithBookmarkLink,
  visibleBookmarkTitle,
  type BookmarkNode,
  type TabBookmarkLinkMetadata,
} from './bookmarks';
import { bookmarkById, renameTabBackingBookmark, type TabBackingLocation } from './bookmarkStorage';
import { hyperModelAtom, type HyperModelSnapshot, type HyperModelStore } from './model';
import {
  deriveTabBookmarkLink,
  indexLinkableBookmarks,
  tabPageTitle,
  type LinkableBookmarks,
  type TabBookmarkLink,
} from './tabBookmarkLink';
import { getTabOwnership } from './tabOwnership';
import { renameTabDocumentTitle } from './tabDocumentTitle';
import { tabById } from './tabs';
import { tabUrl, urlsRepresentSamePage, urlsShareDomain } from './urlIdentity';
import type { TimedMessages } from './timedMessages';

export const LINKED_TO_BOOKMARK_TEXT = 'Linked to bookmark';

export interface TabBookmarkLinkControllerDependencies {
  messages: Pick<TimedMessages, 'current' | 'dismiss' | 'offer'>;
  queueMutation<Result>(operation: () => Promise<Result>): Promise<Result>;
  store: HyperModelStore;
}

interface TabLinkState {
  backing: BookmarkNode;
  bookmarks: LinkableBookmarks;
  link?: TabBookmarkLink;
  tab: Browser.tabs.Tab;
}

/**
 * Records which bookmark each tab shows, so the link outlives the page that
 * made it: a tab keeps its bookmark while it wanders that bookmark's domain,
 * and the background, not a view, decides when a link starts and ends.
 */
export function createTabBookmarkLinkController(dependencies: TabBookmarkLinkControllerDependencies) {
  const navigating = new Map<number, number>();
  // Each tab's last attempted inference, so a link that cannot be recorded is not retried every commit.
  const attempted = new Map<number, string>();

  const bookmarksFor = (snapshot: HyperModelSnapshot, spaceId: string) => indexLinkableBookmarks(
    snapshot.hyper.localBookmarksBySpaceId[spaceId] ?? [],
    snapshot.hyper.favourites,
    snapshot.hyper.globalBookmarks,
  );

  const readState = async (tabId: number): Promise<TabLinkState | undefined> => {
    const [tab, ownership] = await Promise.all([
      tabById(tabId),
      getTabOwnership(tabId),
    ]);
    if (!tab || tab.incognito || !ownership?.backingId) return undefined;
    const backing = await bookmarkById(ownership.backingId);
    if (!backing) return undefined;
    const bookmarks = bookmarksFor(dependencies.store.get(hyperModelAtom), ownership.spaceId);
    const link = deriveTabBookmarkLink(tabUrl(tab), backing, bookmarks);
    return { backing, bookmarks, ...(link ? { link } : {}), tab };
  };

  const writeLink = async (backing: BookmarkNode, link: TabBookmarkLinkMetadata) => {
    const current = await bookmarkById(backing.id);
    if (!current) return;
    const title = tabBackingTitleWithBookmarkLink(current.title, link);
    if (title !== current.title) await browser.bookmarks.update(current.id, { title });
  };

  const record = (state: TabLinkState, bookmarkId: string) => writeLink(state.backing, {
    ...tabBackingBookmarkLink(state.backing),
    linkedBookmarkId: bookmarkId,
  });

  /** The title a tab's page gives itself, even while the tab strip shows a name Hyper put there. */
  const pageTitle = async (tab: Browser.tabs.Tab): Promise<string> => {
    const url = tabUrl(tab) ?? '';
    const backingId = tab.id === undefined ? undefined : (await getTabOwnership(tab.id))?.backingId;
    const backing = await bookmarkById(backingId);
    if (!backing || !urlsRepresentSamePage(backing.url, url)) return tab.title || url;
    const { declinedBookmarkId, linkedBookmarkId } = tabBackingBookmarkLink(backing);
    const namingId = linkedBookmarkId ?? declinedBookmarkId;
    const namingBookmark = await bookmarkById(namingId);
    return tabPageTitle(tab.title, url, backing, namingBookmark);
  };

  /** A page's title from any tab showing it, or nothing when no tab does. */
  const openPageTitle = async (url: string): Promise<string | undefined> => {
    const tab = (await browser.tabs.query({})).find((candidate) =>
      !candidate.incognito && urlsRepresentSamePage(tabUrl(candidate), url));
    return tab ? pageTitle(tab) : undefined;
  };

  /** A bookmark with a blank name takes its page's title when a tab shows that page; otherwise nothing changes. */
  const revertBookmarkName = async (bookmark: BookmarkNode): Promise<boolean> => {
    if (!bookmark.url) return false;
    const title = await openPageTitle(bookmark.url);
    if (title === undefined) return false;
    await browser.bookmarks.update(bookmark.id, { title: bookmarkTitleWithoutCustomName(bookmark, title) });
    return true;
  };

  /** Renaming a linked tab renames its bookmark too; a blank name returns both to their pages' titles. */
  const renameLinkedBookmark = async (tabId: number, title: string): Promise<void> => {
    const state = await readState(tabId);
    const bookmark = state?.link && state.bookmarks.byId.get(state.link.bookmarkId);
    if (!state?.link || !bookmark) return;
    const current = await bookmarkById(bookmark.id);
    if (!current?.url) return;
    const name = title.trim();
    if (name) {
      await browser.bookmarks.update(current.id, { title: bookmarkTitleWithCustomName(current, name) });
    } else if (bookmarkCustomName(current) !== undefined) {
      // Only the bookmark's own page can title it; until a tab shows it, the bookmark keeps its words.
      const pageTitleNow = state.link.drifted ? await openPageTitle(current.url) : await pageTitle(state.tab);
      await browser.bookmarks.update(current.id, {
        title: bookmarkTitleWithoutCustomName(current, pageTitleNow),
      });
    }
    if (!state.link.persisted) await record(state, current.id);
  };

  const forgetNotice = (tab: Browser.tabs.Tab) => {
    const message = dependencies.messages.current(tab.windowId);
    if (message?.text === LINKED_TO_BOOKMARK_TEXT && message.tabId === tab.id) {
      dependencies.messages.dismiss(tab.windowId, message.id);
    }
  };

  /** A link Hyper inferred is a best guess, so the user can decline it. */
  const showNotice = (state: TabLinkState, bookmarkId: string) => {
    const tabId = state.tab.id;
    if (tabId === undefined) return;
    const bookmark = state.bookmarks.byId.get(bookmarkId);
    dependencies.messages.offer(state.tab.windowId, {
      act: () => dependencies.queueMutation(async () => {
        const current = await readState(tabId);
        if (current?.link?.bookmarkId !== bookmarkId) {
          throw new Error('This tab is no longer linked to that bookmark.');
        }
        await unlink(current, bookmarkId);
      }),
      ...(bookmark ? { detail: `Linked to ${visibleBookmarkTitle(bookmark)}` } : {}),
      kind: 'opt-out',
      tabId,
      text: LINKED_TO_BOOKMARK_TEXT,
    });
  };

  /** Links a tab silently, either to a named bookmark or to the bookmark of exactly its page. */
  const link = async (tabId: number, bookmarkId?: string): Promise<void> => {
    const state = await readState(tabId);
    const target = bookmarkId ?? state?.link?.bookmarkId;
    if (state && target !== undefined && !(state.link?.persisted && state.link.bookmarkId === target)) {
      await record(state, target);
    }
  };

  /** Ends a tab's link so that bookmark is not inferred for it again until it leaves the domain. */
  const unlink = async (state: TabLinkState, bookmarkId: string) => {
    await writeLink(state.backing, { declinedBookmarkId: bookmarkId, linkedBookmarkId: undefined });
    forgetNotice(state.tab);
  };

  return {
    /** A navigation's link is settled by `followNavigation`, so silent recording waits for it. */
    async whileNavigating<Result>(tabId: number, operation: () => Promise<Result>): Promise<Result> {
      navigating.set(tabId, (navigating.get(tabId) ?? 0) + 1);
      try {
        return await operation();
      } finally {
        const remaining = (navigating.get(tabId) ?? 1) - 1;
        if (remaining > 0) navigating.set(tabId, remaining);
        else navigating.delete(tabId);
      }
    },

    /**
     * Runs a navigation's backing sync and settles the tab's link around it: a
     * link survives drift within its domain, ends with that domain, and a page
     * reached by itself that is exactly a bookmark links with an undo notice.
     */
    async followNavigation(
      tabId: number,
      previousUrl: string | undefined,
      sync: () => Promise<void>,
    ): Promise<void> {
      const before = await readState(tabId);
      // A tab routed when it opened already has a backing for its new page, so that is not its prior page.
      const priorUrl = previousUrl ?? (
        before?.backing.url && before.backing.url !== tabUrl(before.tab)
          ? before.backing.url
          : undefined
      );
      const recordedBookmarkId = before && tabBackingBookmarkLink(before.backing).linkedBookmarkId;
      const shownBookmarkId = recordedBookmarkId ?? (before && priorUrl !== undefined
        ? deriveTabBookmarkLink(priorUrl, before.backing, before.bookmarks)?.bookmarkId
        : undefined);
      await sync();
      const after = await readState(tabId);
      if (!after) return;
      if (after.link) {
        if (!after.link.persisted) await record(after, after.link.bookmarkId);
        // Only a link the tab did not already record is news; one page can arrive in several events.
        if (after.link.bookmarkId !== recordedBookmarkId) showNotice(after, after.link.bookmarkId);
        return;
      }
      const previous = shownBookmarkId === undefined
        ? undefined
        : after.bookmarks.byId.get(shownBookmarkId);
      if (previous?.url && urlsShareDomain(previous.url, tabUrl(after.tab))) {
        await record(after, previous.id);
      } else if (tabBackingBookmarkLink(after.backing).linkedBookmarkId !== undefined) {
        await writeLink(after.backing, { ...tabBackingBookmarkLink(after.backing), linkedBookmarkId: undefined });
      }
    },

    /** Records links the model inferred from an exact page match, once a tab has settled on its page. */
    recordInferredLinks(snapshot: HyperModelSnapshot) {
      const settled = new Set(snapshot.browser.tabs.flatMap((tab) =>
        tab.id !== undefined && tab.status === 'complete' ? [tab.id] : []));
      for (const [tabId, inferred] of snapshot.derived.tabBookmarkLinks) {
        const backingId = snapshot.runtime.tabOwnerships[tabId]?.backingId;
        const attempt = `${backingId}:${inferred.bookmarkId}`;
        if (
          inferred.persisted ||
          backingId === undefined ||
          !settled.has(tabId) ||
          navigating.has(tabId) ||
          attempted.get(tabId) === attempt
        ) continue;
        attempted.set(tabId, attempt);
        void dependencies.queueMutation(() => link(tabId)).catch(() => undefined);
      }
    },

    link,

    /** Each tab linked to one of these bookmarks, with the bookmark it is linked to. */
    tabsLinkedTo(bookmarkIds: ReadonlySet<string>): ReadonlyMap<number, string> {
      return new Map([...dependencies.store.get(hyperModelAtom).derived.tabBookmarkLinks].flatMap(
        ([tabId, { bookmarkId }]) => bookmarkIds.has(bookmarkId) ? [[tabId, bookmarkId] as const] : [],
      ));
    },
    /**
     * Hyper opened a bookmark's page in this tab for the user, so the tab links
     * silently and becomes the bookmark's better match: tabs that had drifted
     * from that bookmark are unlinked from it.
     */
    async claim(tabId: number): Promise<void> {
      const state = await readState(tabId);
      if (!state?.link) return;
      const { bookmarkId } = state.link;
      if (!state.link.persisted) await record(state, bookmarkId);
      for (const [otherId, other] of dependencies.store.get(hyperModelAtom).derived.tabBookmarkLinks) {
        if (otherId === tabId || other.bookmarkId !== bookmarkId) continue;
        const drifted = await readState(otherId);
        if (drifted?.link?.bookmarkId === bookmarkId && drifted.link.drifted) await unlink(drifted, bookmarkId);
      }
    },

    renameLinkedBookmark,

    openPageTitle,
    pageTitle,

    /** Names a tab, or with a blank name returns it, and its linked bookmark, to their pages' titles. */
    async renameTab(
      tab: Browser.tabs.Tab,
      title: string,
      backing: Pick<TabBackingLocation, 'backingId' | 'backingToken' | 'spaceId' | 'windowId'>,
    ): Promise<void> {
      if (tab.id === undefined) return;
      const name = title.trim();
      const restored = name ? undefined : await pageTitle(tab);
      await renameTabBackingBookmark(backing.backingId, name, backing, restored);
      await renameLinkedBookmark(tab.id, name);
      // An unknown page title is left blank, so the browser shows the address as it would.
      await renameTabDocumentTitle(
        tab.id,
        name || (restored === tabUrl(tab) ? '' : restored ?? ''),
      );
    },

    revertBookmarkName,

    /** Metadata rides in a bookmark's title, so a rename re-serialises it; a blank name means its page's title. */
    async renameBookmark(id: string, title: string, url?: string): Promise<void> {
      const [current] = await browser.bookmarks.get(id);
      if (!current) throw new Error('This bookmark no longer exists.');
      const nextUrl = current.url && url ? url : undefined;
      if (!title.trim()) {
        // A folder has no page to take a title from, so it keeps its name.
        const updated = nextUrl && nextUrl !== current.url
          ? await browser.bookmarks.update(id, { url: nextUrl })
          : current;
        await revertBookmarkName(updated);
        return;
      }
      await browser.bookmarks.update(id, {
        title: current.url
          ? bookmarkTitleWithCustomName(current, title)
          : bookmarkTitleWithHyper(current.title, {}, { visible: title }),
        ...(nextUrl ? { url: nextUrl } : {}),
      });
    },

    removeTab(tabId: number) {
      navigating.delete(tabId);
      attempted.delete(tabId);
    },
  };
}

export type TabBookmarkLinkController = ReturnType<typeof createTabBookmarkLinkController>;
