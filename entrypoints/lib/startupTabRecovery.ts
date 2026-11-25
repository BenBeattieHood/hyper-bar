import { bookmarkableTabUrl, deriveSpaces } from './bookmarks';
import {
  ensureHyperBookmarkStructure,
  localTabBackingPagesByWindow,
  localTabBackings,
  migrateTabBackingWindowIds,
  moveTabBackingToWindow,
  reconcileTabBackingFolders,
  type TabBackingLocation,
} from './bookmarkStorage';
import { addToMapSet } from './collections';
import { matchRestoredTabsToBackings, type UnclaimedTab } from './restoredTabBackings';
import type { SpaceTabRestore } from './spaceTabRestore';
import { hyperGroupOrdinal } from './tabGroups';
import {
  claimedBackings,
  getTabOwnership,
  loadTabOwnerships,
  tabOwnershipsById,
  type TabOwnership,
} from './tabOwnership';
import { waitForStableTabSnapshot } from './tabs';
import { tabPageIdentity } from './urlIdentity';
import { mapRestoredWindowIds, normalWindowIds, reconcileWindowActiveSpaceIds } from './windowState';

export interface StartupTabRecoveryDependencies {
  disposeRestoredNewTabs(
    tabs: Browser.tabs.Tab[],
    generations: ReadonlyMap<number, number | undefined>,
  ): Promise<void>;
  /** Navigations per tab, so a restored blank tab the user has since used is kept. */
  generations: ReadonlyMap<number, number>;
  persistTabOwnership(tabId: number, ownership: TabOwnership): Promise<void>;
  reopenParkedTabs(): Promise<void>;
  restoreSpaceTabs: SpaceTabRestore;
  routeTab(tabId: number, assignToActiveSpaceWhenUnmatched: boolean, fallbackSpaceId?: string): Promise<void>;
  /** Only a browser start brings windows back under new IDs. */
  startupRecoveryInProgress(): boolean;
  tabBackingLocations: ReadonlyMap<number, TabBackingLocation>;
  /** Advances on every tab creation and removal, so a pass that raced one runs again. */
  tabLifecycleGeneration(): number;
}

const stableSnapshotTiming = {
  quietPeriodMs: 750,
  timeoutMs: 5_000,
  wait: (durationMs: number) => new Promise<void>((resolve) => setTimeout(resolve, durationMs)),
};

