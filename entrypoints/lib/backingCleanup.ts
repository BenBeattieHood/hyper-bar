import type { TabBackingLocation } from './bookmarkStorage';
import type { TabOwnership } from './tabOwnership';

interface TabReference {
  id?: number;
}

interface BackingCleanupDependencies {
  getTabOwnership(tabId: number): Promise<TabOwnership | undefined>;
  loadPendingJournal(): Promise<TabBackingLocation[]>;
  queryTabs(): Promise<readonly TabReference[]>;
  removeTabBackingBookmark(location: TabBackingLocation): Promise<void>;
  savePendingJournal(locations: readonly TabBackingLocation[]): Promise<void>;
  tabBackingLocations: ReadonlyMap<number, TabBackingLocation>;
}

export function createBackingCleanup(dependencies: BackingCleanupDependencies) {
  const backingClaimedByAnotherLiveTab = async (
    tabId: number,
    location: Pick<TabBackingLocation, 'backingId'> & { backingToken?: string },
  ): Promise<boolean> => {
    const tabs = await dependencies.queryTabs();
    const liveTabIds = new Set(tabs.flatMap((candidate) =>
      candidate.id === undefined ? [] : [candidate.id]),
    );
    if ([...dependencies.tabBackingLocations.entries()].some(([candidateId, candidate]) =>
      candidateId !== tabId &&
      liveTabIds.has(candidateId) && (
        candidate.backingId === location.backingId ||
        (location.backingToken !== undefined &&
          candidate.backingToken === location.backingToken)
      ),
    )) return true;
    const ownerships = await Promise.all(tabs.flatMap((candidate) =>
      candidate.id === undefined || candidate.id === tabId
        ? []
        : [dependencies.getTabOwnership(candidate.id)],
    ));
    return ownerships.some((ownership) =>
      ownership?.backingId === location.backingId ||
      (location.backingToken !== undefined &&
        ownership?.backingToken === location.backingToken),
    );
  };
  const removeBackingIfUnclaimed = async (
    tabId: number,
    location: TabBackingLocation | undefined,
  ): Promise<void> => {
    if (!location || await backingClaimedByAnotherLiveTab(tabId, location)) return;
    await dependencies.removeTabBackingBookmark(location);
  };

  // A removal that failed waits in the journal for the next tab event or worker start.
  const pending = new Map<string, TabBackingLocation>();
  let pendingLoad: Promise<void> | undefined;
  const loadPending = async () => {
    pendingLoad ??= dependencies.loadPendingJournal().then((locations) => {
      for (const location of locations) {
        if (!pending.has(location.backingId)) pending.set(location.backingId, location);
      }
    });
    try {
      await pendingLoad;
    } catch (error) {
      pendingLoad = undefined;
      throw error;
    }
  };
  const retryPending = async () => {
    await loadPending();
    let changed = false;
    for (const [backingId, location] of pending) {
      try {
        await removeBackingIfUnclaimed(-1, location);
        pending.delete(backingId);
        changed = true;
      } catch {
        // Keep the exact location for the next lifecycle event or worker start.
      }
    }
    if (changed) await dependencies.savePendingJournal([...pending.values()]);
  };

  return {
    backingClaimedByAnotherLiveTab,
    rememberPending: async (location: TabBackingLocation) => {
      await retryPending();
      pending.set(location.backingId, location);
      await dependencies.savePendingJournal([...pending.values()]);
    },
    removeBackingIfUnclaimed,
    retryPending,
  };
}