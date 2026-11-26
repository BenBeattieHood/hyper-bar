import {
  shownSpaces,
  bestTabFaviconUrl,
  findHyperBookmarkStructure,
  isSpaceTabsFolder,
  isSplitViewFolder,
  isTabBackingBookmark,
  isTabFolder,
  visibleBookmarkTitle,
  type BookmarkNode,
  type BrowserTab,
} from './bookmarks';
import { addToMapList } from './collections';
import { normalWindowTabs, type HyperModelSnapshot } from './model';
import { buildSearchItems, type SearchItem } from './search';
import { pageIdentity, tabUrl } from './urlIdentity';

export interface WindowSearchRecords {
  activeSpaceId: string;
  items: readonly SearchItem[];
}

/**
 * Produces the browser-facing half of Search from one committed revision.
 * Search callers name only their authenticated window; they never supply tabs,
 * page text, bookmarks, history, or their active space back to the background.
 */
export function searchRecordsForWindow(
  snapshot: HyperModelSnapshot,
  windowId: number,
): WindowSearchRecords | undefined {
  const windowTabs = normalWindowTabs(snapshot, windowId);
  if (!windowTabs) return undefined;
  const spaces = snapshot.hyper.spaces;
  const shown = shownSpaces(spaces);
  const activeSpaceId = shown.some((space) =>
    space.id === snapshot.runtime.activeSpaceIds[windowId])
    ? snapshot.runtime.activeSpaceIds[windowId] as string
    : shown[0]?.id ?? '';
  const tabs = windowTabs.filter((tab) => !tabUrl(tab)?.startsWith(snapshot.browser.extensionOrigin));
  const tabContents = Object.fromEntries(tabs.flatMap((tab) => {
    if (tab.id === undefined) return [];
    const content = snapshot.runtime.tabContents[tab.id];
    const url = tabUrl(tab);
    return content &&
      content.url === url &&
      content.navigationVersion === (snapshot.runtime.tabContentVersions[tab.id] ?? 0)
      ? [[tab.id, content.text] as const]
      : [];
  }));
  const tabSpaceIds = Object.fromEntries(tabs.flatMap((tab) => {
    if (tab.id === undefined) return [];
    const ownership = snapshot.runtime.tabOwnerships[tab.id];
    return ownership ? [[tab.id, ownership.spaceId] as const] : [];
  }));
  const foldersByBacking = tabFoldersByBacking(snapshot.browser.bookmarkTree);
  const tabFolders = Object.fromEntries(tabs.flatMap((tab) => {
    const backingId = tab.id === undefined ? undefined : snapshot.runtime.tabOwnerships[tab.id]?.backingId;
    const folders = backingId ? foldersByBacking.get(backingId) : undefined;
    return folders?.length ? [[tab.id!, folders] as const] : [];
  }));
  return {
    activeSpaceId,
    items: [
      ...buildSearchItems({
        activeSpaceId,
        extensionOrigin: snapshot.browser.extensionOrigin,
        favourites: snapshot.hyper.favourites,
        globalBookmarks: snapshot.hyper.globalBookmarks,
        history: [],
        localBookmarksBySpaceId: snapshot.hyper.localBookmarksBySpaceId,
        spaceTabs: tabs,
        spaces,
        tabContents,
        tabFolders,
        tabTitles: Object.fromEntries(snapshot.derived.tabTitles),
        tabSpaceIds,
        tabs,
      }),
      ...historyItemsWithTabFavicons(snapshot),
    ],
  };
}

const tabFoldersByTree = new WeakMap<BookmarkNode[], ReadonlyMap<string, readonly string[]>>();

/**
 * The names of the tab folders holding each tab backing, outermost first. A
 * split view folder is how two tabs show side by side, not a folder the user
 * named, so it adds no name.
 */
function tabFoldersByBacking(tree: BookmarkNode[]): ReadonlyMap<string, readonly string[]> {
  const cached = tabFoldersByTree.get(tree);
  if (cached) return cached;
  const byBacking = new Map<string, readonly string[]>();
  const visit = (nodes: readonly BookmarkNode[], path: readonly string[]) => {
    for (const node of nodes) {
      if (isTabBackingBookmark(node)) {
        if (path.length > 0) byBacking.set(node.id, path);
      } else if (!node.url) {
        const title = isTabFolder(node) && !isSplitViewFolder(node) ? visibleBookmarkTitle(node) : '';
        visit(node.children ?? [], title ? [...path, title] : path);
      }
    }
  };
  for (const space of findHyperBookmarkStructure(tree)?.spaces.children ?? []) {
    for (const child of space.children ?? []) {
      if (isSpaceTabsFolder(child)) visit(child.children ?? [], []);
    }
  }
  tabFoldersByTree.set(tree, byBacking);
  return byBacking;
}

/**
 * History records carry no icon, so each borrows the favicon of an open tab
 * showing the same page, which is the icon its tab or bookmark row shows.
 */
function historyItemsWithTabFavicons(snapshot: HyperModelSnapshot): readonly SearchItem[] {
  const tabsByPage = new Map<string, BrowserTab[]>();
  for (const tab of snapshot.browser.tabs) {
    if (tab.incognito || !tab.favIconUrl) continue;
    const identity = pageIdentity(tab.url);
    if (!identity) continue;
    addToMapList(tabsByPage, identity, tab);
  }
  if (tabsByPage.size === 0) return snapshot.runtime.historySearchItems;
  return snapshot.runtime.historySearchItems.map((item) => {
    const identity = pageIdentity(item.url);
    const faviconUrl = identity ? bestTabFaviconUrl(tabsByPage.get(identity) ?? []) : undefined;
    return faviconUrl ? { ...item, faviconUrl } : item;
  });
}

function sameValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  return typeof left === 'object' && typeof right === 'object' &&
    JSON.stringify(left) === JSON.stringify(right);
}

function sameSearchItem(left: SearchItem, right: SearchItem): boolean {
  const leftKeys = Object.keys(left) as Array<keyof SearchItem>;
  return leftKeys.length === Object.keys(right).length &&
    leftKeys.every((key) => sameValue(left[key], right[key]));
}

/**
 * Every model revision projects Search records afresh, though most are
 * unchanged. Handing back the previous object for each unchanged record, and
 * the previous array when nothing changed, keeps Search's per-record text and
 * per-request summaries warm across revisions. One interner serves one window.
 */
export function createSearchItemInterner(): (items: readonly SearchItem[]) => readonly SearchItem[] {
  let previousItems: readonly SearchItem[] = [];
  let previousById = new Map<string, SearchItem>();
  return (items) => {
    const byId = new Map<string, SearchItem>();
    let unchanged = items.length === previousItems.length;
    const interned = items.map((item, index) => {
      const previous = previousById.get(item.id);
      const kept = previous && sameSearchItem(previous, item) ? previous : item;
      byId.set(item.id, kept);
      if (kept !== previousItems[index]) unchanged = false;
      return kept;
    });
    previousById = byId;
    if (unchanged) return previousItems;
    previousItems = interned;
    return interned;
  };
}
