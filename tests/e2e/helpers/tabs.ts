import {
  expect,
  type BrowserContext,
  type Page,
  type Worker,
} from '@playwright/test';
import type { Browser } from 'wxt/browser';
import { tabUrl as pendingOrCommittedUrl } from '../../../entrypoints/lib/urlIdentity';
import { callChrome } from './chrome';
import type { ExtensionGlobal } from './extensionGlobal';

export interface NavigationState {
  activeTabId?: number;
  orderedTabIds: number[];
  urlsByTabId: Record<number, string | undefined>;
}

export interface MatchingTabState {
  activeTabId?: number;
  matchingTabIds: number[];
}

export interface RecordedTabLifecycle {
  created: Array<{ groupId: number; id: number; url?: string }>;
  removed: number[];
  updated: Array<{ groupId?: number; id: number; url?: string }>;
}

export async function resetRecordedTabLifecycle(worker: Worker): Promise<void> {
  await worker.evaluate(() => {
    (globalThis as unknown as { hyperTabLifecycle: RecordedTabLifecycle })
      .hyperTabLifecycle = { created: [], removed: [], updated: [] };
  });
}

export async function recordedTabLifecycle(worker: Worker): Promise<RecordedTabLifecycle> {
  return worker.evaluate(() =>
    (globalThis as unknown as { hyperTabLifecycle: RecordedTabLifecycle })
      .hyperTabLifecycle);
}

export async function clearHyperRuntimeOwnership(worker: Worker): Promise<void> {
  await worker.evaluate(async () => {
    const runtime = globalThis as unknown as ExtensionGlobal;
    const tabs = await runtime.chrome.tabs.query({});
    await Promise.all(tabs.flatMap((tab) => tab.id === undefined ? [] : [
      runtime.chrome.sessions?.removeTabValue?.(tab.id, 'hyperSpaceId')
        .catch(() => undefined),
    ].filter((operation): operation is Promise<void> => operation !== undefined)));
    await runtime.chrome.storage.session.clear();
  });
}

export function transientCreatedTabs(lifecycle: RecordedTabLifecycle): RecordedTabLifecycle['created'] {
  const controlTabIds = new Set([
    ...lifecycle.created.flatMap((event) =>
      event.url?.startsWith('chrome://extensions') ? [event.id] : []),
    ...lifecycle.updated.flatMap((event) =>
      event.url?.startsWith('chrome://extensions') ? [event.id] : []),
  ]);
  const removedIds = new Set(lifecycle.removed);
  return lifecycle.created.filter((event) =>
    removedIds.has(event.id) && !controlTabIds.has(event.id));
}

export interface TabCreateProperties {
  active?: boolean;
  openerTabId?: number;
  windowId?: number;
}

/** Opens a tab, active unless told otherwise, and returns its ID. */
export async function createTab(
  worker: Worker,
  url: string,
  properties: TabCreateProperties = {},
): Promise<number> {
  const [tabId] = await createTabs(worker, [url], { active: true, ...properties });
  return tabId!;
}

/** Opens the tabs one after another in a single evaluation and returns their IDs. */
export async function createTabs(
  worker: Worker,
  urls: readonly string[],
  properties: TabCreateProperties,
): Promise<number[]> {
  return worker.evaluate(async ({ properties: shared, urls: targetUrls }) => {
    const extension = globalThis as unknown as ExtensionGlobal;
    const ids: number[] = [];
    for (const url of targetUrls) {
      const tab = await extension.chrome.tabs.create({ ...shared, url });
      if (tab.id === undefined) throw new Error('Chrome did not create the requested tab');
      ids.push(tab.id);
    }
    return ids;
  }, {
    properties: Object.fromEntries(Object.entries(properties)
      .filter(([, value]) => value !== undefined)),
    urls: [...urls],
  });
}

type QueriedTab = Browser.tabs.Tab;

export const queryTabs = (worker: Worker, query: Browser.tabs.QueryInfo = {}) =>
  callChrome<QueriedTab[]>(worker, 'tabs.query', query);

/** A browser tab as `chrome.tabs.get` reports it. */
export const browserTab = (worker: Worker, tabId: number) => callChrome<QueriedTab>(worker, 'tabs.get', tabId);

export async function activateTab(worker: Worker, tabId: number): Promise<void> {
  await callChrome(worker, 'tabs.update', tabId, { active: true });
}

export async function closeWindow(worker: Worker, windowId: number): Promise<void> {
  await callChrome(worker, 'windows.remove', windowId);
}

