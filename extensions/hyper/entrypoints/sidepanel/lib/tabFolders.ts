import type { BookmarkNode, BrowserTab } from '../../lib/bookmarks';
import { normaliseUrl, tabUrl } from '../../lib/urlIdentity';

/** Tabs to close so each page stays open once, keeping its active copy or else its first; a different query is a different page. */
export function duplicateTabIds(tabs: readonly BrowserTab[]): number[] {
  const copiesByPage = new Map<string, BrowserTab[]>();
  for (const tab of tabs) {
    const identity = normaliseUrl(tabUrl(tab));
    if (!identity || tab.id === undefined) continue;
    copiesByPage.set(identity, [...(copiesByPage.get(identity) ?? []), tab]);
  }
  return [...copiesByPage.values()].flatMap((copies) => {
    const kept = copies.find((tab) => tab.active) ?? copies[0];
    return copies.flatMap((tab) => tab !== kept && tab.id !== undefined ? [tab.id] : []);
  });
}

export function tabIdsByFolder(
  nodes: readonly BookmarkNode[],
  tabsByNodeId: Readonly<Record<string, BrowserTab | undefined>>,
): Record<string, number[]> {
  const byFolderId: Record<string, number[]> = {};
  const collect = (node: BookmarkNode): number[] => {
    if (node.url) {
      const tabId = tabsByNodeId[node.id]?.id;
      return tabId === undefined ? [] : [tabId];
    }
    const tabIds = (node.children ?? []).flatMap(collect);
    byFolderId[node.id] = tabIds;
    return tabIds;
  };
  nodes.forEach(collect);
  return byFolderId;
}

/**
 * The extra copies inside each folder, manual or auto, counting subfolders.
 * Derived only from the tabs the folder holds now, so it cannot fall behind them.
 */
export function duplicateTabIdsByFolder(
  nodes: readonly BookmarkNode[],
  tabsByNodeId: Readonly<Record<string, BrowserTab | undefined>>,
): Record<string, number[]> {
  const tabsById = new Map(Object.values(tabsByNodeId).flatMap((tab) =>
    tab?.id === undefined ? [] : [[tab.id, tab] as const]));
  return Object.fromEntries(Object.entries(tabIdsByFolder(nodes, tabsByNodeId)).map(
    ([folderId, tabIds]) => [
      folderId,
      duplicateTabIds(tabIds.flatMap((tabId) => tabsById.get(tabId) ?? [])),
    ],
  ));
}