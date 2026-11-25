import { concurrentFailures } from './async';
import type { BookmarkNode, BrowserTab, Space } from './bookmarks';
import { type EffectFence, tabTarget } from './modelGuards';
import { ownershipNamesAnotherWindow } from './tabDisposition';
import type { TabOwnership } from './tabOwnership';
import { normaliseUrl, tabUrl } from './urlIdentity';

/** The tab with this ID, or undefined once it has closed. */
export function tabById(tabId: number): Promise<Browser.tabs.Tab | undefined> {
  return browser.tabs.get(tabId).catch(() => undefined);
}

export interface TabBrowsingContext {
  incognito: boolean;
  windowId: number;
}

interface SpaceRestoreCandidateOptions {
  claimUnowned: boolean;
  groupId?: number;
  spaceId: string;
  windowId: number;
}

interface TabRestorationWaitOptions {
  now?: () => number;
  pollIntervalMs?: number;
  shouldContinue?: () => boolean;
  /** Read on every poll; the wait ends once nothing is left to come back in the group. */
  stillAwaited?: () => Promise<boolean>;
  timeoutMs?: number;
  wait?: (durationMs: number) => Promise<void>;
}

/** A polling wait's options with their defaults filled in. */
function pollingWait(options: TabRestorationWaitOptions, defaultTimeoutMs: number) {
  return {
    now: options.now ?? (() => Date.now()),
    pollIntervalMs: options.pollIntervalMs ?? 50,
    shouldContinue: options.shouldContinue ?? (() => true),
    timeoutMs: options.timeoutMs ?? defaultTimeoutMs,
    wait: options.wait ?? ((durationMs: number) =>
      new Promise<void>((resolve) => globalThis.setTimeout(resolve, durationMs))),
  };
}

interface ResolveSpaceRestoreGroupOptions extends Omit<TabRestorationWaitOptions, 'stillAwaited'> {
  /**
   * Whether a backing in the window still expects the browser to bring its tab
   * back. A backing whose tab the user has just closed expects nothing, and a
   * tab can close while the wait runs, so this is read again on every poll.
   */
  awaitsRestoredTab: () => Promise<boolean>;
  recoverGroup: boolean;
}

export interface SpaceRestoreGroupResolution {
  canRestore: boolean;
  groupId?: number;
}

export function advanceTabGeneration(
  generations: Map<number, number>,
  tabId: number,
): number {
  const generation = (generations.get(tabId) ?? 0) + 1;
  generations.set(tabId, generation);
  return generation;
}

/**
 * Lifecycle bookkeeping outlives the tab or group it describes, so it would
 * otherwise grow for as long as the worker lives. Insertion order makes the
 * oldest entries the ones whose work has long since settled, and an evicted
 * entry reads as a stale generation rather than a current one.
 */
export function retainRecentEntries(
  entries: Map<number, unknown>,
  limit: number,
): void {
  if (entries.size <= limit) return;
  for (const key of entries.keys()) {
    if (entries.size <= limit) return;
    entries.delete(key);
  }
}

/** The browser's ID for a tab shown in no split view. */
export const SPLIT_VIEW_ID_NONE = -1;

/** The split view a tab is shown in beside another, if any. */
export function tabSplitViewId(tab: Pick<BrowserTab, 'splitViewId'>): number | undefined {
  const { splitViewId } = tab;
  return splitViewId === undefined || splitViewId === SPLIT_VIEW_ID_NONE
    ? undefined
    : splitViewId;
}

export function tabGenerationsAreCurrent(
  generations: ReadonlyMap<number, number>,
  expected: ReadonlyArray<readonly [tabId: number, generation: number | undefined]>,
): boolean {
  return expected.every(([tabId, generation]) => generations.get(tabId) === generation);
}

export function pendingTabOperationIsCurrent<T>(
  pendingOperations: ReadonlyMap<number, T>,
  operationId: number,
  expectedOperation: T,
  generations: ReadonlyMap<number, number>,
  expectedGenerations: ReadonlyArray<readonly [tabId: number, generation: number | undefined]>,
): boolean {
  return pendingOperations.get(operationId) === expectedOperation &&
    tabGenerationsAreCurrent(generations, expectedGenerations);
}

