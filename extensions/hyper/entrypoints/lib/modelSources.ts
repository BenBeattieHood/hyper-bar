import { sessionStorageArea } from './sessionValues';
import type {
  BrowserObservation,
  HyperModelSources,
  RuntimeMetadata,
} from './model';
import type { HyperModelSourcesReader } from './modelReconciler';
import { resolveGroupOwnership, type GroupOwnership } from './groupOwnership';
import { parseSpaceGroupKey } from './spaceGroupStore';
import { mergeNativeTabStatuses } from './tabStatus';
import { loadTabOwnerships } from './tabOwnership';
import { getWindowActiveSpaceId } from './windowState';
import { preferencesFromHyperRoot } from './preferences';
import { findHyperRootFolder } from './bookmarks';
import { INSTALLATION_ID_KEY } from './bookmarkStorage';
import { readBrowserCommandCapabilities } from './browserCommandCapabilities';
import { readRecentlyClosedTabs } from './recentlyClosed';
import type { SharedDrag } from './sharedDrag';
import { currentTimedMessages, type TimedMessage } from './timedMessages';
import { currentTabContents, type TabContentSnapshots } from './tabContent';
import type { SearchItem } from './search';
import {
  parseSearchSelectionHistory,
  SEARCH_SELECTION_HISTORY_KEY,
} from './searchSelection';
import {
  currentMediaRetainedTabIds,
  currentMediaUnreachableTabIds,
  currentTabMediaStates,
  type TabMediaStates,
} from './mediaState';

/**
 * What the background knows about a tab that querying it cannot say.
 *
 * Navigation events reach the background before a query would report them, and
 * a query answers about the page a tab holds rather than how many pages it has
 * held, so both are carried alongside the observation.
 */
export interface RuntimeSignals {
  bookmarkImportActiveCount: number;
  contentSnapshots: TabContentSnapshots;
  contentVersions: Readonly<Record<number, number>>;
  historySearchItems: readonly SearchItem[];
  mediaControlAvailable: boolean;
  mediaNavigationVersions: Readonly<Record<number, number>>;
  mediaRetainedTabIds: Readonly<Record<number, number>>;
  mediaStates: TabMediaStates;
  mediaUnreachableTabIds: readonly number[];
  sharedDrag: SharedDrag | null;
  statuses: ReadonlyMap<number, 'complete' | 'loading'>;
  timedMessages: Readonly<Record<number, TimedMessage>>;
}

const noRuntimeSignals: RuntimeSignals = {
  bookmarkImportActiveCount: 0,
  contentSnapshots: {},
  contentVersions: {},
  historySearchItems: [],
  mediaControlAvailable: false,
  mediaNavigationVersions: {},
  mediaRetainedTabIds: {},
  mediaStates: {},
  mediaUnreachableTabIds: [],
  sharedDrag: null,
  statuses: new Map(),
  timedMessages: {},
};

async function readBrowserObservation(
  tabStatuses: RuntimeSignals['statuses'],
): Promise<BrowserObservation> {
  const extensionOrigin = browser.runtime.getURL('/');
  const [bookmarkTree, tabs, windows, focusedWindow, tabGroups, recentlyClosedTabs] = await Promise.all([
    browser.bookmarks.getTree(),
    browser.tabs.query({}),
    browser.windows.getAll({ populate: false }),
    browser.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => undefined),
    browser.tabGroups?.query({}) ?? Promise.resolve([]),
    readRecentlyClosedTabs(extensionOrigin),
  ]);
  return {
    bookmarkTree,
    extensionOrigin,
    focusedWindowId: focusedWindow?.id ?? null,
    recentlyClosedTabs,
    tabGroups,
    tabs: mergeNativeTabStatuses(tabs, tabStatuses),
    windows,
  };
}

async function readRuntimeMetadata(
  observation: BrowserObservation,
  signals: RuntimeSignals,
): Promise<RuntimeMetadata> {
  const [tabOwnerships, sessionValues, localValues, activeSpaceEntries] = await Promise.all([
    loadTabOwnerships(observation.tabs),
    sessionStorageArea()?.get(null).catch(() => ({} as Record<string, unknown>)) ??
      Promise.resolve({} as Record<string, unknown>),
    browser.storage.local.get([INSTALLATION_ID_KEY, SEARCH_SELECTION_HISTORY_KEY]),
    Promise.all(observation.windows.flatMap((window) => window.id === undefined
      ? []
      : [getWindowActiveSpaceId(window.id).then((spaceId) =>
        spaceId === undefined ? undefined : [window.id as number, spaceId] as const)])),
  ]);
  const preferences = preferencesFromHyperRoot(findHyperRootFolder(observation.bookmarkTree));
  const activeSpaceIds = Object.fromEntries(activeSpaceEntries.filter(
    (entry): entry is readonly [number, string] => Boolean(entry),
  ));
  const mappings: GroupOwnership[] = [];
  for (const [key, value] of Object.entries(sessionValues)) {
    const mapping = parseSpaceGroupKey(key);
    if (!mapping || typeof value !== 'number') continue;
    mappings.push({ groupId: value, spaceId: mapping.spaceId, windowId: mapping.windowId });
  }
  // Persisted mappings are only ever trusted against the groups that still exist.
  const observedGroupWindows = new Map(observation.tabGroups.map(
    (group) => [group.id, group.windowId] as const,
  ));
  const { conflicts, registry } = resolveGroupOwnership(mappings, observedGroupWindows);
  return {
    activeSpaceIds,
    bookmarkImportActiveCount: signals.bookmarkImportActiveCount,
    commandCapabilities: readBrowserCommandCapabilities(),
    preferences,
    groupConflicts: conflicts,
    groupOwnership: registry,
    historySearchItems: signals.historySearchItems,
    ...(typeof localValues[INSTALLATION_ID_KEY] === 'string'
      ? { installationId: localValues[INSTALLATION_ID_KEY] }
      : {}),
    mediaControlAvailable: signals.mediaControlAvailable,
    mediaRetainedTabIds: currentMediaRetainedTabIds(observation.tabs, signals.mediaRetainedTabIds),
    mediaStates: currentTabMediaStates(
      observation.tabs,
      signals.mediaNavigationVersions,
      signals.mediaStates,
    ),
    mediaUnreachableTabIds: currentMediaUnreachableTabIds(
      observation.tabs,
      signals.mediaUnreachableTabIds,
    ),
    searchSelectionHistory: parseSearchSelectionHistory(
      localValues[SEARCH_SELECTION_HISTORY_KEY],
    ),
    sharedDrag: signals.sharedDrag,
    tabContents: preferences.pageTextSearch
      ? currentTabContents(observation.tabs, signals.contentVersions, signals.contentSnapshots)
      : {},
    tabContentVersions: signals.contentVersions,
    tabOwnerships,
    timedMessages: currentTimedMessages(observation.tabs, signals.timedMessages),
  };
}

export function createBrowserModelSourcesReader(
  readRuntimeSignals: () => RuntimeSignals = () => noRuntimeSignals,
): HyperModelSourcesReader {
  return {
    async readSources(): Promise<HyperModelSources> {
      const signals = readRuntimeSignals();
      const browserObservation = await readBrowserObservation(signals.statuses);
      return {
        browser: browserObservation,
        runtime: await readRuntimeMetadata(browserObservation, signals),
      };
    },
  };
}