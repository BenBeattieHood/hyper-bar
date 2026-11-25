import type { BrowserTab } from './bookmarks';
import type { MediaControlTarget } from './mediaControl';
import { isMusicSite } from './musicSites';
import { isHttpUrl, tabUrl } from './urlIdentity';

export interface TabMediaState extends MediaControlTarget {
  navigationVersion: number;
  url: string;
}

export type TabMediaStates = Readonly<Record<number, TabMediaState>>;

export function tabMediaUrl(tab: BrowserTab): string | undefined {
  const url = tabUrl(tab);
  return isHttpUrl(url) ? url : undefined;
}

export function canInspectTabMedia(tab: BrowserTab): boolean {
  return tab.id !== undefined && !tab.discarded && !tab.incognito && tabMediaUrl(tab) !== undefined;
}

export function tabMediaStateMatchesTab(
  state: TabMediaState,
  tab: BrowserTab | undefined,
  navigationVersions: Readonly<Record<number, number>>,
): boolean {
  const tabId = tab?.id;
  if (tabId === undefined || !tab) return false;
  return state.tabId === tabId &&
    state.url === tabMediaUrl(tab) &&
    state.navigationVersion === (navigationVersions[tabId] ?? 0);
}

export function currentTabMediaStates(
  tabs: BrowserTab[],
  navigationVersions: Readonly<Record<number, number>>,
  states: TabMediaStates,
): TabMediaStates {
  return Object.fromEntries(Object.entries(states).flatMap(([tabId, state]) => {
    const tab = tabs.find((candidate) => candidate.id === Number(tabId));
    return tabMediaStateMatchesTab(state, tab, navigationVersions)
      ? [[Number(tabId), state] as const]
      : [];
  }));
}

export function currentMediaRetainedTabIds(
  tabs: BrowserTab[],
  retainedTabIds: Readonly<Record<number, number>>,
): Readonly<Record<number, number>> {
  return Object.fromEntries(Object.entries(retainedTabIds).flatMap(([windowId, tabId]) => {
    const tab = tabs.find((candidate) => candidate.id === tabId);
    return tab && !tab.incognito && tab.windowId === Number(windowId)
      ? [[Number(windowId), tabId] as const]
      : [];
  }));
}

/** The pages media control could not reach that are still open and inspectable. */
export function currentMediaUnreachableTabIds(
  tabs: readonly BrowserTab[],
  unreachableTabIds: readonly number[],
): readonly number[] {
  return unreachableTabIds.filter((tabId) => tabs.some((tab) =>
    tab.id === tabId && canInspectTabMedia(tab)));
}

export function mediaTargetForWindow(
  tabs: BrowserTab[],
  windowId: number,
  states: TabMediaStates,
  retainedTabIds: Readonly<Record<number, number>>,
): TabMediaState | undefined {
  const candidates = Object.values(states).filter((state) => tabs.some((tab) =>
    tab.id === state.tabId && tab.windowId === windowId));
  const retained = candidates.find((state) => state.tabId === retainedTabIds[windowId]);
  return retained ??
    candidates.find((state) => state.state === 'playing') ??
    candidates.find((state) => state.state === 'paused');
}

/**
 * The tabs Now Playing shows for a window, the one it controls first. It is
 * shown exactly when this is not empty.
 */
export function mediaControlTabs(
  tabs: readonly BrowserTab[],
  currentWindowId: number | null,
  target?: MediaControlTarget,
  retainedTabId?: number,
): BrowserTab[] {
  const audibleTabs = tabs.filter((tab) =>
    tab.windowId === currentWindowId && tab.audible);
  if (audibleTabs.length > 0) {
    const preferredTabId = retainedTabId ?? target?.tabId;
    const preferredTab = audibleTabs.find((tab) => tab.id === preferredTabId);
    return preferredTab
      ? [preferredTab, ...audibleTabs.filter((tab) => tab !== preferredTab)]
      : audibleTabs;
  }
  if (target) {
    const controlledTab = tabs.find((tab) =>
      tab.id === target.tabId && tab.windowId === currentWindowId);
    if (controlledTab) return [controlledTab];
  }
  const retainedTab = tabs.find((tab) =>
    tab.id === retainedTabId && tab.windowId === currentWindowId);
  return retainedTab ? [retainedTab] : [];
}

/** The tab Now Playing shows first in a window, which its controls act on. */
export function nowPlayingTab(
  tabs: readonly BrowserTab[],
  windowId: number | null,
  target?: MediaControlTarget,
  retainedTabId?: number,
): BrowserTab | undefined {
  return mediaControlTabs(tabs, windowId, target, retainedTabId).find((tab) => tab.id !== undefined);
}

/**
 * A window's music-site tabs while Now Playing is shown there. Music is
 * background rather than the task in hand, and Now Playing already focuses and
 * controls it, so the favourites bar leaves these out of its recent tabs.
 */
export function backgroundMusicTabIds(
  tabs: readonly BrowserTab[],
  windowId: number,
  target?: MediaControlTarget,
  retainedTabId?: number,
): number[] {
  if (mediaControlTabs(tabs, windowId, target, retainedTabId).length === 0) return [];
  return tabs.flatMap((tab) =>
    tab.id !== undefined &&
    tab.windowId === windowId &&
    isMusicSite(tabUrl(tab))
      ? [tab.id]
      : []);
}