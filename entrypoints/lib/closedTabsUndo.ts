import type { BookmarkNode, BrowserTab } from './bookmarks';
import { ensureSpaceTabsFolder } from './bookmarkStorage';
import { treeIds } from './bookmarkUndo';
import type { SpaceTabRestore } from './spaceTabRestore';
import { getTabOwnership, type TabOwnership } from './tabOwnership';
import { isBlankTabPage } from './tabs';
import { rebuildTabTree } from './tabTreeRebuild';
import type { RemadeBookmarks, UndoSeries } from './timedMessages';
import { tabUrl } from './urlIdentity';

/** What closing tabs took from one space in one window, read before they close, so an undo can put it back. */
export interface ClosedSpaceTabs {
  /** The backing of the tab that was showing, when it was one of those closed. */
  activeBackingId?: string;
  backingIds: ReadonlySet<string>;
  spaceId: string;
  tabsTree: BookmarkNode;
  windowId: number;
}

export interface ClosedTabsReopenDependencies {
  restoreSpaceTabs: SpaceTabRestore;
  routeTab(tabId: number, spaceId: string): Promise<void>;
}

/** A new tab page has nothing to bring back. */
export const isBlankTab = (tab: BrowserTab) =>
  isBlankTabPage(tabUrl(tab), browser.runtime.getURL('/newtab.html'));

/**
 * Reads, before tabs close, each of their spaces' tab trees and the backings
 * the tabs show. A pinned tab belongs to no space, and a tab with no backing
 * has nothing to make again, so neither is recorded.
 */
export async function snapshotClosingTabs(
  tabs: readonly BrowserTab[],
  ownerships: Readonly<Record<number, TabOwnership | undefined>>,
): Promise<ClosedSpaceTabs[]> {
  const groups = new Map<string, { active?: string; backingIds: Set<string>; spaceId: string; windowId: number }>();
  for (const tab of tabs) {
    const ownership = tab.id === undefined || tab.pinned ? undefined : ownerships[tab.id];
    if (!ownership?.backingId) continue;
    const key = `${ownership.spaceId}\n${tab.windowId}`;
    const group = groups.get(key) ??
      { backingIds: new Set<string>(), spaceId: ownership.spaceId, windowId: tab.windowId };
    group.backingIds.add(ownership.backingId);
    if (tab.active) group.active = ownership.backingId;
    groups.set(key, group);
  }
  const closed: ClosedSpaceTabs[] = [];
  for (const { active, backingIds, spaceId, windowId } of groups.values()) {
    const [tabsTree] = await browser.bookmarks.getSubTree((await ensureSpaceTabsFolder(spaceId)).id);
    if (!tabsTree) continue;
    closed.push({ ...(active ? { activeBackingId: active } : {}), backingIds, spaceId, tabsTree, windowId });
  }
  return closed;
}

/**
 * Makes closed tabs' backings again in their tab folders and split views,
 * named and linked as they were, and reopens their tabs in the window. Answers
 * the reopened tabs, and which of them is the one that was showing.
 */
export async function reopenClosedTabs(
  closed: ClosedSpaceTabs,
  dependencies: ClosedTabsReopenDependencies,
  remade?: RemadeBookmarks,
): Promise<{ reopened: number[]; shownTabId?: number }> {
  const { activeBackingId, backingIds, spaceId, tabsTree, windowId } = closed;
  const tabsFolder = await ensureSpaceTabsFolder(spaceId);
  const [current] = await browser.bookmarks.getSubTree(tabsFolder.id);
  const rebuilt = await rebuildTabTree(tabsTree, tabsFolder.id, {
    backingTitle: (node) => backingIds.has(node.id) ? node.title : undefined,
    keepEmptyFolders: false,
    present: treeIds(current ? [current] : []),
    ...(remade ? { remade } : {}),
  });
  const reopened = await dependencies.restoreSpaceTabs(spaceId, windowId, []);
  for (const tabId of reopened) await dependencies.routeTab(tabId, spaceId);
  const shownBackingId = activeBackingId && rebuilt.get(activeBackingId);
  if (!shownBackingId) return { reopened };
  for (const tabId of reopened) {
    if ((await getTabOwnership(tabId))?.backingId === shownBackingId) return { reopened, shownTabId: tabId };
  }
  return { reopened };
}

/** Closes in a row join into one message counting every tab they closed, by backing. */
export const closedTabsSeries = (backingIds: readonly string[]): UndoSeries => ({
  items: backingIds,
  key: 'closed-tabs',
  summary: (count) => `Closed ${count} tabs`,
});

/** Names what a close took away: the closed folder, the one tab, or how many tabs. */
export function closedTabsText(
  pages: readonly Pick<BrowserTab, 'title' | 'url'>[],
  folderTitle?: string,
): { detail?: string; text: string } {
  if (folderTitle !== undefined) return { ...(folderTitle ? { detail: folderTitle } : {}), text: 'Closed folder' };
  const [only] = pages;
  return pages.length === 1 && only
    ? { detail: only.title || only.url || '', text: 'Closed tab' }
    : { text: `Closed ${pages.length} tabs` };
}
