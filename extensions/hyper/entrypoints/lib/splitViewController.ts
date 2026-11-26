import { sessionStorageArea } from './sessionValues';
import { bookmarkById } from './bookmarkStorage';
import { createCoalescedAsyncRunner } from './async';
import {
  findHyperBookmarkStructure,
  isSpaceTabsFolder,
  isSplitViewFolder,
  isTabFolder,
  type BookmarkNode,
  type BrowserTab,
} from './bookmarks';
import { hyperModelAtom, type HyperModelSnapshot, type HyperModelStore } from './model';
import type { HyperActionKind } from './modelActions';
import { intentHandler, type HyperIntentHandlers } from './modelIntents';
import { parseSplitTabPayload } from './modelIntentPayloads';
import { bookmarkTarget, spaceTarget, tabTarget, windowTarget } from './modelGuards';
import { pendingTargets } from './spaceWindowMaintenance';
import { tabById, tabSplitViewId } from './tabs';
import type { TabOwnership } from './tabOwnership';

type SplitViewIntentKind = Extract<HyperActionKind, 'splitTab'>;

const NO_TAB_GROUP = -1;
/** Tabs seen side by side this browser session, kept while the background sleeps. */
const SEEN_SPLIT_TABS_KEY = 'hyperSplitViewTabIds';

/** Chrome 155 added these; earlier browsers can show a split but not make one. */
interface SplitViewTabsApi {
  createSplit(tabIds: [number, number]): Promise<number>;
  unsplit(splitViewId: number): Promise<void>;
}

function splitViewTabsApi(): SplitViewTabsApi | undefined {
  const tabs = browser.tabs as typeof browser.tabs & Partial<SplitViewTabsApi>;
  return typeof tabs.createSplit === 'function' && typeof tabs.unsplit === 'function'
    ? tabs as unknown as SplitViewTabsApi
    : undefined;
}

interface StoredSplit {
  folderId: string;
  spaceId: string;
}

export interface SplitViewPlan {
  /** Split view folders whose tabs were taken apart, or are too few to split. */
  dissolve: StoredSplit[];
  /** Stored pairs open apart in one window and never split this session, as after a restore. */
  resplit: Array<StoredSplit & { tabIds: [number, number] }>;
  /** Splits made in the browser, not yet stored together. */
  store: Array<{ backingIds: string[]; spaceId: string; tabIds: number[] }>;
}

function splitViewFolders(tree: BookmarkNode[]): Array<StoredSplit & { folder: BookmarkNode }> {
  const found: Array<StoredSplit & { folder: BookmarkNode }> = [];
  const visit = (nodes: readonly BookmarkNode[], spaceId: string) => {
    for (const node of nodes) {
      if (!isTabFolder(node)) continue;
      if (isSplitViewFolder(node)) found.push({ folder: node, folderId: node.id, spaceId });
      visit(node.children ?? [], spaceId);
    }
  };
  for (const space of findHyperBookmarkStructure(tree)?.spaces.children ?? []) {
    const tabs = space.children?.find((node) => isSpaceTabsFolder(node));
    if (tabs) visit(tabs.children ?? [], space.id);
  }
  return found;
}

/**
 * What keeps stored splits and the browser's in step. A split made in the
 * browser is stored. A stored pair open apart in one window is split again,
 * unless either tab was seen split this session: then it was taken apart, and
 * its folder goes. A split waits while any of its tabs is closed, so closing a
 * window keeps it, and anything a running command is changing is left to it.
 */
