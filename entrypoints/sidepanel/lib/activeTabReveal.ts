import type { BookmarkNode, BrowserTab } from '../../lib/bookmarks';
import { tabUrl, urlsRepresentSamePage } from '../../lib/urlIdentity';
import { flattenVisibleTree } from './drag';

/** A row that shows the window's active tab, and the folders that must be open for it to show. */
export interface ActiveTabRow {
  /** Outermost first. */
  folderIds: readonly string[];
  nodeId: string;
  pane: 'bookmarks' | 'tabs';
}

const everyItem = (nodes: BookmarkNode[], rootId: string) =>
  flattenVisibleTree(nodes, rootId, new Set(), true);

/**
 * Where the active tab shows: its row in the tab tree, and the bookmark it
 * matches, which is the one the model links it to, else the first for its page.
 */
export function activeTabRows({
  activeTab,
  bookmarks,
  linkedBookmarkId,
  tabs,
}: {
  activeTab?: Pick<BrowserTab, 'id' | 'pendingUrl' | 'url'>;
  bookmarks: { nodes: BookmarkNode[]; rootId: string };
  linkedBookmarkId?: string;
  tabs: { nodes: BookmarkNode[]; rootId: string; tabsByNodeId: Readonly<Record<string, BrowserTab | undefined>> };
}): ActiveTabRow[] {
  if (activeTab?.id === undefined) return [];
  const url = tabUrl(activeTab);
  const tabItem = everyItem(tabs.nodes, tabs.rootId)
    .find((item) => !item.isFolder && tabs.tabsByNodeId[item.nodeId]?.id === activeTab.id);
  const bookmarkItems = everyItem(bookmarks.nodes, bookmarks.rootId).filter((item) => !item.isFolder);
  const bookmarkItem = bookmarkItems.find((item) => item.nodeId === linkedBookmarkId) ??
    (url ? bookmarkItems.find((item) => urlsRepresentSamePage(item.node.url, url)) : undefined);
  return [
    ...(tabItem ? [{ folderIds: tabItem.ancestorIds, nodeId: tabItem.nodeId, pane: 'tabs' as const }] : []),
    ...(bookmarkItem
      ? [{ folderIds: bookmarkItem.ancestorIds, nodeId: bookmarkItem.nodeId, pane: 'bookmarks' as const }]
      : []),
  ];
}
