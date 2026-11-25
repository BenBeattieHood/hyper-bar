import {
  ensureTabBackingBookmark,
  removeTabBackingBookmark,
  type TabBackingLocation,
  type TabBackingPlace,
} from './bookmarkStorage';
import {
  claimedBackings,
  getTabOwnership,
  loadTabOwnerships,
  removeTabSpaceId,
  type TabOwnership,
} from './tabOwnership';
import { tabById } from './tabs';
import { normaliseUrl, tabUrl, urlsShareDomain } from './urlIdentity';

export interface TabBackingSyncDependencies {
  /** Navigations per tab: a sync begun for an older navigation stops. */
  generations: ReadonlyMap<number, number>;
  persistTabOwnership(tabId: number, ownership: TabOwnership): Promise<void>;
  rememberPendingBackingCleanup(location: TabBackingLocation): Promise<void>;
  removeBackingIfUnclaimed(tabId: number, location: TabBackingLocation | undefined): Promise<void>;
  /** Tabs removed since the worker started, and whether their window was closing. */
  removedTabs: ReadonlyMap<number, boolean>;
  tabBackingLocations: Map<number, TabBackingLocation>;
}

export interface RemovedTab {
  isWindowClosing: boolean;
  locationAtRemoval: TabBackingLocation | undefined;
  ownershipAtRemoval: Promise<TabOwnership | undefined>;
  removalGeneration: number;
  tabId: number;
}

/** The backing a stored ownership names, when it records all of it. */
const ownedBacking = (ownership: TabOwnership | undefined): TabBackingLocation | undefined =>
  ownership?.backingId && ownership.backingToken && ownership.url
    ? {
        backingId: ownership.backingId,
        backingToken: ownership.backingToken,
        spaceId: ownership.spaceId,
        windowId: ownership.windowId,
        url: ownership.url,
      }
    : undefined;

