import type { BrowserTab } from './bookmarks';

/**
 * Reconciles a tab query against the navigation events observed since it ran.
 *
 * A query reports the status the browser had settled on, which lags the
 * navigation events the background already saw, so the events win.
 */
export function mergeNativeTabStatuses(
  tabs: readonly BrowserTab[],
  statuses: ReadonlyMap<number, BrowserTab['status']>,
): BrowserTab[] {
  return tabs.map((tab) => {
    if (tab.id === undefined) return tab;
    const status = statuses.get(tab.id);
    return status === undefined || status === tab.status ? tab : { ...tab, status };
  });
}

export function tabStatusAnnouncementIsCurrent(
  announcedStatus: 'loading' | 'complete',
  currentStatus: BrowserTab['status'],
): boolean {
  return announcedStatus === currentStatus;
}