interface TabFocusApi {
  tabs: {
    get?: (tabId: number) => Promise<{ id?: number; windowId: number }>;
    query?: (queryInfo: { active: true }) => Promise<Array<{
      id?: number;
      windowId: number;
    }>>;
    update: (tabId: number, update: { active: true }) => Promise<unknown>;
  };
  windows: {
    update: (windowId: number, update: { focused: true }) => Promise<unknown>;
  };
}

interface TabCloseApi {
  tabs: {
    get: (tabId: number) => Promise<{ id?: number }>;
    query: (queryInfo: { windowId: number }) => Promise<Array<{ id?: number }>>;
    remove: (tabId: number) => Promise<unknown>;
  };
  windows: {
    remove: (windowId: number) => Promise<unknown>;
  };
}

interface TabMoveApi {
  tabs: {
    move: (
      tabIds: number | number[],
      moveProperties: { index: number; windowId: number },
    ) => Promise<unknown>;
    query: (queryInfo: { active: true; windowId: number }) => Promise<Array<{ id?: number }>>;
    update: (tabId: number, update: { active: true }) => Promise<unknown>;
  };
}

interface RestoredTabCleanupApi {
  create: (createProperties: { active: false; windowId: number }) => Promise<{ id?: number }>;
  query: (queryInfo: { windowId: number }) => Promise<BrowserTab[]>;
  remove: (tabIds: number[]) => Promise<unknown>;
}

export type TabReuseScope = 'browser' | 'window';

export function tabDisplayTitle(
  tab: BrowserTab,
  fallback = 'Untitled tab',
): string {
  return tab.title?.trim() || tab.pendingUrl || tab.url || fallback;
}

export function tabDisplayUrl(tab: BrowserTab): string {
  return tabUrl(tab) ?? '';
}

export type TabVisibleBookmarkState = 'none' | 'bookmarked' | 'update';

export function tabVisibleBookmarkState(
  bookmark: BookmarkNode | undefined,
  tabUrl: string | undefined,
): TabVisibleBookmarkState {
  if (!bookmark) return 'none';
  return bookmark.url && tabUrl && !sameNavigationUrl(bookmark.url, tabUrl)
    ? 'update'
    : 'bookmarked';
}

export function tabWithBackingToken(
  tabs: BrowserTab[],
  ownerships: Readonly<Record<number, TabOwnership>>,
  backingToken: string | undefined,
): BrowserTab | undefined {
  if (!backingToken) return undefined;
  return tabs.find((tab) =>
    tab.id !== undefined && ownerships[tab.id]?.backingToken === backingToken);
}

export function spaceTabActivationTarget(
  tabs: BrowserTab[],
  ownerships: Readonly<Record<number, TabOwnership>>,
  backingToken: string | undefined,
  preferActive: boolean,
): BrowserTab | undefined {
  const activeTab = tabs.find((tab) => tab.active);
  return (
    preferActive ? activeTab : undefined
  ) ?? tabWithBackingToken(
    tabs,
    ownerships,
    backingToken,
  ) ?? tabs.find((tab) => !tab.discarded) ?? tabs[0];
}

export async function focusTabInWindow(
  tabId: number,
  targetWindowId: number,
  sourceWindowId: number,
  api: TabFocusApi = browser,
  canFocusWindow?: () => Promise<boolean>,
): Promise<boolean> {
  if (canFocusWindow && !await canFocusWindow()) return false;
  const previouslyActiveTabs = canFocusWindow && api.tabs.query
    ? await api.tabs.query({ active: true })
    : [];
  await api.tabs.update(tabId, { active: true });
  if (canFocusWindow && !await canFocusWindow()) {
    const currentTarget = await api.tabs.get?.(tabId).catch(() => undefined);
    const previous = previouslyActiveTabs.find((tab) =>
      tab.id !== undefined && tab.windowId === currentTarget?.windowId && tab.id !== tabId);
    if (previous?.id !== undefined) {
      await api.tabs.update(previous.id, { active: true }).catch(() => undefined);
    }
    return false;
  }
  if (targetWindowId === sourceWindowId) return true;
  await api.windows.update(targetWindowId, { focused: true });
  return true;
}

