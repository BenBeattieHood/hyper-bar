import { createCoalescedAsyncRunner } from './async';
import type { BrowserTab } from './bookmarks';
import {
  canControlTabMedia,
  inspectTabMedia,
  pausePlayingTabMedia,
  setTabMediaPlayback,
  type MediaControlTarget,
  type MediaPlaybackState,
  type TabMediaInspection,
} from './mediaControl';
import { hyperModelAtom, type HyperModelStore } from './model';
import type { HyperActionKind } from './modelActions';
import { intentHandler, type HyperIntentHandlers } from './modelIntents';
import { parseSetTabMediaPlaybackPayload } from './modelIntentPayloads';
import type { HyperModelPortClient } from './modelPort';
import { tabTarget, windowTarget } from './modelGuards';
import { scriptingReady } from './scriptingAccess';
import {
  canInspectTabMedia,
  currentMediaRetainedTabIds,
  tabMediaStateMatchesTab,
  tabMediaUrl,
  type TabMediaState,
  type TabMediaStates,
} from './mediaState';

type MediaIntentKind = Extract<HyperActionKind, 'setTabMediaPlayback'>;

// A retained tab that has fallen silent without a committed paused target keeps
// its Now Playing slot briefly, so a momentary audio drop does not flicker the
// control away before the background can recapture or genuinely release it.
const SILENT_RETENTION_GRACE_MS = 1_000;

interface TabUpdate {
  audible?: boolean;
  status?: string;
  url?: string;
}

export interface MediaControllerDependencies {
  canControl?: () => boolean;
  inspect?: (tabId: number) => Promise<TabMediaInspection>;
  pauseOthers?: (tabIds: readonly number[]) => Promise<void>;
  queueMutation<Result>(operation: () => Promise<Result>): Promise<Result>;
  reconcile(): Promise<unknown>;
  /** Settles once a newly granted scripting API can be used, however that turns out. */
  scriptingReady?: () => Promise<unknown>;
  setPlayback?: (
    target: MediaControlTarget,
    state: MediaPlaybackState,
  ) => Promise<MediaControlTarget | undefined>;
  store: HyperModelStore;
}

export interface MediaController {
  /** Looks again at the pages it could not reach, or could reach only through access now gone. */
  handlePermissionsChanged(): Promise<void>;
  handlePlaybackChanged(tabId: number): Promise<void>;
  handleTabUpdated(tabId: number, changeInfo: TabUpdate, tab: BrowserTab): Promise<void>;
  handlers: Pick<HyperIntentHandlers, MediaIntentKind>;
  markNavigation(tabId: number): void;
  /** Inspects the tab's page now, and settles with whether Hyper reached it and the player it found. */
  reinspect(tabId: number): Promise<TabMediaInspection>;
  removeTab(tabId: number): void;
  runtimeSignals(): {
    mediaControlAvailable: boolean;
    mediaNavigationVersions: Readonly<Record<number, number>>;
    mediaRetainedTabIds: Readonly<Record<number, number>>;
    mediaStates: TabMediaStates;
    mediaUnreachableTabIds: readonly number[];
  };
}

function stateEquals(left: TabMediaState | undefined, right: TabMediaState): boolean {
  return left?.tabId === right.tabId &&
    left.frameId === right.frameId &&
    left.elementIndex === right.elementIndex &&
    left.state === right.state &&
    left.navigationVersion === right.navigationVersion &&
    left.url === right.url;
}

/**
 * Keeps discardable media targets in the background, so page inspection,
 * exclusive playback policy, and user controls survive a sidebar reload.
 */
