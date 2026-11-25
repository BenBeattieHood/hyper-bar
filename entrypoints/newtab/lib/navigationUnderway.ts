import { isBlankTabPage } from '../../lib/tabs';

// Where common search engines keep the words searched for.
const QUERY_PARAMETERS = ['q', 'query', 'p', 'text', 'wd', 'search_query'];

/** What a page being loaded shows for: the words searched for, or else its address. */
export function underwayText(url: string): string {
  try {
    const parsed = new URL(url);
    for (const name of QUERY_PARAMETERS) {
      const query = parsed.searchParams.get(name)?.trim();
      if (query) return query;
    }
  } catch {
    // An address that does not parse is shown as it is.
  }
  return url;
}

/**
 * The text of the search or address this new tab page's own tab is loading,
 * or undefined while it is not leaving the page. The address bar starts these
 * as well as Hyper, and the page stays shown until the next one commits.
 */
export function tabNavigationUnderway(
  tab: Pick<Browser.tabs.Tab, 'pendingUrl' | 'status' | 'url'> | undefined,
  newTabUrl: string,
): string | undefined {
  if (
    tab?.status !== 'loading' ||
    !tab.pendingUrl ||
    !isBlankTabPage(tab.url, newTabUrl) ||
    isBlankTabPage(tab.pendingUrl, newTabUrl)
  ) return undefined;
  return underwayText(tab.pendingUrl);
}
