import {
  bookmarkableTabUrl,
  visibleBookmarkTitle,
  type BookmarkNode,
  type BrowserTab,
  type Space,
} from './bookmarks';
import {
  fuzzyCharacters,
  lowerUrlMatch,
  lowerWordStartQuality,
  normaliseQuery,
  orderedFuzzyCharactersMatch,
  searchTerm,
  urlSearchLetters,
} from './searchText';
import { addToMapList } from './collections';
import { tabDisplayTitle } from './tabs';
import { pageIdentity, tabPageIdentity, tabUrl } from './urlIdentity';

export type SearchItemKind = 'bookmark' | 'folder' | 'history' | 'tab';
export type SearchItemSource =
  | 'favourite'
  | 'bookmark'
  | 'current-space'
  | 'tab'
  | 'other-space'
  | 'history';

export interface SearchItem {
  id: string;
  kind: SearchItemKind;
  source: SearchItemSource;
  title: string;
  detail: string;
  url?: string;
  nodeId?: string;
  spaceId?: string;
  localSpaceId?: string;
  /** A bookmark of an archived space, which ranks below every other space's. */
  archived?: true;
  tabId?: number;
  windowId?: number;
  lastVisitTime?: number;
  /** A favicon already known for this page, such as an open tab's. */
  faviconUrl?: string;
  content?: string;
  /**
   * Names of the folders holding a bookmark, folder or tab, outermost first. A
   * tab's are the tab folders it sits in within its space.
   */
  folders?: string[];
  openSpaces?: Array<{
    id: string;
    title: string;
    tabId?: number;
    windowId?: number;
  }>;
}

export interface HighlightedTextSegment {
  text: string;
  matched: boolean;
}

export type UrlSearchPresentation =
  | { recentered: false; text: string }
  | {
      recentered: true;
      prefix: string;
      match: string;
      suffix: string;
    };

interface SearchSources {
  favourites: BookmarkNode[];
  globalBookmarks?: readonly BookmarkNode[];
  localBookmarksBySpaceId?: Readonly<Record<string, BookmarkNode[]>>;
  spaces: Space[];
  tabs: BrowserTab[];
  spaceTabs: BrowserTab[];
  history: Browser.history.HistoryItem[];
  extensionOrigin: string;
  tabContents: Record<number, string>;
  tabSpaceIds?: Readonly<Record<number, string>>;
  /** The model's title for each tab, by `deriveTabTitle`. */
  tabTitles?: Readonly<Record<number, string>>;
  /** The names of the tab folders holding each tab, outermost first. */
  tabFolders?: Readonly<Record<number, readonly string[]>>;
  activeSpaceId: string;
}

function queryTerms(query: string): string[] {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const unique = new Map<string, string>();
  for (const term of [trimmed, ...trimmed.split(/\s+/)]) {
    const key = term.toLocaleLowerCase();
    if (term && !unique.has(key)) unique.set(key, term);
  }
  return [...unique.values()].sort((left, right) => right.length - left.length);
}

export function highlightedTextSegments(
  value: string,
  query: string,
): HighlightedTextSegment[] {
  const normalised = value.toLocaleLowerCase();
  const ranges: Array<{ start: number; end: number }> = [];
  for (const term of queryTerms(query)) {
    const normalisedTerm = term.toLocaleLowerCase();
    let start = normalised.indexOf(normalisedTerm);
    while (start >= 0) {
      const end = start + normalisedTerm.length;
      const overlaps = ranges.some((range) => range.start < end && start < range.end);
      if (!overlaps) ranges.push({ start, end });
      start = normalised.indexOf(normalisedTerm, end);
    }
  }
  ranges.sort((left, right) => left.start - right.start);
  if (ranges.length === 0) return [{ text: value, matched: false }];

  const segments: HighlightedTextSegment[] = [];
  let offset = 0;
  for (const range of ranges) {
    if (range.start > offset) {
      segments.push({ text: value.slice(offset, range.start), matched: false });
    }
    segments.push({ text: value.slice(range.start, range.end), matched: true });
    offset = range.end;
  }
  if (offset < value.length) {
    segments.push({ text: value.slice(offset), matched: false });
  }
  return segments;
}

export function urlSearchPresentation(
  url: string,
  query: string,
): UrlSearchPresentation {
  const segments = highlightedTextSegments(url, query);
  let offset = 0;
  const matched = segments.find((segment) => {
    if (segment.matched) return true;
    offset += segment.text.length;
    return false;
  });
  if (!matched || offset <= 32) return { recentered: false, text: url };

  let prefix = '…';
  try {
    const origin = new URL(url).origin;
    if (origin !== 'null' && origin.length <= 26 && offset > origin.length + 8) {
      prefix = `${origin.replace(/\/$/, '')}/…/`;
    }
  } catch {
    // Keep a leading ellipsis for non-standard URLs.
  }
  return {
    recentered: true,
    prefix,
    match: matched.text,
    suffix: url.slice(offset + matched.text.length),
  };
}