export async function closeTabOrWindow(
  tabId: number,
  windowId: number,
  api: TabCloseApi = browser,
): Promise<void> {
  const windowTabs = await api.tabs.query({ windowId });
  if (windowTabs.length === 1 && windowTabs[0]?.id === tabId) {
    await api.windows.remove(windowId);
  } else {
    await api.tabs.remove(tabId);
  }
  const remainingTab = await api.tabs.get(tabId).catch(() => undefined);
  if (remainingTab) {
    throw new Error('The browser did not close the requested tab.');
  }
}

export async function closeTabsConcurrently(
  tabIds: readonly number[],
  closeTab: (tabId: number) => Promise<void>,
): Promise<void> {
  const failures = await concurrentFailures([...new Set(tabIds)], closeTab);
  if (failures.length > 0) throw failures[0];
}

export interface CloseOtherTabsCondition {
  keepTabId: number;
  windowId: number;
}

export function canCloseOtherTab(
  tab: Pick<BrowserTab, 'active' | 'id' | 'pinned' | 'windowId'>,
  condition: CloseOtherTabsCondition,
): boolean {
  return tab.id !== undefined &&
    tab.id !== condition.keepTabId &&
    tab.windowId === condition.windowId &&
    !tab.pinned &&
    !tab.active;
}

/** Re-reads each target directly before closing it so a stale view cannot close a newly active tab. */
export async function closeOtherTabsConditionally(
  tabIds: readonly number[],
  condition: CloseOtherTabsCondition,
  getTab: (tabId: number) => Promise<BrowserTab | undefined>,
  closeTab: (tabId: number, windowId: number) => Promise<void>,
): Promise<void> {
  for (const tabId of new Set(tabIds)) {
    const tab = await getTab(tabId).catch(() => undefined);
    if (!tab || !canCloseOtherTab(tab, condition)) continue;
    await closeTab(tab.id!, tab.windowId);
  }
}

export async function moveTabsPreservingActive(
  tabIds: number | number[],
  windowId: number,
  index: number,
  api: TabMoveApi = browser as unknown as TabMoveApi,
  shouldContinue: () => boolean = () => true,
  effects?: EffectFence,
): Promise<void> {
  const movedTabIds = new Set(Array.isArray(tabIds) ? tabIds : [tabIds]);
  const [activeTab] = await api.tabs.query({ active: true, windowId });
  if (!shouldContinue()) return;
  // The move is fenced against the tabs it reorders: external changes since
  // admission supersede the plan, while Hyper's own move event is declared.
  const move = () => api.tabs.move(tabIds, { windowId, index });
  await (effects
    ? effects.step(
        [...movedTabIds].map((id) => ({ change: 'moved' as const, target: tabTarget(id) })),
        move,
      )
    : move());
  if (activeTab?.id !== undefined && shouldContinue()) {
    const [currentActiveTab] = await api.tabs.query({ active: true, windowId });
    if (
      currentActiveTab?.id !== undefined &&
      currentActiveTab.id !== activeTab.id &&
      !movedTabIds.has(currentActiveTab.id)
    ) return;
    if (!shouldContinue()) return;
    await api.tabs.update(activeTab.id, { active: true });
  }
}

export function tabsInBrowsingContext(
  tabs: BrowserTab[],
  incognito: boolean,
): BrowserTab[] {
  return tabs.filter((tab) => tab.incognito === incognito);
}

export function recentOpenTabs(
  tabs: BrowserTab[],
  windowId: number | null,
  extensionOrigin: string,
  limit = 20,
): BrowserTab[] {
  if (windowId === null || limit <= 0) return [];
  return tabs
    .filter((tab) =>
      tab.id !== undefined &&
      !tab.active &&
      tab.windowId === windowId &&
      !tabUrl(tab)?.startsWith(extensionOrigin))
    .sort((left, right) =>
      (right.lastAccessed ?? 0) - (left.lastAccessed ?? 0) ||
      right.index - left.index)
    .slice(0, limit);
}

