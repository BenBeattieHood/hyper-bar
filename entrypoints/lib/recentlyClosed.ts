import { bookmarkableTabUrl, type BrowserTab } from './bookmarks';

export interface RecentlyClosedTab {
  favIconUrl?: string;
  sessionId: string;
  title: string;
  url: string;
}

const RECENTLY_CLOSED_TAB_LIMIT = 10;
// Chrome rejects larger requests; closed windows and Hyper pages are filtered out afterwards.
const SESSION_READ_LIMIT = 25;

export function recentlyClosedTabsFromSessions(
  sessions: readonly { tab?: BrowserTab }[],
  extensionOrigin: string,
): RecentlyClosedTab[] {
  return sessions.flatMap(({ tab }) => {
    const url = bookmarkableTabUrl(tab, extensionOrigin);
    if (!tab?.sessionId || !url || tab.incognito) return [];
    return [{
      ...(tab.favIconUrl ? { favIconUrl: tab.favIconUrl } : {}),
      sessionId: tab.sessionId,
      title: tab.title || url,
      url,
    }];
  }).slice(0, RECENTLY_CLOSED_TAB_LIMIT);
}

export async function readRecentlyClosedTabs(
  extensionOrigin: string,
): Promise<RecentlyClosedTab[]> {
  const getRecentlyClosed = browser.sessions?.getRecentlyClosed;
  if (typeof getRecentlyClosed !== 'function') return [];
  const sessions = await browser.sessions.getRecentlyClosed({
    maxResults: SESSION_READ_LIMIT,
  }).catch(() => []);
  return recentlyClosedTabsFromSessions(sessions, extensionOrigin);
}
