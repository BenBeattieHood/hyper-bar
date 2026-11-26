import { createCoalescedAsyncRunner } from './async';
import { settleAutoTabFolderIdentities, type AutoTabFolderIdentity } from './autoTabFolders';
import type { BrowserTab } from './bookmarks';
import { hyperModelAtom, type HyperModelSnapshot, type HyperModelStore } from './model';
import { spaceTarget, tabTarget, windowTarget, type TargetLedger } from './modelGuards';
import { pendingTargets } from './spaceWindowMaintenance';
import { loadTabOwnerships } from './tabOwnership';
import { tabById } from './tabs';
import { nextTabStripMove, planTabStripAdoption, spaceTabListOrder } from './tabStripOrder';

const NO_TAB_GROUP = -1;
const LEDGER_COMMAND = 'tab-strip-order';
/** How long a declared move may wait for its event before it stops claiming the tab's moves. */
const EXPECTED_MOVE_MS = 2000;
/** How long to wait before trying again while the browser refuses tab edits, as during a drag. */
const BLOCKED_RETRY_MS = 500;

export interface TabStripOrderControllerDependencies {
  /** Resolves once restored windows have their tabs back, so no window is ordered half open. */
  browserSettled(): Promise<void>;
  moveTabTreeNode(
    spaceId: string,
    nodeId: string,
    destination: { parentId: string; index: number },
  ): Promise<unknown>;
  queueMutation<Result>(operation: () => Promise<Result>): Promise<Result>;
  store: HyperModelStore;
  /** Where Hyper declares its own tab moves, so only other moves are taken into the list. */
  targetLedger: TargetLedger;
}

export interface TabStripOrderController {
  /** Takes the tab strip's order of these tabs into the list. Unqueued, for a running mutation. */
  adoptPositions(tabIds: Iterable<number>): Promise<void>;
  /** The order a space's tabs in a window take in the tab strip: its Tabs list's, or none while syncing is off. */
  stripOrder(spaceId: string, windowId: number): Promise<number[]>;
  /** A tab something other than Hyper moved, as the user dragging it in the tab strip. */
  tabMoved(tabId: number): void;
  /** Starts keeping each window's tab strip in the order of its spaces' Tabs lists. */
  start(): void;
}

interface SpaceStrip {
  spaceId: string;
  windowId: number;
}

function spaceStrips(snapshot: HyperModelSnapshot): SpaceStrip[] {
  const ownerships = snapshot.runtime.tabOwnerships;
  const keys = new Set(snapshot.browser.tabs.flatMap((tab) => {
    const spaceId = tab.id === undefined ? undefined : ownerships[tab.id]?.spaceId;
    return spaceId && !tab.incognito ? [JSON.stringify([tab.windowId, spaceId])] : [];
  }));
  return [...keys].map((key) => {
    const [windowId, spaceId] = JSON.parse(key) as [number, string];
    return { spaceId, windowId };
  });
}

const syncing = (snapshot: HyperModelSnapshot) => snapshot.runtime.preferences.syncTabStripOrder;

/**
 * Keeps the browser's tab strip in the order of the Tabs list, which is the
 * model's: a list change moves tabs in the strip, and a tab moved in the strip
 * is first taken into the list, so the strip never overrules the model.
 * With `syncTabStripOrder` off, neither follows the other; turning it back on
 * puts the strip in the list's order.
 */