export function createMediaController(
  dependencies: MediaControllerDependencies,
): MediaController {
  const canControl = dependencies.canControl ?? canControlTabMedia;
  const inspect = dependencies.inspect ?? inspectTabMedia;
  const pauseOthers = dependencies.pauseOthers ?? pausePlayingTabMedia;
  const setPlayback = dependencies.setPlayback ?? setTabMediaPlayback;
  const whenScriptingReady = dependencies.scriptingReady ?? scriptingReady;
  let states: TabMediaStates = {};
  let retainedTabIds: Readonly<Record<number, number>> = {};
  const navigationVersions = new Map<number, number>();
  const lifecycleVersions = new Map<number, number>();
  const attemptedVersions = new Map<number, number>();
  const forcedInspectionTabIds = new Set<number>();
  // Pages whose own script did not answer and that Hyper has no access to script.
  const unreachableTabIds = new Set<number>();
  let knownAudibleTabIds = new Set<number>();
  let audibleSeeded = false;
  const silentRetainedSince = new Map<number, number>();
  let graceReleaseTimer: ReturnType<typeof setTimeout> | undefined;

  const navigationVersion = (tabId: number) => navigationVersions.get(tabId) ?? 0;
  const lifecycleVersion = (tabId: number) => lifecycleVersions.get(tabId) ?? 0;
  const navigationVersionRecord = () => Object.fromEntries(navigationVersions);
  const tabFor = (tabId: number) => dependencies.store.get(hyperModelAtom).browser.tabs.find(
    (tab) => tab.id === tabId,
  );
  const cancelGraceReleaseIfIdle = () => {
    if (silentRetainedSince.size > 0 || graceReleaseTimer === undefined) return;
    clearTimeout(graceReleaseTimer);
    graceReleaseTimer = undefined;
  };
  const clearSilentRetention = (tabId: number) => {
    silentRetainedSince.delete(tabId);
    cancelGraceReleaseIfIdle();
  };
  const stateMatches = (state: TabMediaState, tab: BrowserTab | undefined) =>
    tabMediaStateMatchesTab(state, tab, navigationVersionRecord());

  const deleteState = (tabId: number) => {
    if (!(tabId in states)) return false;
    const nextStates = { ...states };
    delete nextStates[tabId];
    states = nextStates;
    return true;
  };

  const setUnreachable = (tabId: number, unreachable: boolean) => {
    if (unreachableTabIds.has(tabId) === unreachable) return false;
    if (unreachable) unreachableTabIds.add(tabId);
    else unreachableTabIds.delete(tabId);
    return true;
  };

  const retain = (windowId: number, tabId: number) => {
    const tab = tabFor(tabId);
    if (!tab || tab.incognito || tab.windowId !== windowId) return false;
    if (retainedTabIds[windowId] === tabId) return false;
    retainedTabIds = { ...retainedTabIds, [windowId]: tabId };
    return true;
  };

  const releaseRetained = (tabId: number) => {
    const next = Object.fromEntries(Object.entries(retainedTabIds).filter(
      ([, retainedTabId]) => retainedTabId !== tabId,
    ));
    if (Object.keys(next).length === Object.keys(retainedTabIds).length) return false;
    retainedTabIds = next;
    clearSilentRetention(tabId);
    return true;
  };

  const prune = () => {
    let changed = false;
    for (const [tabId, state] of Object.entries(states)) {
      const tab = tabFor(Number(tabId));
      if (!canInspectTabMedia(tab ?? {} as BrowserTab) || !stateMatches(state, tab)) {
        changed = deleteState(Number(tabId)) || changed;
      }
    }
    for (const tabId of [...unreachableTabIds]) {
      if (!canInspectTabMedia(tabFor(tabId) ?? {} as BrowserTab)) {
        changed = setUnreachable(tabId, false) || changed;
      }
    }
    const snapshot = dependencies.store.get(hyperModelAtom);
    const nextRetained = currentMediaRetainedTabIds(snapshot.browser.tabs, retainedTabIds);
    if (Object.keys(nextRetained).length !== Object.keys(retainedTabIds).length ||
      Object.entries(nextRetained).some(([windowId, tabId]) => retainedTabIds[Number(windowId)] !== tabId)) {
      retainedTabIds = nextRetained;
      changed = true;
    }
    const retainedTabIdSet = new Set(Object.values(retainedTabIds));
    for (const tabId of [...silentRetainedSince.keys()]) {
      if (!retainedTabIdSet.has(tabId)) clearSilentRetention(tabId);
    }
    return changed;
  };

  const inspectCurrentTab = async (tab: BrowserTab, force: boolean) => {
    if (!canInspectTabMedia(tab) || tab.id === undefined) return false;
    const tabId = tab.id;
    const expectedNavigationVersion = navigationVersion(tabId);
    const expectedLifecycleVersion = lifecycleVersion(tabId);
    const state = states[tabId];
    if (!force && state && stateMatches(state, tab)) return false;
    if (!force && attemptedVersions.get(tabId) === expectedNavigationVersion) return false;
    attemptedVersions.set(tabId, expectedNavigationVersion);
    forcedInspectionTabIds.delete(tabId);
    const inspection = await inspect(tabId).catch(() => undefined);
    if (
      lifecycleVersion(tabId) !== expectedLifecycleVersion ||
      navigationVersion(tabId) !== expectedNavigationVersion
    ) return false;
    const currentTab = tabFor(tabId);
    if (!currentTab || !canInspectTabMedia(currentTab)) return false;
    // An inspection that failed outright says nothing about whether the page can answer.
    const reachabilityChanged = inspection !== undefined &&
      setUnreachable(tabId, !inspection.reachable);
    const target = inspection?.target;
    if (!target) {
      const removed = deleteState(tabId);
      return (!currentTab.audible ? releaseRetained(tabId) || removed : removed) ||
        reachabilityChanged;
    }
    const url = tabMediaUrl(currentTab);
    if (!url) return reachabilityChanged;
    const next: TabMediaState = {
      ...target,
      navigationVersion: expectedNavigationVersion,
      url,
    };
    if (stateEquals(states[tabId], next)) return reachabilityChanged;
    states = { ...states, [tabId]: next };
    return true;
  };

  const pauseOtherTabs = async (tabId: number, windowId: number) => {
    const tabIds = dependencies.store.get(hyperModelAtom).browser.tabs.flatMap((tab) =>
      tab.id !== undefined &&
      tab.id !== tabId &&
      tab.windowId === windowId &&
      canInspectTabMedia(tab)
        ? [tab.id]
        : []);
    await pauseOthers(tabIds);
  };

  // Exclusive playback is a property of the committed model, not of a single
  // `tabs.onUpdated` event: whichever tab becomes audible pauses the others in
  // its window. Deriving it from reconciliation keeps the policy alive across
  // service-worker restarts and any dropped event, and is what lets the sidebar
  // rely on the background rather than observing tabs itself.
  const enforceExclusivePlayback = async () => {
    const snapshot = dependencies.store.get(hyperModelAtom);
    const audibleNow = new Set<number>();
    const audibleTabsByWindow = new Map<number, BrowserTab[]>();
    for (const tab of snapshot.browser.tabs) {
      if (tab.id === undefined || !tab.audible || !canInspectTabMedia(tab)) continue;
      audibleNow.add(tab.id);
      const tabs = audibleTabsByWindow.get(tab.windowId) ?? [];
      tabs.push(tab);
      audibleTabsByWindow.set(tab.windowId, tabs);
    }
    let retained = false;
    for (const [windowId, tabs] of audibleTabsByWindow) {
      // A tab that has just started playing takes over; otherwise the retained one keeps it.
      const winner = (audibleSeeded ? tabs.find((tab) => !knownAudibleTabIds.has(tab.id!)) : undefined) ??
        tabs.find((tab) => tab.id === retainedTabIds[windowId]) ??
        tabs.find((tab) => tab.active) ??
        [...tabs].sort((left, right) => left.id! - right.id!)[0]!;
      const winnerId = winner.id!;
      const newAudibleTab = tabs.some((tab) => !knownAudibleTabIds.has(tab.id!));
      const winnerChanged = retainedTabIds[windowId] !== winnerId;
      if (!audibleSeeded || newAudibleTab || winnerChanged) {
        retained = retain(windowId, winnerId) || retained;
        await pauseOtherTabs(winnerId, windowId);
      }
    }
    audibleSeeded = true;
    knownAudibleTabIds = audibleNow;
    return retained;
  };

  const refresh = createCoalescedAsyncRunner(async () => {
    let changed = prune();
    if (!canControl()) {
      if (Object.keys(states).length > 0) {
        states = {};
        changed = true;
      }
      if (unreachableTabIds.size > 0) {
        unreachableTabIds.clear();
        changed = true;
      }
      if (changed) await dependencies.reconcile();
      return;
    }
    const snapshot = dependencies.store.get(hyperModelAtom);
    for (const tab of snapshot.browser.tabs) {
      if (!canInspectTabMedia(tab) || tab.id === undefined) continue;
      const force = forcedInspectionTabIds.has(tab.id);
      if (!force && !tab.audible) continue;
      changed = await inspectCurrentTab(tab, force) || changed;
    }
    changed = await enforceExclusivePlayback() || changed;
    // A retained tab that stays silent past the grace window without a paused
    // target is released, so playback that ends without a matching tab event
    // still frees the Now Playing slot instead of pinning it indefinitely.
    const now = Date.now();
    let awaitingGrace = false;
    for (const tabId of Object.values(retainedTabIds)) {
      const tab = snapshot.browser.tabs.find((candidate) => candidate.id === tabId);
      if (tab && !tab.audible && states[tabId]?.state !== 'paused') {
        const since = silentRetainedSince.get(tabId);
        if (since === undefined) {
          silentRetainedSince.set(tabId, now);
          awaitingGrace = true;
        } else if (now - since >= SILENT_RETENTION_GRACE_MS) {
          silentRetainedSince.delete(tabId);
          changed = releaseRetained(tabId) || changed;
          changed = deleteState(tabId) || changed;
        } else {
          awaitingGrace = true;
        }
      } else {
        clearSilentRetention(tabId);
      }
    }
    if (awaitingGrace && graceReleaseTimer === undefined) {
      graceReleaseTimer = setTimeout(() => {
        graceReleaseTimer = undefined;
        void refresh().catch(() => undefined);
      }, SILENT_RETENTION_GRACE_MS + 30);
    } else if (!awaitingGrace) {
      cancelGraceReleaseIfIdle();
    }
    if (changed) await dependencies.reconcile();
  });

  const refreshAfterReconciliation = async () => {
    await dependencies.reconcile();
    await refresh();
  };

  const updatePlayback = async (
    payload: { state: MediaPlaybackState; tabId: number },
    client: HyperModelPortClient,
  ) => dependencies.queueMutation(async () => {
    const tab = tabFor(payload.tabId);
    const target = states[payload.tabId];
    if (!tab || tab.windowId !== client.windowId || !target || !stateMatches(target, tab)) {
      throw new Error('This media target is no longer available.');
    }
    const expectedNavigationVersion = navigationVersion(payload.tabId);
    const expectedLifecycleVersion = lifecycleVersion(payload.tabId);
    const nextTarget = await setPlayback(target, payload.state);
    if (!nextTarget) throw new Error('Playback could not be changed.');
    if (
      lifecycleVersion(payload.tabId) !== expectedLifecycleVersion ||
      navigationVersion(payload.tabId) !== expectedNavigationVersion
    ) throw new Error('This media target has changed.');
    const currentTab = tabFor(payload.tabId);
    const url = currentTab && tabMediaUrl(currentTab);
    if (!currentTab || !url) throw new Error('This media target is no longer available.');
    states = {
      ...states,
      [payload.tabId]: {
        ...nextTarget,
        navigationVersion: expectedNavigationVersion,
        url,
      },
    };
    retain(currentTab.windowId, payload.tabId);
    await dependencies.reconcile();
  });

  dependencies.store.sub(hyperModelAtom, () => {
    void refresh().catch((error) => {
      console.error('Unable to refresh media controls.', error);
    });
  });

  return {
    async handlePermissionsChanged() {
      // A grant can let Hyper script a page it could not reach, and a removal can
      // take away the access a player was found through.
      if (unreachableTabIds.size === 0 && Object.keys(states).length === 0) return;
      await whenScriptingReady();
      for (const tabId of [...unreachableTabIds, ...Object.keys(states).map(Number)]) {
        forcedInspectionTabIds.add(tabId);
      }
      await refresh();
    },
    async handlePlaybackChanged(tabId) {
      const expectedLifecycleVersion = lifecycleVersion(tabId);
      await dependencies.reconcile();
      if (lifecycleVersion(tabId) !== expectedLifecycleVersion) return;
      const tab = tabFor(tabId);
      if (!tab || tab.incognito) {
        forcedInspectionTabIds.delete(tabId);
        knownAudibleTabIds.delete(tabId);
        clearSilentRetention(tabId);
        return;
      }
      forcedInspectionTabIds.add(tabId);
      await refresh();
    },
    async handleTabUpdated(tabId, changeInfo, tab) {
      const navigationChanged = changeInfo.status === 'loading' || changeInfo.url !== undefined;
      if (navigationChanged) this.markNavigation(tabId);
      if (tab.incognito) {
        this.removeTab(tabId);
        if (navigationChanged || changeInfo.audible !== undefined) {
          await dependencies.reconcile();
        }
        return;
      }
      if (changeInfo.audible === true) {
        forcedInspectionTabIds.add(tabId);
      } else if (changeInfo.audible === false && states[tabId]) {
        forcedInspectionTabIds.add(tabId);
      }
      if (navigationChanged || changeInfo.audible !== undefined) {
        await refreshAfterReconciliation();
      }
    },
    handlers: {
      setTabMediaPlayback: intentHandler({
        parse: parseSetTabMediaPlaybackPayload,
        run: updatePlayback,
        targets: (payload, client) => [tabTarget(payload.tabId), windowTarget(client.windowId)],
      }),
    },
    markNavigation(tabId) {
      navigationVersions.set(tabId, navigationVersion(tabId) + 1);
      lifecycleVersions.set(tabId, lifecycleVersion(tabId) + 1);
      deleteState(tabId);
      unreachableTabIds.delete(tabId);
      knownAudibleTabIds.delete(tabId);
      clearSilentRetention(tabId);
      attemptedVersions.delete(tabId);
      forcedInspectionTabIds.delete(tabId);
    },
    async reinspect(tabId) {
      forcedInspectionTabIds.add(tabId);
      await refresh();
      const target = states[tabId];
      return target ? { reachable: true, target } : { reachable: !unreachableTabIds.has(tabId) };
    },
    removeTab(tabId) {
      lifecycleVersions.set(tabId, lifecycleVersion(tabId) + 1);
      navigationVersions.delete(tabId);
      deleteState(tabId);
      unreachableTabIds.delete(tabId);
      releaseRetained(tabId);
      knownAudibleTabIds.delete(tabId);
      clearSilentRetention(tabId);
      attemptedVersions.delete(tabId);
      forcedInspectionTabIds.delete(tabId);
    },
    runtimeSignals: () => ({
      mediaControlAvailable: canControl(),
      mediaNavigationVersions: navigationVersionRecord(),
      mediaRetainedTabIds: retainedTabIds,
      mediaStates: states,
      mediaUnreachableTabIds: [...unreachableTabIds],
    }),
  };
}