/** The subset of `tabIds` that still exist, in the given order. */
export async function openTabIds(worker: Worker, tabIds: number[]): Promise<number[]> {
  const open = await Promise.all(tabIds.map((tabId) =>
    browserTab(worker, tabId).then(() => tabId).catch(() => undefined)));
  return open.filter((tabId) => tabId !== undefined);
}

const byIndex = (tabs: QueriedTab[]) => [...tabs].sort((left, right) => left.index - right.index);

export const tabUrl = async (worker: Worker, tabId: number) => pendingOrCommittedUrl(await browserTab(worker, tabId));

/** Every open tab's URL, pending or committed, across windows. */
export async function openTabUrls(worker: Worker): Promise<string[]> {
  return (await queryTabs(worker)).map((tab) => pendingOrCommittedUrl(tab) ?? '');
}

/** The tabs, across windows, whose pending or committed URL starts with `prefix`. */
export async function tabsUnder(worker: Worker, prefix: string): Promise<Array<{ active: boolean; id: number; url?: string }>> {
  return (await queryTabs(worker))
    .filter((tab) => (pendingOrCommittedUrl(tab) ?? '').startsWith(prefix))
    .map((tab) => ({ active: tab.active, id: tab.id!, url: pendingOrCommittedUrl(tab) }));
}

export async function navigateTab(worker: Worker, tabId: number, url: string): Promise<void> {
  await callChrome(worker, 'tabs.update', tabId, { url });
}

/** The tracked tabs in the order the browser's own tab strip of the first one's window shows them. */
export async function nativeTabOrder(worker: Worker, tabIds: readonly number[]): Promise<number[]> {
  const { windowId } = await browserTab(worker, tabIds[0]!);
  const ids = new Set(tabIds);
  return byIndex(await queryTabs(worker, { windowId }))
    .flatMap((tab) => tab.id !== undefined && ids.has(tab.id) ? [tab.id] : []);
}

/** Waits until every given tab has finished loading. */
export async function waitForTabsComplete(worker: Worker, tabIds: readonly number[]): Promise<void> {
  await expect.poll(async () => (await Promise.all(tabIds.map((id) => browserTab(worker, id))))
    .every((tab) => tab.status === 'complete')).toBe(true);
}

export async function pageAtUrl(context: BrowserContext, url: string): Promise<Page> {
  await expect.poll(() => context.pages().map((page) => page.url())).toContain(url);
  const page = context.pages().find((candidate) => candidate.url() === url);
  if (!page) throw new Error(`Browser page was not found for ${url}`);
  return page;
}

export async function waitForNewPage(
  context: BrowserContext,
  action: () => Promise<unknown>,
): Promise<Page> {
  const existingPages = new Set(context.pages());
  const [page] = await Promise.all([
    context.waitForEvent('page', {
      predicate: (candidate) => !existingPages.has(candidate),
    }),
    action(),
  ]);
  return page;
}

export async function navigationState(
  worker: Worker,
  trackedTabIds: readonly number[],
): Promise<NavigationState> {
  const trackedIds = new Set(trackedTabIds);
  const windowTabs = await queryTabs(worker, { currentWindow: true });
  const tabs = byIndex(windowTabs.filter((tab) => tab.id !== undefined && trackedIds.has(tab.id)));
  return {
    activeTabId: windowTabs.find((tab) => tab.active)?.id,
    orderedTabIds: tabs.map((tab) => tab.id as number),
    urlsByTabId: Object.fromEntries(tabs.map((tab) => [tab.id as number, pendingOrCommittedUrl(tab)])),
  };
}

/** The active tab of the browser's current window. */
export async function activeTabId(worker: Worker): Promise<number | undefined> {
  return (await queryTabs(worker, { active: true, currentWindow: true }))[0]?.id;
}

export async function currentWindowTabIds(worker: Worker): Promise<number[]> {
  return byIndex(await queryTabs(worker, { currentWindow: true }))
    .flatMap((tab) => tab.id === undefined ? [] : [tab.id]);
}

export async function matchingTabState(worker: Worker, url: string): Promise<MatchingTabState> {
  const tabs = await queryTabs(worker, { currentWindow: true });
  return {
    activeTabId: tabs.find((tab) => tab.active)?.id,
    matchingTabIds: tabs.flatMap((tab) => pendingOrCommittedUrl(tab) === url && tab.id !== undefined ? [tab.id] : []),
  };
}

