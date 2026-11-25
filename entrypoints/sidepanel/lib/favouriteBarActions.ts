import type { BookmarkNode, BrowserTab } from '../../lib/bookmarks';
import { errorMessage, type Notify } from './notify';

interface FavouriteBarBrowserState {
  addTabBookmark(parentId: string, tabId: number, index?: number, favouriteSlot?: number): Promise<unknown>;
  closeTabs(tabIds: number[]): Promise<unknown>;
  favouritesFolderId: string | null;
  focusTab(tab: BrowserTab): Promise<unknown>;
  openFavourite(url: string, forceNew?: boolean): Promise<unknown>;
  submitSelection(kind: 'deleteBookmark', items: readonly { bookmarkId: string; unpin?: boolean }[]): Promise<unknown>;
  updateBookmark(id: string, title: string): Promise<void>;
}

/** What the favourites bar asks of the browser, each failure reported over the bar. */
export function createFavouriteBarActions({
  browserState,
  clearSelectedTabsAfter,
  onUnpin,
  showNotice,
  showTabs,
}: {
  browserState: FavouriteBarBrowserState;
  clearSelectedTabsAfter<T>(operation: Promise<T>): Promise<T>;
  onUnpin(node: BookmarkNode): void;
  showNotice: Notify;
  /** Brings the tabs list into view, so the tab a tile opens or focuses is shown. */
  showTabs(): void;
}) {
  const report = (fallback: string) => (error: unknown) =>
    showNotice(errorMessage(error, fallback));
  return {
    onCloseTabs: (tabIds: number[]) => {
      void browserState.closeTabs(tabIds).catch(report('The tabs could not be closed'));
    },
    onFocusTab: (tab: BrowserTab) => {
      showTabs();
      void clearSelectedTabsAfter(browserState.focusTab(tab))
        .catch(report('The tab could not be focused'));
    },
    onInteractionError: (message: string) => showNotice(message),
    onOpen: (url: string, forceNew: boolean) => {
      showTabs();
      void clearSelectedTabsAfter(browserState.openFavourite(url, forceNew))
        .catch(report('The favourite could not be opened'));
    },
    onPin: (tabId: number, slot: number) => {
      if (!browserState.favouritesFolderId) {
        showNotice('Favourites are not ready yet', 'warning');
        return;
      }
      void browserState.addTabBookmark(browserState.favouritesFolderId, tabId, undefined, slot)
        .catch(report('The tab could not be pinned'));
    },
    onRenameTitle: (node: BookmarkNode, title: string) => browserState.updateBookmark(node.id, title),
    onUnpin,
    /** Unpins a grouped tile's favourites together, as one choice. */
    onUnpinMany: (nodes: readonly BookmarkNode[]) => {
      if (nodes.length === 1 && nodes[0]) {
        onUnpin(nodes[0]);
        return;
      }
      void browserState.submitSelection('deleteBookmark', nodes.map((node) => ({ bookmarkId: node.id, unpin: true })))
        .catch(report('The favourites could not be unpinned'));
    },
  };
}