export function createTabStripOrderController(
  dependencies: TabStripOrderControllerDependencies,
): TabStripOrderController {
  const { store } = dependencies;
  let started = false;
  let identities = new Map<number, AutoTabFolderIdentity>();
  const movedTabIds = new Set<number>();
  /** Orders the browser would not take, kept so a refusal is not retried on every change. */
  const stalled = new Set<string>();
  let blockedRetry: ReturnType<typeof setTimeout> | undefined;
  let expectedMoves: ReturnType<typeof setTimeout> | undefined;

  const desiredOrder = (
    snapshot: HyperModelSnapshot,
    { spaceId, windowId }: SpaceStrip,
    tabs: readonly BrowserTab[] = snapshot.browser.tabs,
    ownerships = snapshot.runtime.tabOwnerships,
    bookmarkTree = snapshot.browser.bookmarkTree,
  ) => spaceTabListOrder({
    autofolders: snapshot.runtime.preferences.autofolders,
    bookmarkTree,
    identities,
    ownerships,
    spaceId,
    tabs,
    windowId,
  });

  const isBusy = (snapshot: HyperModelSnapshot, strip: SpaceStrip, order: readonly number[]) => {
    const busy = pendingTargets(snapshot);
    return busy.has(spaceTarget(strip.spaceId)) || busy.has(windowTarget(strip.windowId)) ||
      order.some((tabId) => busy.has(tabTarget(tabId)));
  };

  const stallKey = ({ spaceId, windowId }: SpaceStrip, order: readonly number[]) =>
    `${windowId}:${spaceId}:${order.join(',')}`;

  const outOfOrder = (snapshot: HyperModelSnapshot) => spaceStrips(snapshot).some((strip) => {
    const order = desiredOrder(snapshot, strip);
    const windowTabs = snapshot.browser.tabs.filter((tab) => tab.windowId === strip.windowId);
    return !stalled.has(stallKey(strip, order)) && !isBusy(snapshot, strip, order) &&
      nextTabStripMove(windowTabs, order) !== undefined;
  });

  const retryWhenUnblocked = () => {
    if (blockedRetry !== undefined) return;
    blockedRetry = setTimeout(() => {
      blockedRetry = undefined;
      evaluate();
    }, BLOCKED_RETRY_MS);
  };

  /** Moves a tab, keeping it in the tab group it was in, as a move to a group's edge can take it out. */
  const moveTab = async (tabId: number, index: number, groupId: number) => {
    dependencies.targetLedger.expect(LEDGER_COMMAND, tabTarget(tabId), 'moved');
    clearTimeout(expectedMoves);
    // A move the browser reports no event for must not hide a later move by the user.
    expectedMoves = setTimeout(() => dependencies.targetLedger.forget(LEDGER_COMMAND), EXPECTED_MOVE_MS);
    const [moved] = [await browser.tabs.move(tabId, { index })].flat();
    if (!moved || moved.groupId === groupId) return;
    if (groupId === NO_TAB_GROUP) await browser.tabs.ungroup(tabId);
    else await browser.tabs.group({ groupId, tabIds: tabId });
  };

  const orderStrip = async (strip: SpaceStrip) => {
    const snapshot = store.get(hyperModelAtom);
    let windowTabs = await browser.tabs.query({ windowId: strip.windowId });
    // Read from the bookmarks themselves, as the snapshot can trail a move just made in the list.
    const order = desiredOrder(
      snapshot,
      strip,
      windowTabs,
      await loadTabOwnerships(windowTabs),
      await browser.bookmarks.getTree(),
    );
    if (stalled.has(stallKey(strip, order)) || isBusy(snapshot, strip, order)) return;
    // Each move takes one tab out of place; twice that bound means the browser keeps refusing.
    for (let remaining = order.length * 2; remaining > 0; remaining -= 1) {
      const move = nextTabStripMove(windowTabs, order);
      if (!move) return;
      const tab = windowTabs.find((candidate) => candidate.id === move.tabId);
      try {
        await moveTab(move.tabId, move.index, tab?.groupId ?? NO_TAB_GROUP);
      } catch (error) {
        if (String(error).includes('cannot be edited right now')) retryWhenUnblocked();
        return;
      }
      windowTabs = await browser.tabs.query({ windowId: strip.windowId });
    }
    stalled.add(stallKey(strip, order));
  };

  const maintain = createCoalescedAsyncRunner(async () => {
    await dependencies.browserSettled();
    await dependencies.queueMutation(async () => {
      // A tab moved in the strip is taken into the list before the list orders the strip.
      if (!started || movedTabIds.size > 0 || !syncing(store.get(hyperModelAtom))) return;
      for (const strip of spaceStrips(store.get(hyperModelAtom))) {
        await orderStrip(strip).catch(() => undefined);
      }
    });
  });

  function evaluate() {
    if (!started) return;
    const snapshot = store.get(hyperModelAtom);
    identities = snapshot.runtime.preferences.autofolders
      ? settleAutoTabFolderIdentities(snapshot.browser.tabs, identities)
      : new Map();
    if (syncing(snapshot) && movedTabIds.size === 0 && outOfOrder(snapshot)) void maintain().catch(() => undefined);
  }
  store.sub(hyperModelAtom, evaluate);

  const adoptPositions = async (tabIds: Iterable<number>) => {
    const moving = await Promise.all([...new Set(tabIds)].map((tabId) =>
      tabById(tabId)));
    const unplaced = new Set(moving.flatMap((tab) => tab?.id === undefined ? [] : [tab.id]));
    // Placed in strip order, each beside the last, so tabs moved together stay together.
    for (const tab of moving.filter((candidate) => candidate !== undefined).sort((left, right) =>
      left.windowId - right.windowId || left.index - right.index)) {
      unplaced.delete(tab.id!);
      const windowTabs = await browser.tabs.query({ windowId: tab.windowId });
      const ownerships = await loadTabOwnerships(windowTabs);
      const spaceId = ownerships[tab.id!]?.spaceId;
      if (!spaceId) continue;
      const bookmarkTree = await browser.bookmarks.getTree();
      const snapshot = store.get(hyperModelAtom);
      const order = desiredOrder(
        snapshot,
        { spaceId, windowId: tab.windowId },
        windowTabs,
        ownerships,
        bookmarkTree,
      );
      const adoption = planTabStripAdoption(
        tab.id!,
        windowTabs,
        ownerships,
        order,
        bookmarkTree,
        unplaced,
      );
      if (!adoption) continue;
      await dependencies.moveTabTreeNode(spaceId, adoption.nodeId, adoption.destination)
        .catch(() => undefined);
    }
  };

  const adoptMoved = createCoalescedAsyncRunner(() => dependencies.queueMutation(async () => {
    const tabIds = [...movedTabIds];
    movedTabIds.clear();
    if (syncing(store.get(hyperModelAtom))) await adoptPositions(tabIds);
  }));

  return {
    adoptPositions,
    stripOrder: async (spaceId, windowId) => {
      if (!syncing(store.get(hyperModelAtom))) return [];
      const windowTabs = await browser.tabs.query({ windowId });
      return desiredOrder(
        store.get(hyperModelAtom),
        { spaceId, windowId },
        windowTabs,
        await loadTabOwnerships(windowTabs),
        await browser.bookmarks.getTree(),
      );
    },
    tabMoved: (tabId) => {
      if (!started || !syncing(store.get(hyperModelAtom))) return;
      movedTabIds.add(tabId);
      void adoptMoved().catch(() => undefined).then(evaluate);
    },
    start: () => {
      started = true;
      evaluate();
    },
  };
}
