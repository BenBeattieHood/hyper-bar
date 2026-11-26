export { SidebarApp } from './entrypoints/sidepanel/App';
import type { useBrowserState } from './entrypoints/sidepanel/hooks/useBrowserState';
export type BrowserStateApi = ReturnType<typeof useBrowserState>;
export { defaultHyperPreferences } from './entrypoints/lib/preferences';
export { noBrowserCommandCapabilities } from './entrypoints/lib/browserCommandCapabilities';
export {
  bookmarkTitleWithFavouriteSlot,
  bookmarkTitleWithHyper,
  tabFolderBookmarkTitle,
  visibleBookmarkTitle,
  tabBackingBookmarkTitle,
  type BookmarkNode,
  type BrowserTab,
} from './entrypoints/lib/bookmarks';
export type { SearchItem } from './entrypoints/lib/search';
export type { SharedSearchResult } from './entrypoints/lib/searchIndex';