export function planSplitViews(
  snapshot: HyperModelSnapshot,
  seenSplitTabIds: ReadonlySet<number>,
): SplitViewPlan {
  const plan: SplitViewPlan = { dissolve: [], resplit: [], store: [] };
  const capacity = snapshot.runtime.commandCapabilities.splitViewTabs;
  if (capacity < 2) return plan;
  const busy = pendingTargets(snapshot);
  const ownerships = snapshot.runtime.tabOwnerships;
  const tabsById = new Map(snapshot.browser.tabs.flatMap((tab) =>
    tab.id === undefined ? [] : [[tab.id, tab] as const]));
  const tabIdByBackingId = new Map(Object.entries(ownerships).flatMap(([tabId, ownership]) =>
    ownership.backingId && tabsById.has(Number(tabId))
      ? [[ownership.backingId, Number(tabId)] as const]
      : []));
  const splitFolderIdByBackingId = new Map<string, string>();
  for (const { folder, folderId, spaceId } of splitViewFolders(snapshot.browser.bookmarkTree)) {
    const children = folder.children ?? [];
    for (const child of children) splitFolderIdByBackingId.set(child.id, folderId);
    // One holding a folder or more tabs than a split can show is left as a folder.
    if (
      children.some((child) => !child.url) ||
      children.length > capacity ||
      busy.has(spaceTarget(spaceId)) ||
      [folder, ...children].some((node) => busy.has(bookmarkTarget(node.id)))
    ) continue;
    if (children.length < 2) {
      plan.dissolve.push({ folderId, spaceId });
      continue;
    }
    const tabs = children.map((child) => tabsById.get(tabIdByBackingId.get(child.id) ?? -1));
    if (!tabs.every((tab): tab is BrowserTab => tab?.id !== undefined)) continue;
    if (tabs.some((tab) => busy.has(tabTarget(tab.id!)))) continue;
    const [first] = tabs as [BrowserTab, ...BrowserTab[]];
    const splitViewId = tabSplitViewId(first);
    const together = tabs.every((tab) => tab.windowId === first.windowId);
    if (together && splitViewId !== undefined &&
      tabs.every((tab) => tabSplitViewId(tab) === splitViewId)) continue;
    const apart = together && tabs.every((tab) => tabSplitViewId(tab) === undefined);
    if (apart && !tabs.some((tab) => seenSplitTabIds.has(tab.id!))) {
      if (tabs.length === 2) {
        plan.resplit.push({ folderId, spaceId, tabIds: [first.id!, tabs[1]!.id!] });
      }
      continue;
    }
    plan.dissolve.push({ folderId, spaceId });
  }

  const splits = new Map<string, BrowserTab[]>();
  for (const tab of snapshot.browser.tabs) {
    const splitViewId = tabSplitViewId(tab);
    if (splitViewId === undefined || tab.id === undefined) continue;
    const key = `${tab.windowId}:${splitViewId}`;
    splits.set(key, [...(splits.get(key) ?? []), tab]);
  }
  for (const members of splits.values()) {
    const tabs = [...members].sort((left, right) => left.index - right.index);
    const owned = tabs.map((tab) => ownerships[tab.id!]);
    const spaceId = owned[0]?.spaceId;
    const backingIds = owned.flatMap((ownership) =>
      ownership?.backingId ? [ownership.backingId] : []);
    const folderId = splitFolderIdByBackingId.get(backingIds[0] ?? '');
    if (
      tabs.length < 2 ||
      tabs.length > capacity ||
      !spaceId ||
      backingIds.length !== tabs.length ||
      owned.some((ownership) => ownership?.spaceId !== spaceId) ||
      busy.has(spaceTarget(spaceId)) ||
      tabs.some((tab) => busy.has(tabTarget(tab.id!))) ||
      backingIds.some((backingId) => busy.has(bookmarkTarget(backingId))) ||
      folderId !== undefined &&
        backingIds.every((backingId) => splitFolderIdByBackingId.get(backingId) === folderId)
    ) continue;
    plan.store.push({ backingIds, spaceId, tabIds: tabs.map((tab) => tab.id!) });
  }
  return plan;
}

export interface SplitViewControllerDependencies {
  /** Resolves once restored windows have their tabs back, so no split is judged half open. */
  browserSettled(): Promise<void>;
  dissolveSplitViewFolder(spaceId: string, folderId: string): Promise<void>;
  gatherSplitViewFolder(spaceId: string, backingIds: readonly string[]): Promise<unknown>;
  getTabOwnership(tabId: number): Promise<TabOwnership | undefined>;
  /** Opens a page in a new tab of a space, split beside a tab when `splitWith` names one. */
  openTabInSpace(options: {
    active: boolean;
    destinationSpaceId?: string;
    forceNew: boolean;
    reuse: 'window';
    splitWith: Browser.tabs.Tab;
    url: string;
    windowId: number;
  }): Promise<{ tab: Browser.tabs.Tab }>;
  queueMutation<Result>(operation: () => Promise<Result>): Promise<Result>;
  store: HyperModelStore;
}

export interface SplitViewController {
  handlers: Pick<HyperIntentHandlers, SplitViewIntentKind>;
  /** Unsplits each split a move takes some, but not all, of its tabs from. */
  releaseDeparting(tabIds: Iterable<number>): Promise<void>;
  /** The same, for a move of tab tree nodes, which names tabs by their backings. */
  releaseDepartingBackings(backingIds: Iterable<string>): Promise<void>;
  /** Starts keeping stored splits and the browser's in step. */
  start(): void;
}