/** Keeps each live tab's backing bookmark in step with its page, and releases it when the tab goes. */
export function createTabBackingSync(dependencies: TabBackingSyncDependencies) {
  const { generations, persistTabOwnership, removedTabs, tabBackingLocations } = dependencies;

  /**
   * Where a tab's new backing goes, so the list takes the tab's place in the
   * strip: a link's tab just after its page or that page's earlier links, past
   * which the browser opens it, and any other tab between the backed tabs
   * either side of it. With no backed tab after it, as for a new tab at the
   * strip's end, it goes last.
   */
  const newBackingPlace = async (
    tab: Browser.tabs.Tab,
    spaceId: string,
  ): Promise<TabBackingPlace | undefined> => {
    const windowTabs = await browser.tabs.query({ windowId: tab.windowId });
    const current = windowTabs.find((candidate) => candidate.id === tab.id);
    if (!current) return undefined;
    const ownerships = await loadTabOwnerships(windowTabs);
    const backingOf = (candidate: Browser.tabs.Tab) =>
      tabBackingLocations.get(candidate.id!)?.backingId ?? ownerships[candidate.id!]?.backingId;
    const spaceTabs = windowTabs
      .filter((candidate) => candidate.id !== undefined && candidate.id !== tab.id &&
        candidate.pinned === current.pinned && ownerships[candidate.id]?.spaceId === spaceId)
      .sort((left, right) => left.index - right.index);
    const preceding = spaceTabs.filter((candidate) => candidate.index < current.index).reverse();
    const openerTabId = current.openerTabId;
    for (const candidate of openerTabId === undefined ? [] : preceding) {
      if (candidate.id !== openerTabId && candidate.openerTabId !== openerTabId) break;
      const backingId = backingOf(candidate);
      if (backingId) return { after: backingId };
    }
    const next = spaceTabs.filter((candidate) => candidate.index > current.index)
      .map(backingOf).find((backingId) => backingId !== undefined);
    if (!next) return undefined;
    const previous = preceding.map(backingOf).find((backingId) => backingId !== undefined);
    return previous ? { previous, next } : { next };
  };

  const syncTabBacking = async (tab: Browser.tabs.Tab, spaceId: string) => {
    if (tab.id === undefined) return;
    const liveTab = await tabById(tab.id);
    if (!liveTab || removedTabs.has(tab.id)) return;
    const previous = tabBackingLocations.get(tab.id) ?? ownedBacking(await getTabOwnership(tab.id));
    // Between navigations a tab can briefly report no address at all, which says nothing about its page.
    if (!tabUrl(liveTab) && previous?.spaceId === spaceId) return;
    const persistedClaims = Object.values(await loadTabOwnerships(
      (await browser.tabs.query({})).filter((candidate) => candidate.id !== tab.id),
    ));
    const { claimedBackingIds, claimedBackingTokens } = claimedBackings(
      [...tabBackingLocations].flatMap(([claimedTabId, location]) =>
        claimedTabId === tab.id ? [] : [location]),
      persistedClaims,
    );
    const next = await ensureTabBackingBookmark(
      liveTab,
      spaceId,
      previous,
      claimedBackingIds,
      claimedBackingTokens,
      () => newBackingPlace(liveTab, spaceId),
    );
    const removedDuringSync = removedTabs.get(tab.id);
    const stillOpen = removedDuringSync === undefined
      ? await browser.tabs.get(tab.id).then(() => true).catch(() => false)
      : false;
    if (!stillOpen) {
      if (!removedDuringSync) await dependencies.removeBackingIfUnclaimed(tab.id, next);
      tabBackingLocations.delete(tab.id);
      return;
    }
    if (
      previous &&
      (!next || previous.backingId !== next.backingId) &&
      !claimedBackingIds.has(previous.backingId) &&
      !claimedBackingTokens.has(previous.backingToken)
    ) {
      await removeTabBackingBookmark(previous);
    }
    if (next) {
      tabBackingLocations.set(tab.id, next);
      await persistTabOwnership(tab.id, next);
    } else {
      tabBackingLocations.delete(tab.id);
      await persistTabOwnership(tab.id, {
        spaceId,
        windowId: liveTab.windowId,
      });
    }
  };

  const syncSameDomainNavigation = async (
    tabId: number,
    url: string,
    generation: number,
  ): Promise<boolean> => {
    const [tab, ownership] = await Promise.all([
      tabById(tabId),
      getTabOwnership(tabId),
    ]);
    if (
      !tab ||
      !ownership?.url ||
      generations.get(tabId) !== generation ||
      normaliseUrl(tabUrl(tab)) !== normaliseUrl(url) ||
      !urlsShareDomain(ownership.url, url)
    ) return false;
    await syncTabBacking(tab, ownership.spaceId);
    return true;
  };

  // Backings of removed tabs whose release has yet to run, each held from the moment its tab went.
  const closingBackings = new Map<number, Promise<TabBackingLocation | undefined>>();

  const releaseRemovedTab = async (
    { isWindowClosing, locationAtRemoval, removalGeneration, tabId }: RemovedTab,
    backing: Promise<TabBackingLocation | undefined>,
  ) => {
    if (generations.get(tabId) !== removalGeneration) return;
    const location = await backing;
    const failures: unknown[] = [];
    if (!isWindowClosing && location) {
      try {
        await dependencies.removeBackingIfUnclaimed(-1, location);
      } catch (error) {
        failures.push(error);
        try {
          await dependencies.rememberPendingBackingCleanup(location);
        } catch (journalError) {
          failures.push(journalError);
        }
      }
    }
    if (generations.get(tabId) === removalGeneration) {
      try {
        await removeTabSpaceId(tabId);
      } catch (error) {
        failures.push(error);
      }
      if (tabBackingLocations.get(tabId) === locationAtRemoval) {
        tabBackingLocations.delete(tabId);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Unable to fully clean up the removed tab.');
    }
  };

  /**
   * Holds a removed tab's backing as closing from the moment the tab goes, and
   * returns the release that removes it, for the mutation queue to run in turn.
   * A restore that runs meanwhile still finds the backing but must not reopen
   * the tab from it. A closing window keeps its backings to restore its tabs.
   */
  const tabRemoved = (removed: RemovedTab): (() => Promise<void>) => {
    const backing = removed.ownershipAtRemoval.then((ownership) =>
      removed.locationAtRemoval ?? ownedBacking(ownership));
    const held = backing.catch(() => undefined);
    if (!removed.isWindowClosing) closingBackings.set(removed.tabId, held);
    return () => releaseRemovedTab(removed, backing).finally(() => {
      if (closingBackings.get(removed.tabId) === held) closingBackings.delete(removed.tabId);
    });
  };

  /** Whether a removed tab's backing is still waiting for its release. */
  const backingClosing = async (backing: { backingId: string; backingToken?: string }) =>
    (await Promise.all(closingBackings.values())).some((location) =>
      location?.backingId === backing.backingId ||
      (backing.backingToken !== undefined && location?.backingToken === backing.backingToken));

  return { backingClosing, syncSameDomainNavigation, syncTabBacking, tabRemoved };
}