export function spaceRestoreCandidates(
  tabs: BrowserTab[],
  ownerships: Readonly<Record<number, { spaceId: string } | undefined>>,
  options: SpaceRestoreCandidateOptions,
): BrowserTab[] {
  return tabs.filter((tab) =>
    tab.windowId === options.windowId && (
      options.groupId !== undefined
        ? tab.groupId === options.groupId
        : tab.id !== undefined && (
            ownerships[tab.id]?.spaceId === options.spaceId ||
            (options.claimUnowned && !tab.pinned && ownerships[tab.id] === undefined)
          )
    ));
}

/** Tabs no space owns yet; pinned tabs and Hyper's own pages never join one. */
export function unroutedTabIds(
  tabs: readonly BrowserTab[],
  ownerships: Readonly<Record<number, TabOwnership>>,
  extensionOrigin: string,
): number[] {
  return tabs.flatMap((tab) =>
    tab.id === undefined ||
    tab.pinned ||
    ownerships[tab.id] !== undefined ||
    (tabUrl(tab) ?? '').startsWith(extensionOrigin)
      ? []
      : [tab.id]);
}

/**
 * Tabs the background has yet to place in this window: unrouted ones, and ones
 * that arrived from another window (a tab dragged out) whose ownership still
 * names the window they left.
 */
export function unplacedTabIds(
  tabs: readonly BrowserTab[],
  ownerships: Readonly<Record<number, TabOwnership>>,
  extensionOrigin: string,
): number[] {
  const arriving = tabs.flatMap((tab) =>
    tab.id !== undefined && ownershipNamesAnotherWindow(tab, ownerships[tab.id]) ? [tab.id] : []);
  return [...unroutedTabIds(tabs, ownerships, extensionOrigin), ...arriving];
}

export function isCurrentSpaceRestoreCandidate(
  tab: BrowserTab,
  windowId: number,
  candidateTabIds: ReadonlySet<number>,
  groupId?: number,
): boolean {
  return tab.id !== undefined &&
    tab.windowId === windowId &&
    (candidateTabIds.has(tab.id) ||
      (groupId !== undefined && tab.groupId === groupId)) &&
    !tab.pinned &&
    !tab.incognito;
}

interface StableTabSnapshotOptions extends TabRestorationWaitOptions {
    quietPeriodMs?: number;
}

function tabSnapshotKey(tabs: BrowserTab[]): string {
  return tabs
    .flatMap((tab) => tab.id === undefined ? [] : [{
      discarded: tab.discarded,
      groupId: tab.groupId,
      id: tab.id,
      url: tabUrl(tab),
    }])
    .sort((left, right) => left.id - right.id)
    .map(({ discarded, groupId, id, url }) =>
      `${id}:${groupId}:${discarded ? 'discarded' : 'live'}:${url ?? ''}`)
    .join('|');
}

export async function waitForRestoredTabGroup(
  queryTabs: () => Promise<BrowserTab[]>,
  findGroup: (tabs: BrowserTab[]) => Promise<number | undefined>,
  options: TabRestorationWaitOptions = {},
): Promise<number | undefined> {
  const { now, pollIntervalMs, shouldContinue, timeoutMs, wait } = pollingWait(options, 5_000);
  const stillAwaited = options.stillAwaited ?? (async () => true);
  const startedAt = now();

  while (shouldContinue()) {
    const groupId = await findGroup(await queryTabs());
    if (groupId !== undefined) return groupId;
    if (now() - startedAt >= timeoutMs || !await stillAwaited()) return undefined;
    await wait(pollIntervalMs);
  }
  return undefined;
}

