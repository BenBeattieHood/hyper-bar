import { pageIdentity, urlsShareDomain } from './urlIdentity';

export interface UnclaimedTab {
  tabId: number;
  windowId: number;
  index: number;
  url: string;
  /** The space the tab's restored group names, when it sits in one. */
  spaceId?: string;
}

export interface UnclaimedBacking {
  backingId: string;
  backingToken: string;
  spaceId: string;
  windowId: number;
  tabIndex?: number;
  url: string;
}

export interface RestoredTabBackingMatch {
  tabId: number;
  backing: UnclaimedBacking;
}

type Pass = (tab: UnclaimedTab, backing: UnclaimedBacking) => boolean;

// Most certain first. A restored tab can come back at an older address than its
// backing recorded, because the browser saves a page before its redirects and
// in-page navigations settle; the same site is still that tab. A place alone
// only says so in the same window.
const passes: Pass[] = [
  (tab, backing) => pageIdentity(tab.url) === pageIdentity(backing.url),
  (tab, backing) => urlsShareDomain(tab.url, backing.url),
  (tab, backing) => backing.windowId === tab.windowId && backing.tabIndex === tab.index,
];

function indexDistance(tab: UnclaimedTab, backing: UnclaimedBacking): number {
  return backing.tabIndex === undefined
    ? Number.MAX_SAFE_INTEGER
    : Math.abs(backing.tabIndex - tab.index);
}

/**
 * Pairs tabs that hold no backing with backings no tab holds, one to one, so a
 * restored tab takes back its own backing instead of being given a new one
 * while its old one reopens as a second tab. A backing stays in its window,
 * unless that window is closed, when the backing is parked and any window's
 * tab may take it, after that window's own backings.
 */
export function matchRestoredTabsToBackings(
  tabs: readonly UnclaimedTab[],
  backings: readonly UnclaimedBacking[],
  openWindowIds: ReadonlySet<number>,
): RestoredTabBackingMatch[] {
  const matchedTabIds = new Set<number>();
  const matchedBackingIds = new Set<string>();
  const matches: RestoredTabBackingMatch[] = [];
  for (const pass of passes) {
    const candidates = tabs.flatMap((tab) => backings.flatMap((backing) =>
      !matchedTabIds.has(tab.tabId) &&
      !matchedBackingIds.has(backing.backingId) &&
      (backing.windowId === tab.windowId || !openWindowIds.has(backing.windowId)) &&
      (tab.spaceId === undefined || tab.spaceId === backing.spaceId) &&
      pass(tab, backing)
        ? [{
            tab,
            backing,
            distance: indexDistance(tab, backing),
            parked: backing.windowId === tab.windowId ? 0 : 1,
          }]
        : []));
    candidates.sort((left, right) =>
      left.parked - right.parked ||
      left.distance - right.distance ||
      left.tab.index - right.tab.index ||
      (left.backing.tabIndex ?? 0) - (right.backing.tabIndex ?? 0));
    for (const { tab, backing } of candidates) {
      if (matchedTabIds.has(tab.tabId) || matchedBackingIds.has(backing.backingId)) continue;
      matchedTabIds.add(tab.tabId);
      matchedBackingIds.add(backing.backingId);
      matches.push({ tabId: tab.tabId, backing });
    }
  }
  return matches;
}
