import {
  bookmarkCustomName,
  tabBackingBookmarkLink,
  tabBackingPageTitle,
  visibleBookmarkTitle,
  type BookmarkNode,
  type BrowserTab,
} from './bookmarks';
import { addToMapList } from './collections';
import { isPlaceholderTabTitle, sameNavigationUrl, tabDisplayTitle } from './tabs';
import type { TabOwnership } from './tabOwnership';
import { normaliseUrl, tabUrl, urlsRepresentSamePage, urlsShareDomain } from './urlIdentity';

export interface TabBookmarkLink {
  bookmarkId: string;
  /** The tab has moved off the bookmark's exact page, within its domain. */
  drifted: boolean;
  /** Recorded on the tab's backing, rather than inferred from an exact match. */
  persisted: boolean;
}

/** A name the user chose for a tab, shown with a trailing `*` once the tab drifts from its bookmark. */
export interface TabName {
  drifted: boolean;
  source: 'bookmark' | 'tab';
  title: string;
}

export function tabNameText(name: TabName): string {
  return name.drifted ? `${name.title}*` : name.title;
}

/**
 * The bookmarks a tab in a space can link to, indexed once per space: its own
 * first, then favourites, then the global bookmarks every space shares.
 */
export interface LinkableBookmarks {
  byId: ReadonlyMap<string, BookmarkNode>;
  byPage: ReadonlyMap<string, readonly BookmarkNode[]>;
}

export function indexLinkableBookmarks(
  spaceBookmarks: readonly BookmarkNode[],
  favourites: readonly BookmarkNode[],
  globalBookmarks: readonly BookmarkNode[] = [],
): LinkableBookmarks {
  const byId = new Map<string, BookmarkNode>();
  const byPage = new Map<string, BookmarkNode[]>();
  const visit = (nodes: readonly BookmarkNode[]) => {
    for (const node of nodes) {
      if (!node.url) {
        visit(node.children ?? []);
        continue;
      }
      if (byId.has(node.id)) continue;
      byId.set(node.id, node);
      const identity = normaliseUrl(node.url);
      if (!identity) continue;
      addToMapList(byPage, identity, node);
    }
  };
  visit(spaceBookmarks);
  visit(favourites);
  visit(globalBookmarks);
  return { byId, byPage };
}

/**
 * The bookmark a tab shows: the one it is linked to while it stays on that
 * bookmark's domain, else the first bookmark of exactly its page that the user
 * has not unlinked.
 */
export function deriveTabBookmarkLink(
  tabUrl: string | undefined,
  backing: Pick<BookmarkNode, 'title'> | undefined,
  bookmarks: LinkableBookmarks,
): TabBookmarkLink | undefined {
  if (!tabUrl) return undefined;
  const { declinedBookmarkId, linkedBookmarkId } = backing ? tabBackingBookmarkLink(backing) : {};
  const linked = linkedBookmarkId === undefined ? undefined : bookmarks.byId.get(linkedBookmarkId);
  if (linked?.url && urlsShareDomain(linked.url, tabUrl)) {
    return { bookmarkId: linked.id, drifted: !sameNavigationUrl(linked.url, tabUrl), persisted: true };
  }
  const identity = normaliseUrl(tabUrl);
  const exact = identity
    ? bookmarks.byPage.get(identity)?.find((node) => node.id !== declinedBookmarkId)
    : undefined;
  return exact?.url
    ? { bookmarkId: exact.id, drifted: !sameNavigationUrl(exact.url, tabUrl), persisted: false }
    : undefined;
}

/**
 * A linked bookmark's user-given name wins; otherwise the tab keeps the name
 * given to it, but only on the site it was given on.
 */
export function deriveTabName(
  tabUrl: string | undefined,
  link: TabBookmarkLink | undefined,
  bookmark: Pick<BookmarkNode, 'title'> | undefined,
  backing: Pick<BookmarkNode, 'title' | 'url'> | undefined,
): TabName | undefined {
  const bookmarkName = link && bookmark ? bookmarkCustomName(bookmark) : undefined;
  if (bookmarkName) return { drifted: Boolean(link?.drifted), source: 'bookmark', title: bookmarkName };
  const ownName = backing && urlsShareDomain(backing.url, tabUrl)
    ? bookmarkCustomName(backing)
    : undefined;
  return ownName ? { drifted: false, source: 'tab', title: ownName } : undefined;
}

/** The page title a backing keeps: beside the user's name, or as its visible title when it has none. */
function keptPageTitle(backing: Pick<BookmarkNode, 'title'>): string | undefined {
  return tabBackingPageTitle(backing) ??
    (bookmarkCustomName(backing) === undefined ? visibleBookmarkTitle(backing) : undefined);
}

