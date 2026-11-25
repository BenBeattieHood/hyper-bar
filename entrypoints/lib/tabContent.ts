import type { BrowserTab } from './bookmarks';
import { isHttpUrl, tabUrl } from './urlIdentity';

export interface TabContentSnapshot {
  url: string;
  text: string;
  navigationVersion: number;
}

export type TabContentSnapshots = Record<number, TabContentSnapshot>;

export function currentTabContents(
  tabs: BrowserTab[],
  tabNavigationVersions: Record<number, number>,
  snapshots: TabContentSnapshots,
): TabContentSnapshots {
  return Object.fromEntries(
    Object.entries(snapshots).filter(([id, snapshot]) => {
      const tabId = Number(id);
      const tab = tabs.find((candidate) => candidate.id === tabId);
      return snapshot.url === tabUrl(tab) &&
        snapshot.navigationVersion === (tabNavigationVersions[tabId] ?? 0);
    }),
  );
}

export function tabContentRefreshIds(
  tabs: BrowserTab[],
  tabNavigationVersions: Record<number, number>,
  snapshots: TabContentSnapshots,
): number[] {
  return tabs.flatMap((tab) => {
    const url = tabUrl(tab);
    if (tab.id === undefined || tab.discarded || !isHttpUrl(url)) {
      return [];
    }
    const snapshot = snapshots[tab.id];
    return snapshot?.url === url &&
      snapshot?.navigationVersion === (tabNavigationVersions[tab.id] ?? 0)
      ? []
      : [tab.id];
  });
}