export function buildSearchItems({
  favourites,
  globalBookmarks = [],
  localBookmarksBySpaceId = {},
  spaces,
  tabs,
  spaceTabs,
  history,
  extensionOrigin,
  tabContents,
  tabTitles = {},
  tabFolders = {},
  tabSpaceIds = {},
  activeSpaceId,
}: SearchSources): SearchItem[] {
  const items: SearchItem[] = [];
  const contentByUrl = new Map<string, string>();
  for (const tab of tabs) {
    const tabContent = tab.id === undefined ? undefined : tabContents[tab.id];
    if (!tabContent) continue;
    const url = bookmarkableTabUrl(tab, extensionOrigin);
    const identity = pageIdentity(url ?? undefined);
    if (identity) contentByUrl.set(identity, tabContent);
  }
  const contentForUrl = (url?: string) => {
    const identity = pageIdentity(url);
    return identity ? contentByUrl.get(identity) : undefined;
  };
  for (const node of favourites) {
    items.push({
      id: `bookmark:${node.id}`,
      kind: 'bookmark',
      source: 'favourite',
      title: visibleBookmarkTitle(node) || node.url || 'Untitled bookmark',
      detail: 'Favourite',
      url: node.url,
      nodeId: node.id,
      content: contentForUrl(node.url),
    });
  }

  // Every space's bookmarks are searchable; the current space's rank first,
  // alongside the global bookmarks that belong to every space.
  const visitBookmarks = (
    nodes: readonly BookmarkNode[],
    path: string[],
    space: Pick<Space, 'archived' | 'id' | 'title'> | undefined,
  ) => {
    for (const node of nodes) {
      const title = visibleBookmarkTitle(node) || node.url || 'Untitled folder';
      items.push({
        id: `${node.url ? 'bookmark' : 'folder'}:${node.id}`,
        kind: node.url ? 'bookmark' : 'folder',
        source: !space ? 'bookmark' : space.id === activeSpaceId ? 'current-space' : 'other-space',
        title,
        detail: [...path, space ? `${space.title}${space.archived ? ' (archived)' : ''}` : 'Bookmarks'].join(' / '),
        url: node.url,
        nodeId: node.id,
        ...(path.length > 0 ? { folders: path } : {}),
        ...(space ? { localSpaceId: space.id, spaceId: space.id } : {}),
        ...(space?.archived ? { archived: true as const } : {}),
        content: contentForUrl(node.url),
      });
      if (!node.url) visitBookmarks(node.children ?? [], [...path, title], space);
    }
  };
  for (const space of spaces) {
    visitBookmarks(localBookmarksBySpaceId[space.id] ?? [], [], space);
  }
  visitBookmarks(globalBookmarks, [], undefined);

  const tabsByIdentity = new Map<string, BrowserTab[]>();
  for (const tab of spaceTabs) {
    if (tab.id === undefined) continue;
    const identity = tabPageIdentity(tab) ?? `tab:${tab.id}`;
    addToMapList(tabsByIdentity, identity, tab);
  }
  for (const matchingTabs of tabsByIdentity.values()) {
    const tab = matchingTabs[0];
    if (!tab || tab.id === undefined) continue;
    const url = tabUrl(tab);
    const content = matchingTabs
      .flatMap((matchingTab) => matchingTab.id === undefined ? [] : [tabContents[matchingTab.id]])
      .filter((value): value is string => Boolean(value))
      .join('\n');
    const folders = [...new Set(matchingTabs.flatMap((matchingTab) =>
      matchingTab.id === undefined ? [] : tabFolders[matchingTab.id] ?? []))];
    const openSpaces = spaces
      .filter((space) => matchingTabs.some((candidate) =>
        candidate.id !== undefined && tabSpaceIds[candidate.id] === space.id,
      ))
      .sort((left, right) => {
        if (left.id === activeSpaceId) return -1;
        if (right.id === activeSpaceId) return 1;
        return left.index - right.index;
      })
      .map((space) => {
        const openTab = matchingTabs.find((candidate) =>
          candidate.id !== undefined && tabSpaceIds[candidate.id] === space.id);
        return {
          id: space.id,
          title: space.title,
          ...(openTab?.id !== undefined ? { tabId: openTab.id } : {}),
          ...(openTab ? { windowId: openTab.windowId } : {}),
        };
      });
    items.push({
      id: `tab:${tab.id}`,
      kind: 'tab',
      source: 'tab',
      title: tabTitles[tab.id] ?? tabDisplayTitle(tab),
      detail: 'Tab',
      url,
      tabId: tab.id,
      windowId: tab.windowId,
      content: content || undefined,
      ...(folders.length > 0 ? { folders } : {}),
      ...(openSpaces.length > 0 ? { openSpaces } : {}),
    });
  }

  for (const entry of history) {
    if (!entry.url) continue;
    items.push({
      id: `history:${entry.id}`,
      kind: 'history',
      source: 'history',
      title: entry.title || entry.url,
      detail: 'History',
      url: entry.url,
      ...(typeof entry.lastVisitTime === 'number'
        ? { lastVisitTime: entry.lastVisitTime }
        : {}),
      content: contentForUrl(entry.url),
    });
  }
  return items;
}

export function orderedFuzzyMatch(value: string, query: string): boolean {
  return orderedFuzzyCharactersMatch(fuzzyCharacters(value), [...fuzzyCharacters(query)]);
}

export function wordStartMatchQuality(value: string, query: string): number {
  const term = normaliseQuery(query);
  return term ? lowerWordStartQuality(value.toLocaleLowerCase(), term) : 0;
}

/** Whether `url` matches `query` as a URL, by `lowerUrlMatch`. */
export function urlMatch(url: string, query: string): boolean {
  return lowerUrlMatch(urlSearchLetters(url), url.toLocaleLowerCase(), searchTerm(query));
}