export async function resolveSpaceRestoreGroup(
  initialTabs: BrowserTab[],
  findGroup: (tabs: BrowserTab[]) => Promise<number | undefined>,
  queryTabs: () => Promise<BrowserTab[]>,
  options: ResolveSpaceRestoreGroupOptions,
): Promise<SpaceRestoreGroupResolution> {
  const { awaitsRestoredTab, recoverGroup, ...waitOptions } = options;
  let groupId = await findGroup(initialTabs);
  if (groupId !== undefined || !recoverGroup || !await awaitsRestoredTab()) {
    return { canRestore: true, groupId };
  }
  groupId = await waitForRestoredTabGroup(queryTabs, findGroup, {
    ...waitOptions,
    stillAwaited: awaitsRestoredTab,
  });
  // A wait that ended because every awaited tab closed leaves nothing to restore.
  return {
    canRestore: groupId !== undefined || !await awaitsRestoredTab(),
    groupId,
  };
}

export async function waitForStableTabSnapshot(
  queryTabs: () => Promise<BrowserTab[]>,
  options: StableTabSnapshotOptions = {},
): Promise<BrowserTab[]> {
  const { now, pollIntervalMs, shouldContinue, timeoutMs, wait } = pollingWait(options, 1_500);
  const quietPeriodMs = options.quietPeriodMs ?? 300;
  const startedAt = now();
  let stableSince = startedAt;
  let tabs = await queryTabs();
  let snapshotKey = tabSnapshotKey(tabs);

  while (shouldContinue() && now() - startedAt < timeoutMs) {
    await wait(pollIntervalMs);
    if (!shouldContinue()) return tabs;
    const nextTabs = await queryTabs();
    const nextSnapshotKey = tabSnapshotKey(nextTabs);
    if (nextSnapshotKey !== snapshotKey) {
      snapshotKey = nextSnapshotKey;
      stableSince = now();
    }
    tabs = nextTabs;
    if (now() - stableSince >= quietPeriodMs) return tabs;
  }

  return tabs;
}

export function canSyncBookmarkTitleFromTab(tab: BrowserTab): boolean {
  return !tab.incognito;
}

export function bookmarkTitleForTab(tab: BrowserTab, url: string): string {
  return canSyncBookmarkTitleFromTab(tab) ? tab.title || url : url;
}