/** Matches live tabs to their backings when the worker starts, and after a browser start restores windows. */
export function createStartupTabRecovery(dependencies: StartupTabRecoveryDependencies) {
  const { persistTabOwnership, restoreSpaceTabs, routeTab, tabBackingLocations } = dependencies;

  /**
   * Before any tab is routed, hands each tab that lost its claim the backing it
   * most likely held, all at once, so routing one tab cannot take another's.
   */
  const reclaimRestoredTabBackings = async (normalWindows: ReadonlySet<number>) => {
    const [tabs, windows, backings, groups, bookmarkTree] = await Promise.all([
      browser.tabs.query({}),
      browser.windows.getAll(),
      localTabBackings(),
      browser.tabGroups?.query({}) ?? Promise.resolve([]),
      browser.bookmarks.getTree(),
    ]);
    const openWindowIds = new Set(windows.flatMap((window) =>
      window.id === undefined ? [] : [window.id]));
    const spaces = deriveSpaces(bookmarkTree);
    const groupSpaceIds = new Map(groups.flatMap((group) => {
      const ordinal = hyperGroupOrdinal(group.title);
      const space = ordinal ? spaces[ordinal - 1] : undefined;
      return space ? [[group.id, space.id] as const] : [];
    }));
    const ownerships = await loadTabOwnerships(tabs);
    const { claimedBackingIds, claimedBackingTokens } =
      claimedBackings(tabBackingLocations.values(), Object.values(ownerships));
    const extensionOrigin = browser.runtime.getURL('');
    const unclaimedTabs = tabs.flatMap((tab): UnclaimedTab[] => {
      const url = bookmarkableTabUrl(tab, extensionOrigin);
      if (
        tab.id === undefined ||
        !url ||
        tab.pinned ||
        tab.incognito ||
        !normalWindows.has(tab.windowId) ||
        tabBackingLocations.has(tab.id) ||
        ownerships[tab.id]?.backingId
      ) return [];
      const spaceId = (tab.groupId >= 0 ? groupSpaceIds.get(tab.groupId) : undefined)
        ?? ownerships[tab.id]?.spaceId;
      return [{
        tabId: tab.id,
        windowId: tab.windowId,
        index: tab.index,
        url,
        ...(spaceId === undefined ? {} : { spaceId }),
      }];
    });
    const unclaimedBackings = backings.filter((backing) =>
      !claimedBackingIds.has(backing.backingId) &&
      !claimedBackingTokens.has(backing.backingToken));
    const windowIdsByTab = new Map(unclaimedTabs.map((tab) => [tab.tabId, tab.windowId]));
    const matches = matchRestoredTabsToBackings(unclaimedTabs, unclaimedBackings, openWindowIds);
    for (const { tabId, backing } of matches) {
      const windowId = windowIdsByTab.get(tabId) as number;
      if (backing.windowId !== windowId) await moveTabBackingToWindow(backing.backingId, windowId);
      await persistTabOwnership(tabId, {
        spaceId: backing.spaceId,
        windowId,
        backingId: backing.backingId,
        backingToken: backing.backingToken,
        url: backing.url,
      });
    }
  };

  const bootstrapTabBackings = async () => {
    await ensureHyperBookmarkStructure();
    const tabs = await waitForStableTabSnapshot(
      () => browser.tabs.query({}),
      stableSnapshotTiming,
    );
    const windows = await browser.windows.getAll();
    const previousWindowTargets = new Map<number, Set<number>>();
    const persistedLiveBackingIds = new Set<string>();
    await Promise.all(tabs.flatMap((tab) => tab.id === undefined ? [] : [
      getTabOwnership(tab.id).then((ownership) => {
        if (ownership?.backingId) persistedLiveBackingIds.add(ownership.backingId);
        if (ownership?.windowId === undefined) return;
        addToMapSet(previousWindowTargets, ownership.windowId, tab.windowId);
      }),
    ]));
    const backingPagesByWindow = await localTabBackingPagesByWindow();
    const normalWindows = normalWindowIds(windows);
    const livePagesByWindow = new Map<number, Set<string>>();
    for (const tab of tabs) {
      const identity = tabPageIdentity(tab);
      if (!identity || !normalWindows.has(tab.windowId)) continue;
      addToMapSet(livePagesByWindow, tab.windowId, identity);
    }
    // Only a browser start brings windows back under new IDs; at any other start each window is still its own.
    const previousToCurrentWindowIds = dependencies.startupRecoveryInProgress()
      ? mapRestoredWindowIds(previousWindowTargets, backingPagesByWindow, livePagesByWindow)
      : new Map<number, number>();
    let openWindowIds = new Set(windows.flatMap((window) =>
      window.id === undefined ? [] : [window.id],
    ));
    await reconcileWindowActiveSpaceIds(openWindowIds);
    const migratedBackingIds = await migrateTabBackingWindowIds(
      previousToCurrentWindowIds,
    );
    for (const backingId of migratedBackingIds) persistedLiveBackingIds.add(backingId);
    await Promise.all(tabs.flatMap((tab) => {
      if (tab.id === undefined) return [];
      return [getTabOwnership(tab.id).then(async (ownership) => {
        const currentWindowId = ownership?.windowId === undefined
          ? undefined
          : previousToCurrentWindowIds.get(ownership.windowId);
        if (!ownership || currentWindowId === undefined || currentWindowId === ownership.windowId) {
          return;
        }
        await persistTabOwnership(tab.id as number, {
          ...ownership,
          windowId: currentWindowId,
        });
      })];
    }));
    await reclaimRestoredTabBackings(normalWindows);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const generation = dependencies.tabLifecycleGeneration();
      const currentTabs = await browser.tabs.query({});
      let routingFailed = false;
      for (const tab of currentTabs) {
        if (tab.id === undefined) continue;
        try {
          await routeTab(tab.id, true);
        } catch {
          routingFailed = true;
          break;
        }
      }
      if (routingFailed) return;
      const [bookmarkTree, routedTabs] = await Promise.all([
        browser.bookmarks.getTree(),
        browser.tabs.query({}),
      ]);
      const spaces = deriveSpaces(bookmarkTree);
      const routedOwnerships = await tabOwnershipsById(routedTabs);
      for (const windowId of new Set(previousToCurrentWindowIds.values())) {
        for (const space of spaces) {
          const candidateTabIds = routedTabs.flatMap((tab) =>
            tab.id !== undefined &&
            tab.windowId === windowId &&
            routedOwnerships.get(tab.id)?.spaceId === space.id
              ? [tab.id]
              : [],
          );
          const restoredTabIds = await restoreSpaceTabs(
            space.id,
            windowId,
            candidateTabIds,
          );
          for (const tabId of restoredTabIds) {
            await routeTab(tabId, false, space.id);
          }
        }
      }
      const [latestTabs, latestWindows] = await Promise.all([
        browser.tabs.query({}),
        browser.windows.getAll(),
      ]);
      if (generation !== dependencies.tabLifecycleGeneration()) continue;
      const liveBackingIds = new Set([
        ...persistedLiveBackingIds,
        ...[...tabBackingLocations.values()].map((location) => location.backingId),
      ]);
      await Promise.all(latestTabs.flatMap((tab) => tab.id === undefined ? [] : [
        getTabOwnership(tab.id).then((ownership) => {
          if (ownership?.backingId) liveBackingIds.add(ownership.backingId);
        }),
      ]));
      openWindowIds = new Set(latestWindows.flatMap((window) =>
        window.id === undefined ? [] : [window.id],
      ));
      if (generation !== dependencies.tabLifecycleGeneration()) continue;
      try {
        await reconcileTabBackingFolders(
          openWindowIds,
          liveBackingIds,
          () => generation === dependencies.tabLifecycleGeneration(),
        );
        await dependencies.reopenParkedTabs();
        return;
      } catch (error) {
        if (generation === dependencies.tabLifecycleGeneration()) throw error;
      }
    }
  };

  const cleanupRestoredNewTabs = async () => {
    let stableTabGenerations = new Map<number, number | undefined>();
    const tabs = await waitForStableTabSnapshot(
      async () => {
        const snapshot = await browser.tabs.query({});
        stableTabGenerations = new Map(snapshot.flatMap((tab) =>
          tab.id === undefined
            ? []
            : [[tab.id, dependencies.generations.get(tab.id)] as const]),
        );
        return snapshot;
      },
      stableSnapshotTiming,
    );
    await dependencies.disposeRestoredNewTabs(tabs, stableTabGenerations);
  };

  return { bootstrapTabBackings, cleanupRestoredNewTabs };
}
