import { matchesShortcut, type ShortcutKeyEvent } from './shortcuts';

export const openHyperFromPageMessageType = 'hyper:open-from-page';
export const newTabShownMessageType = 'hyper:new-tab-shown';
export const userNewTabShownMessageType = 'hyper:user-new-tab-shown';
export const showPageSearchOverlayMessageType = 'hyper:show-page-search-overlay';
export const closePageSearchOverlayMessageType = 'hyper:close-page-search-overlay';
export const pageSearchOverlayReadyMessageType = 'hyper:page-search-overlay-ready';
export const focusPageSearchOverlayMessageType = 'hyper:focus-page-search-overlay';
export const pageSearchOverlayLayoutMessageType = 'hyper:page-search-overlay-layout';
export const pageSearchOverlayThemeMessageType = 'hyper:page-search-overlay-theme';

const SEARCH_OVERLAY_MODE = 'search-overlay';

export interface SearchOverlaySource {
  tabId: number;
  windowId: number;
}

export function searchOverlayUrl(
  newTabUrl: string,
  source: SearchOverlaySource,
): string {
  const url = new URL(newTabUrl);
  url.searchParams.set('mode', SEARCH_OVERLAY_MODE);
  url.searchParams.set('sourceTabId', String(source.tabId));
  url.searchParams.set('sourceWindowId', String(source.windowId));
  return url.href;
}

export function parseSearchOverlaySource(url: string): SearchOverlaySource | undefined {
  const parsed = new URL(url);
  if (parsed.searchParams.get('mode') !== SEARCH_OVERLAY_MODE) return undefined;
  const tabId = Number(parsed.searchParams.get('sourceTabId'));
  const windowId = Number(parsed.searchParams.get('sourceWindowId'));
  if (!Number.isInteger(tabId) || tabId < 0 || !Number.isInteger(windowId) || windowId < 0) {
    return undefined;
  }
  return { tabId, windowId };
}

/** Asks the content script of the page that framed Search to take the overlay down. */
export function closePageSearchOverlay(): void {
  window.parent.postMessage({ type: closePageSearchOverlayMessageType }, '*');
}

export function isPageOpenShortcut(event: ShortcutKeyEvent): boolean {
  return matchesShortcut(event, 'pageSearch');
}