function bareAddress(value: string): string {
  let text = value.trim().toLocaleLowerCase();
  try {
    text = decodeURI(text);
  } catch {
    // A malformed escape compares as written.
  }
  return text.replace(/^[a-z][a-z\d+.-]*:\/\//, '').replace(/^www\./, '').replace(/\/$/, '');
}

/**
 * A title the browser makes up when the page has given none, such as while it
 * loads, sleeps or fails to load: blank, the address, or just the host.
 */
export function isPlaceholderTabTitle(title: string | undefined, url: string | undefined): boolean {
  const text = title?.trim();
  if (!text) return true;
  if (!url) return false;
  const placeholders = new Set([bareAddress(url)]);
  try {
    const parsed = new URL(url);
    placeholders.add(bareAddress(parsed.host));
    placeholders.add(bareAddress(`${parsed.host}${parsed.pathname}`));
    placeholders.add(bareAddress(`${parsed.host}${parsed.pathname}${parsed.search}`));
  } catch {
    // Not a URL: only the address itself is a placeholder.
  }
  return placeholders.has(bareAddress(text));
}

function comparablePageUrl(value: string): string {
  try {
    const url = new URL(value);
    url.search = '';
    url.hash = '';
    return url.href.replace(/\/$/, '').toLowerCase();
  } catch {
    return value.trim().replace(/[?#].*$/, '').replace(/\/$/, '').toLowerCase();
  }
}

export function sameNavigationUrl(left: string, right: string): boolean {
  try {
    return new URL(left).href === new URL(right).href;
  } catch {
    return left === right;
  }
}

export function restoredTabCleanupPlan(
  tabs: BrowserTab[],
  candidateTabIds: ReadonlySet<number>,
  hyperNewTabUrl: string,
): { createReplacement: boolean; removableTabIds: number[] } {
  const removableTabIds = tabs.flatMap((tab) =>
    tab.id !== undefined &&
      candidateTabIds.has(tab.id) &&
      !tab.incognito &&
      !tab.pinned &&
      isBlankTabPage(tabUrl(tab), hyperNewTabUrl)
      ? [tab.id]
      : []);
  const removableIds = new Set(removableTabIds);
  return {
    createReplacement: removableTabIds.length > 0 && tabs.every((tab) =>
      tab.id !== undefined && removableIds.has(tab.id)),
    removableTabIds,
  };
}

export async function cleanupRestoredTabsInWindow(
  windowId: number,
  candidateTabGenerations: ReadonlyMap<number, number | undefined>,
  hyperNewTabUrl: string,
  api: RestoredTabCleanupApi,
  currentGeneration: (tabId: number) => number | undefined,
  onReplacementCreated: (tabId: number) => void = () => undefined,
): Promise<void> {
  const currentCandidateTabIds = () => new Set(
    [...candidateTabGenerations].flatMap(([tabId, generation]) =>
      currentGeneration(tabId) === generation ? [tabId] : []),
  );
  let cleanup = restoredTabCleanupPlan(
    await api.query({ windowId }),
    currentCandidateTabIds(),
    hyperNewTabUrl,
  );
  if (cleanup.createReplacement) {
    const replacement = await api.create({ active: false, windowId });
    if (replacement.id !== undefined) onReplacementCreated(replacement.id);
    cleanup = restoredTabCleanupPlan(
      await api.query({ windowId }),
      currentCandidateTabIds(),
      hyperNewTabUrl,
    );
  }
  const removableTabIds = cleanup.removableTabIds.filter((tabId) =>
    currentGeneration(tabId) === candidateTabGenerations.get(tabId));
  if (removableTabIds.length > 0) {
    await api.remove(removableTabIds);
  }
}

export function isBlankTabPage(
  url: string | undefined,
  hyperNewTabUrl: string,
): boolean {
  if (!url) return false;
  const page = comparablePageUrl(url);
  return page === comparablePageUrl(hyperNewTabUrl) || [
    'about:blank',
    'about:newtab',
    'chrome-search://local-ntp/local-ntp.html',
    'chrome://newtab',
    'edge://newtab',
  ].includes(page);
}

/**
 * Whether a tab holds no page now, being discarded or not yet loaded since a
 * restore, so it loads its page afresh when shown. A frozen tab still holds its
 * page, which showing it does not refresh.
 */
export function isTabUnloaded(tab: Pick<BrowserTab, 'discarded' | 'status'>): boolean {
  return tab.discarded || tab.status === 'unloaded';
}

export function isHistoryNavigationCommit(
  details: {
    frameId: number;
    tabId: number;
    transitionQualifiers: readonly string[];
  },
  tabId: number,
): boolean {
  return details.tabId === tabId &&
    details.frameId === 0 &&
    details.transitionQualifiers.includes('forward_back');
}

export function findReusableTab(
  tabs: BrowserTab[],
  identity: string,
  context: TabBrowsingContext,
  scope: TabReuseScope,
): BrowserTab | undefined {
  const matches = tabsInBrowsingContext(tabs, context.incognito).filter(
    (tab) =>
      (scope === 'browser' || tab.windowId === context.windowId) &&
      normaliseUrl(tabUrl(tab)) === identity,
  );
  return matches.find((tab) => tab.active)
    ?? matches.find((tab) => !tab.discarded)
    ?? matches[0];
}

interface TabSpaceTargetOptions {
  activeSpaceId?: string;
  assignUnmatchedToActiveSpace: boolean;
  currentSpaceId?: string;
  fallbackSpaceId?: string;
}

export function findTabTargetSpace(
  spaces: Space[],
  options: TabSpaceTargetOptions,
): Space | undefined {
  return spaces.find((space) => space.id === options.fallbackSpaceId)
    ?? spaces.find((space) => space.id === options.currentSpaceId)
    ?? (options.assignUnmatchedToActiveSpace
      ? spaces.find((space) => space.id === options.activeSpaceId)
      : undefined);
}