/**
 * The title a tab's page last gave itself, to keep on its backing. The tab
 * strip may show a name Hyper put there, or a placeholder while the page
 * loads, sleeps or fails to load; neither replaces the title the backing
 * already keeps for that page.
 */
export function tabPageTitle(
  reported: string | undefined,
  url: string,
  backing: Pick<BookmarkNode, 'title' | 'url'> | undefined,
  namingBookmark: Pick<BookmarkNode, 'title'> | undefined,
): string {
  const kept = backing ? tabBackingPageTitle(backing) ?? visibleBookmarkTitle(backing) : undefined;
  if (kept !== undefined && (
    (reported !== undefined && reported === bookmarkCustomName(backing!)) ||
    isAppliedTabName(reported, namingBookmark) ||
    (isPlaceholderTabTitle(reported, url) && urlsRepresentSamePage(backing?.url, url))
  )) return kept;
  return reported?.trim() || url;
}

/**
 * What every surface calls a tab: its name, else the page title its backing
 * keeps, else what the browser reports.
 */
export function deriveTabTitle(
  tab: BrowserTab,
  backing: Pick<BookmarkNode, 'title' | 'url'> | undefined,
  name: TabName | undefined,
): string {
  if (name) return tabNameText(name);
  const kept = backing &&
    !bookmarkCustomName(backing) &&
    urlsRepresentSamePage(backing.url, tabUrl(tab))
    ? visibleBookmarkTitle(backing)
    : undefined;
  return kept || tabDisplayTitle(tab);
}

export interface TabBookmarkState {
  links: ReadonlyMap<number, TabBookmarkLink>;
  names: ReadonlyMap<number, TabName>;
  /** The page title each tab's backing keeps for the page it shows, to put back once a name stops applying. */
  pageTitles: ReadonlyMap<number, string>;
  titles: ReadonlyMap<number, string>;
}

export function deriveTabBookmarkState(input: {
  backingNodes: ReadonlyMap<string, BookmarkNode>;
  favourites: readonly BookmarkNode[];
  globalBookmarks?: readonly BookmarkNode[];
  localBookmarksBySpaceId: Readonly<Record<string, readonly BookmarkNode[]>>;
  ownerships: Readonly<Record<number, TabOwnership>>;
  tabs: readonly BrowserTab[];
}): TabBookmarkState {
  const bookmarksBySpace = new Map<string, LinkableBookmarks>();
  const links = new Map<number, TabBookmarkLink>();
  const names = new Map<number, TabName>();
  const pageTitles = new Map<number, string>();
  const titles = new Map<number, string>();
  for (const tab of input.tabs) {
    if (tab.id === undefined) continue;
    const ownership = tab.incognito ? undefined : input.ownerships[tab.id];
    if (!ownership) {
      titles.set(tab.id, tabDisplayTitle(tab));
      continue;
    }
    let bookmarks = bookmarksBySpace.get(ownership.spaceId);
    if (!bookmarks) {
      bookmarks = indexLinkableBookmarks(
        input.localBookmarksBySpaceId[ownership.spaceId] ?? [],
        input.favourites,
        input.globalBookmarks,
      );
      bookmarksBySpace.set(ownership.spaceId, bookmarks);
    }
    const backing = ownership.backingId === undefined
      ? undefined
      : input.backingNodes.get(ownership.backingId);
    const url = tabUrl(tab);
    const link = deriveTabBookmarkLink(url, backing, bookmarks);
    if (link) links.set(tab.id, link);
    const name = deriveTabName(url, link, link && bookmarks.byId.get(link.bookmarkId), backing);
    if (name) names.set(tab.id, name);
    titles.set(tab.id, deriveTabTitle(tab, backing, name));
    const pageTitle = backing && urlsRepresentSamePage(backing.url, url) ? keptPageTitle(backing) : undefined;
    if (pageTitle) pageTitles.set(tab.id, pageTitle);
  }
  return { links, names, pageTitles, titles };
}

/**
 * Whether a tab's reported title is the name Hyper put there, rather than one
 * the page set, so it is never mistaken for the page's own title.
 */
export function isAppliedTabName(
  title: string | undefined,
  linkedBookmark: Pick<BookmarkNode, 'title'> | undefined,
): boolean {
  const name = linkedBookmark ? bookmarkCustomName(linkedBookmark) : undefined;
  return Boolean(name && title && (title === name || title === `${name}*`));
}