export function createSplitViewController(
  dependencies: SplitViewControllerDependencies,
): SplitViewController {
  const liveTab = (tabId: number | undefined) => tabId === undefined
    ? Promise.resolve(undefined)
    : tabById(tabId);

  const tabIdByBackingId = () => new Map(Object.entries(
    dependencies.store.get(hyperModelAtom).runtime.tabOwnerships,
  ).flatMap(([tabId, ownership]) =>
    ownership.backingId ? [[ownership.backingId, Number(tabId)] as const] : []));

  const sideBySide = async (tabIds: readonly (number | undefined)[]) => {
    const tabs = await Promise.all(tabIds.map(liveTab));
    const [first] = tabs;
    const splitViewId = first && tabSplitViewId(first);
    return splitViewId !== undefined && tabs.every((tab) =>
      tab?.windowId === first?.windowId && tab !== undefined && tabSplitViewId(tab) === splitViewId);
  };

  const storedTogether = async (backingIds: readonly string[]) => {
    const backings = await Promise.all(backingIds.map(bookmarkById));
    const parentId = backings[0]?.parentId;
    if (!parentId || backings.some((backing) => backing?.parentId !== parentId)) return false;
    const parent = await bookmarkById(parentId);
    return Boolean(parent && isSplitViewFolder(parent));
  };

  const storePair = async (leftTabId: number, rightTabId: number) => {
    const [left, right] = await Promise.all([
      dependencies.getTabOwnership(leftTabId),
      dependencies.getTabOwnership(rightTabId),
    ]);
    if (!left?.backingId || !right?.backingId || left.spaceId !== right.spaceId) return;
    await dependencies.gatherSplitViewFolder(left.spaceId, [left.backingId, right.backingId]);
  };

  // A split needs its tabs adjacent in the tab strip and in one group.
  const placeTabAfter = async (tabId: number, besideTabId: number) => {
    const [beside, tab] = await Promise.all([
      browser.tabs.get(besideTabId),
      browser.tabs.get(tabId),
    ]);
    if (tab.index !== beside.index + 1) {
      // A tab moving rightwards past `beside` shifts it left by one.
      await browser.tabs.move(tabId, {
        index: tab.index < beside.index ? beside.index : beside.index + 1,
      });
    }
    const [latestBeside, latest] = await Promise.all([
      browser.tabs.get(besideTabId),
      browser.tabs.get(tabId),
    ]);
    if (latest.groupId === latestBeside.groupId) return;
    if (latestBeside.groupId === NO_TAB_GROUP) await browser.tabs.ungroup(tabId);
    else await browser.tabs.group({ groupId: latestBeside.groupId, tabIds: tabId });
  };

  const releaseDeparting = async (tabIds: Iterable<number>) => {
    const api = splitViewTabsApi();
    if (!api) return;
    const moving = new Set(tabIds);
    const splitViewIds = new Set<number>();
    for (const tabId of moving) {
      const tab = await tabById(tabId);
      const splitViewId = tab && tabSplitViewId(tab);
      if (splitViewId !== undefined) splitViewIds.add(splitViewId);
    }
    for (const splitViewId of splitViewIds) {
      const members = await browser.tabs.query({ splitViewId });
      if (members.some((member) => member.id === undefined || !moving.has(member.id))) {
        await api.unsplit(splitViewId);
      }
    }
  };

  // Each step checks the browser again, as the model may not have caught up with the last.
  const storeSplit = async ({ backingIds, spaceId, tabIds }: SplitViewPlan['store'][number]) => {
    if (!(await sideBySide(tabIds)) || await storedTogether(backingIds)) return;
    await dependencies.gatherSplitViewFolder(spaceId, backingIds);
  };

  const dissolve = async ({ folderId, spaceId }: StoredSplit) => {
    const children = await browser.bookmarks.getChildren(folderId).catch(() => undefined);
    if (!children) return;
    const tabIds = tabIdByBackingId();
    if (children.length > 1 && await sideBySide(children.map((child) => tabIds.get(child.id)))) {
      return;
    }
    await dependencies.dissolveSplitViewFolder(spaceId, folderId);
  };

  const resplit = async ({ folderId, spaceId, tabIds: [leftId, rightId] }: SplitViewPlan['resplit'][number]) => {
    const api = splitViewTabsApi();
    const [left, right, children] = await Promise.all([
      liveTab(leftId),
      liveTab(rightId),
      browser.bookmarks.getChildren(folderId).catch(() => []),
    ]);
    if (
      !api ||
      !left ||
      !right ||
      children.length !== 2 ||
      left.windowId !== right.windowId ||
      tabSplitViewId(left) !== undefined ||
      tabSplitViewId(right) !== undefined
    ) return;
    try {
      await placeTabAfter(rightId, leftId);
      await api.createSplit([leftId, rightId]);
    } catch {
      // A pair the browser will not show side by side is no longer kept as one.
      await dependencies.dissolveSplitViewFolder(spaceId, folderId);
    }
  };

  let seenSplitTabIds: Set<number> | undefined;
  let started = false;
  const failedStores = new Set<string>();
  const storeKey = (item: SplitViewPlan['store'][number]) => item.tabIds.join(',');

  const noteSeenSplits = (seen: Set<number>, tabs: readonly BrowserTab[]) => {
    const open = new Set(tabs.flatMap((tab) => tab.id === undefined ? [] : [tab.id]));
    const before = seen.size;
    let added = false;
    for (const tab of tabs) {
      if (tab.id === undefined || tabSplitViewId(tab) === undefined || seen.has(tab.id)) continue;
      seen.add(tab.id);
      added = true;
    }
    for (const tabId of seen) if (!open.has(tabId)) seen.delete(tabId);
    if (added || seen.size !== before) {
      void sessionStorageArea()?.set({ [SEEN_SPLIT_TABS_KEY]: [...seen] }).catch(() => undefined);
    }
  };

  const currentPlan = (): SplitViewPlan | undefined => {
    if (!started || !seenSplitTabIds) return undefined;
    const snapshot = dependencies.store.get(hyperModelAtom);
    noteSeenSplits(seenSplitTabIds, snapshot.browser.tabs);
    const plan = planSplitViews(snapshot, seenSplitTabIds);
    return { ...plan, store: plan.store.filter((item) => !failedStores.has(storeKey(item))) };
  };

  const maintain = createCoalescedAsyncRunner(async () => {
    await dependencies.browserSettled();
    await dependencies.queueMutation(async () => {
      const plan = currentPlan();
      if (!plan) return;
      for (const item of plan.dissolve) await dissolve(item).catch(() => undefined);
      for (const item of plan.store) {
        await storeSplit(item).catch(() => failedStores.add(storeKey(item)));
      }
      for (const item of plan.resplit) await resplit(item).catch(() => undefined);
    });
  });

  const evaluate = () => {
    const plan = currentPlan();
    if (plan && plan.dissolve.length + plan.resplit.length + plan.store.length > 0) {
      void maintain().catch(() => undefined);
    }
  };
  dependencies.store.sub(hyperModelAtom, evaluate);

  return {
    handlers: {
      splitTab: intentHandler({
        parse: parseSplitTabPayload,
        run: (payload, client) => dependencies.queueMutation(async () => {
          const api = splitViewTabsApi();
          if (!api) throw new Error('This browser cannot show tabs side by side.');
          const target = await browser.tabs.get(payload.tabId);
          if (target.id === undefined || target.windowId !== client.windowId || target.incognito) {
            throw new Error('That tab is not in this window.');
          }
          // Chrome splits only two tabs, so a tab already split has no room.
          if (tabSplitViewId(target) !== undefined) throw new Error('That tab is already split.');
          if ('url' in payload) {
            const ownership = await dependencies.getTabOwnership(target.id);
            const { tab: opened } = await dependencies.openTabInSpace({
              active: false,
              destinationSpaceId: ownership?.spaceId,
              forceNew: true,
              reuse: 'window',
              splitWith: target,
              url: payload.url,
              windowId: target.windowId,
            });
            if (opened.id !== undefined) await storePair(target.id, opened.id);
            return;
          }
          if (payload.withTabId === target.id) throw new Error('A tab cannot be split beside itself.');
          const source = await browser.tabs.get(payload.withTabId);
          if (source.windowId !== target.windowId || source.pinned !== target.pinned) {
            throw new Error('Only tabs side by side in one window can be split.');
          }
          const sourceSplitViewId = tabSplitViewId(source);
          if (sourceSplitViewId !== undefined) await api.unsplit(sourceSplitViewId);
          await placeTabAfter(payload.withTabId, target.id);
          await api.createSplit([target.id, payload.withTabId]);
          await storePair(target.id, payload.withTabId);
        }),
        targets: (payload, client) => [
          tabTarget(payload.tabId),
          ...('withTabId' in payload ? [tabTarget(payload.withTabId)] : []),
          windowTarget(client.windowId),
        ],
      }),
    },
    releaseDeparting,
    releaseDepartingBackings: (backingIds) => {
      const departing = new Set(backingIds);
      return releaseDeparting([...tabIdByBackingId()].flatMap(([backingId, tabId]) =>
        departing.has(backingId) ? [tabId] : []));
    },
    start: () => {
      void (sessionStorageArea()?.get(SEEN_SPLIT_TABS_KEY) ?? Promise.resolve({}))
        .catch(() => ({}))
        .then((stored: Record<string, unknown>) => {
          const ids = stored[SEEN_SPLIT_TABS_KEY];
          seenSplitTabIds = new Set(Array.isArray(ids) ? ids.filter(Number.isInteger) : []);
          started = true;
          evaluate();
        });
    },
  };
}