export interface TabOwnership {
  backingId?: string;
  backingToken?: string;
  spaceId?: string;
  windowId?: number;
}

/** Each tab's space record as its session value and as the session storage cache hold it. */
function storedTabRecords(
  worker: Worker,
  tabIds: readonly number[],
): Promise<Array<{ sessionValue?: TabOwnership; stored?: TabOwnership }>> {
  return worker.evaluate(async (ids) => {
    const extension = globalThis as unknown as ExtensionGlobal;
    return Promise.all(ids.map(async (tabId) => {
      const sessionValue = await extension.chrome.sessions?.getTabValue?.(
        tabId,
        'hyperSpaceId',
      ).catch(() => undefined) as TabOwnership | undefined;
      const storageKey = `tabSpaceId:${tabId}`;
      const stored = (await extension.chrome.storage.session.get(storageKey))[storageKey] as TabOwnership | undefined;
      return { sessionValue, stored };
    }));
  }, [...tabIds]);
}

/** Each tab's stored space record, its session value else the session storage cache. */
export const tabOwnership = async (worker: Worker, tabIds: readonly number[]) =>
  (await storedTabRecords(worker, tabIds)).map(({ sessionValue, stored }) => sessionValue ?? stored);

/** Each tab's stored space and backing token, each from its session value or else the session storage cache. */
export const storedTabSpaces = async (worker: Worker, tabIds: readonly number[]) =>
  (await storedTabRecords(worker, tabIds)).map(({ sessionValue, stored }) => ({
    backingToken: sessionValue?.backingToken ?? stored?.backingToken,
    spaceId: sessionValue?.spaceId ?? stored?.spaceId,
  }));

export async function tabOwnershipSummary(
  worker: Worker,
  trackedTabIds: readonly number[],
): Promise<{ allOwned: boolean; spaceCount: number }> {
  const spaceIds = (await storedTabSpaces(worker, trackedTabIds)).map((record) => record?.spaceId);
  return {
    allOwned: spaceIds.every((spaceId) => typeof spaceId === 'string'),
    spaceCount: new Set(spaceIds.filter((spaceId) => typeof spaceId === 'string')).size,
  };
}

export async function currentWindowId(worker: Worker): Promise<number> {
  const window = await callChrome<{ id?: number }>(worker, 'windows.getCurrent');
  if (window.id === undefined) throw new Error('The current browser window was not found');
  return window.id;
}

export async function tabBackingToken(worker: Worker, tabId: number): Promise<string | undefined> {
  return (await storedTabSpaces(worker, [tabId]))[0]?.backingToken;
}

/** Plays the browser's part in a tab drag: while one lasts, no extension can edit a tab strip. */
export async function holdTabDrag(worker: Worker, dragging: boolean): Promise<void> {
  await worker.evaluate((held) => {
    type Api = Record<string, unknown>;
    const scope = globalThis as unknown as {
      __hyperTabDrag?: { dragging: boolean; refused: number };
      browser?: { tabGroups?: Api; tabs?: Api };
      chrome: { tabGroups?: Api; tabs: Api };
    };
    if (!scope.__hyperTabDrag) {
      const drag = { dragging: false, refused: 0 };
      scope.__hyperTabDrag = drag;
      const lock = (api: Api | undefined, methods: readonly string[]) => {
        for (const method of methods) {
          const original = api?.[method];
          if (!api || typeof original !== 'function') continue;
          api[method] = (...args: unknown[]) => {
            if (!drag.dragging) return original.apply(api, args);
            drag.refused += 1;
            return Promise.reject(new Error('Tabs cannot be edited right now (user may be dragging a tab).'));
          };
        }
      };
      for (const tabs of new Set([scope.chrome.tabs, scope.browser?.tabs])) {
        lock(tabs, ['group', 'move', 'remove', 'ungroup', 'update']);
      }
      for (const groups of new Set([scope.chrome.tabGroups, scope.browser?.tabGroups])) {
        lock(groups, ['move', 'update']);
      }
    }
    scope.__hyperTabDrag.dragging = held;
  }, dragging);
}

export async function pageTabWindows(worker: Worker, urls: readonly string[]): Promise<Record<string, number[]>> {
  const tabs = await queryTabs(worker);
  return Object.fromEntries(urls.map((url) => [
    url,
    tabs.filter((tab) => pendingOrCommittedUrl(tab) === url).map((tab) => tab.windowId),
  ]));
}
