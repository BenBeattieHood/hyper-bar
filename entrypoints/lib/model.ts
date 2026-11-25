import { atom, createStore } from 'jotai/vanilla';
import {
  deriveBookmarkState,
  deriveSpaces,
  findHyperBookmarkStructure,
  tabBackings,
  tabBackingToken,
  type BookmarkNode,
  type BrowserTab,
  type Space,
} from './bookmarks';
import type { TabOwnership } from './tabOwnership';
import { tabUrl, urlsRepresentSamePage } from './urlIdentity';
import {
  emptyGroupOwnershipRegistry,
  groupOwnerships,
  liveSpaceColours,
  type GroupOwnershipConflict,
  type GroupOwnershipRegistry,
} from './groupOwnership';
import { preserveIdentity } from './modelIdentity';
import {
  emptyCommandStatusTable,
  retainCommandStatuses,
  settleCommand,
  type CommandFailureReason,
  type CommandStatusTable,
} from './modelActions';
import { assessStructureHealth, type StructureHealth } from './modelIntegrity';
import {
  classifyObservedTabs,
  tabDispositionsById,
  type BackingLocation,
  type TabDisposition,
} from './tabDisposition';
import { defaultHyperPreferences, type HyperPreferences } from './preferences';
import {
  noBrowserCommandCapabilities,
  type BrowserCommandCapabilities,
} from './browserCommandCapabilities';
import type { TabContentSnapshots } from './tabContent';
import type { TabMediaStates } from './mediaState';
import type { SearchItem } from './search';
import type { SearchSelectionHistory } from './searchSelection';
import type { RecentlyClosedTab } from './recentlyClosed';
import type { SharedDrag } from './sharedDrag';
import type { TimedMessage } from './timedMessages';
import {
  deriveTabBookmarkState,
  type TabBookmarkLink,
  type TabName,
} from './tabBookmarkLink';
import { normalWindowIds } from './windowState';

export interface BrowserObservation {
  bookmarkTree: BookmarkNode[];
  extensionOrigin: string;
  focusedWindowId: number | null;
  recentlyClosedTabs: RecentlyClosedTab[];
  tabGroups: Browser.tabGroups.TabGroup[];
  tabs: BrowserTab[];
  windows: Browser.windows.Window[];
}

/**
 * Durable and session-backed facts the browser does not report directly.
 * Command status is deliberately absent: an outcome belongs to the revision that
 * proves it, so it is ephemeral root state rather than persisted metadata.
 */
export interface RuntimeMetadata {
  activeSpaceIds: Readonly<Record<number, string>>;
  bookmarkImportActiveCount: number;
  commandCapabilities: BrowserCommandCapabilities;
  preferences: HyperPreferences;
  groupConflicts: readonly GroupOwnershipConflict[];
  groupOwnership: GroupOwnershipRegistry;
  historySearchItems: readonly SearchItem[];
  /** This installation's ID, which names the tabs it backs among other sessions'. */
  installationId?: string;
  mediaControlAvailable: boolean;
  mediaRetainedTabIds: Readonly<Record<number, number>>;
  mediaStates: TabMediaStates;
  /** Tabs whose page neither answers Hyper's content script nor lets Hyper script it. */
  mediaUnreachableTabIds: readonly number[];
  searchSelectionHistory: SearchSelectionHistory;
  sharedDrag: SharedDrag | null;
  // Advances whenever a tab starts showing something else, so a reader knows the
  // page it scraped no longer describes the tab.
  tabContents: TabContentSnapshots;
  tabContentVersions: Readonly<Record<number, number>>;
  tabOwnerships: Readonly<Record<number, TabOwnership>>;
  /** At most one per window: a newer message replaces the older (build spec §27). */
  timedMessages: Readonly<Record<number, TimedMessage>>;
}

export interface HyperBookmarkModel {
  backings: ReadonlyMap<string, BackingLocation>;
  favouriteSlots: Array<BookmarkNode | undefined>;
  favourites: BookmarkNode[];
  favouritesRootId?: string;
  globalBookmarks: BookmarkNode[];
  globalBookmarksRootId?: string;
  localBookmarkSpaceIds: Readonly<Record<string, string>>;
  localBookmarksBySpaceId: Readonly<Record<string, BookmarkNode[]>>;
  spaces: Space[];
  spacesRootId?: string;
}

export interface HyperProjection {
  structureHealth: StructureHealth;
  tabBookmarkLinks: ReadonlyMap<number, TabBookmarkLink>;
  tabDispositions: ReadonlyMap<number, TabDisposition>;
  tabNames: ReadonlyMap<number, TabName>;
  /** Each backed tab's own page title, by `tabPageTitle`. */
  tabPageTitles: ReadonlyMap<number, string>;
  /** What every surface calls each tab, by `deriveTabTitle`. */
  tabTitles: ReadonlyMap<number, string>;
}

export interface HyperModelSources {
  browser: BrowserObservation;
  runtime: RuntimeMetadata;
}

export interface HyperModelSnapshot extends HyperModelSources {
  commands: CommandStatusTable;
  derived: HyperProjection;
  hyper: HyperBookmarkModel;
  revision: number;
}

export const emptyBrowserObservation: BrowserObservation = {
  bookmarkTree: [],
  extensionOrigin: '',
  focusedWindowId: null,
  recentlyClosedTabs: [],
  tabGroups: [],
  tabs: [],
  windows: [],
};

export const emptyRuntimeMetadata: RuntimeMetadata = {
  activeSpaceIds: {},
  bookmarkImportActiveCount: 0,
  commandCapabilities: noBrowserCommandCapabilities,
  preferences: defaultHyperPreferences,
  groupConflicts: [],
  groupOwnership: emptyGroupOwnershipRegistry,
  historySearchItems: [],
  mediaControlAvailable: false,
  mediaRetainedTabIds: {},
  mediaStates: {},
  mediaUnreachableTabIds: [],
  searchSelectionHistory: {},
  sharedDrag: null,
  tabContents: {},
  tabContentVersions: {},
  tabOwnerships: {},
  timedMessages: {},
};

export const emptyHyperModelSources: HyperModelSources = {
  browser: emptyBrowserObservation,
  runtime: emptyRuntimeMetadata,
};

/** A backing belongs to the space whose hidden tabs folder holds it, however deeply. */
function deriveTabBackings(spaces: readonly Space[]): ReadonlyMap<string, BackingLocation> {
  const backings = new Map<string, BackingLocation>();
  for (const space of spaces) {
    for (const node of tabBackings(space)) {
      backings.set(node.id, { spaceId: space.id, token: tabBackingToken(node) });
    }
  }
  return backings;
}

/** One tab's disposition from a fresh read, by the rules the committed model applies. */
export function classifyLiveTab(
  bookmarkTree: BookmarkNode[],
  extensionOrigin: string,
  tab: BrowserTab,
  ownership: TabOwnership | undefined,
): TabDisposition {
  const spaces = deriveSpaces(bookmarkTree);
  const [entry] = classifyObservedTabs({
    backings: deriveTabBackings(spaces),
    extensionOrigin,
    knownSpaceIds: new Set(spaces.map((space) => space.id)),
    normalWindowIds: new Set([tab.windowId]),
    ownerships: ownership && tab.id !== undefined ? { [tab.id]: ownership } : {},
    tabs: [tab],
  });
  return entry!.disposition;
}

function deriveHyperBookmarkModel(sources: HyperModelSources): HyperBookmarkModel {
  const state = deriveBookmarkState(sources.browser.bookmarkTree, Object.fromEntries(liveSpaceColours(
    sources.browser.tabGroups,
    groupOwnerships(sources.runtime.groupOwnership),
  )));
  const structure = findHyperBookmarkStructure(sources.browser.bookmarkTree);
  const { spaces } = state;
  return {
    backings: deriveTabBackings(spaces),
    favouriteSlots: state.favouriteSlots,
    favourites: state.favourites,
    favouritesRootId: structure?.favourites.id,
    globalBookmarks: state.globalBookmarks,
    ...(state.globalBookmarksRootId ? { globalBookmarksRootId: state.globalBookmarksRootId } : {}),
    localBookmarkSpaceIds: state.localBookmarkSpaceIds,
    localBookmarksBySpaceId: state.localBookmarksBySpaceId,
    spaces,
    spacesRootId: structure?.spaces.id,
  };
}

function deriveProjection(
  sources: HyperModelSources,
  hyper: HyperBookmarkModel,
): HyperProjection {
  const normalWindows = normalWindowIds(sources.browser.windows);
  const { links, names, pageTitles, titles } = deriveTabBookmarkState({
    backingNodes: new Map(hyper.spaces.flatMap((space) =>
      tabBackings(space).map((node) => [node.id, node] as const))),
    favourites: hyper.favourites,
    globalBookmarks: hyper.globalBookmarks,
    localBookmarksBySpaceId: hyper.localBookmarksBySpaceId,
    ownerships: sources.runtime.tabOwnerships,
    tabs: sources.browser.tabs,
  });
  return {
    structureHealth: assessStructureHealth(sources.browser.bookmarkTree),
    tabBookmarkLinks: links,
    tabDispositions: tabDispositionsById(classifyObservedTabs({
      backings: hyper.backings,
      extensionOrigin: sources.browser.extensionOrigin,
      knownSpaceIds: new Set(hyper.spaces.map((space) => space.id)),
      normalWindowIds: normalWindows,
      ownerships: sources.runtime.tabOwnerships,
      tabs: sources.browser.tabs,
    })),
    tabNames: names,
    tabPageTitles: pageTitles,
    tabTitles: titles,
  };
}

export function materialiseHyperModel(
  revision: number,
  sources: HyperModelSources,
  commands: CommandStatusTable = emptyCommandStatusTable,
): HyperModelSnapshot {
  const hyper = deriveHyperBookmarkModel(sources);
  return { ...sources, commands, derived: deriveProjection(sources, hyper), hyper, revision };
}

/** What the model calls a tab while it still shows `url`'s page: the name it shows, whoever gave it, and its page's own title. */
export interface ModelTabTitles {
  name?: string;
  pageTitle?: string;
}

/** A normal window's tabs, or nothing for an incognito or unknown window, which no view is shown. */
export function normalWindowTabs(
  snapshot: HyperModelSnapshot,
  windowId: number,
): BrowserTab[] | undefined {
  const window = snapshot.browser.windows.find((candidate) => candidate.id === windowId);
  if (!window || window.incognito) return undefined;
  return snapshot.browser.tabs.filter((tab) => tab.windowId === windowId);
}

export function modelTabTitles(snapshot: HyperModelSnapshot, tabId: number, url: string): ModelTabTitles {
  const tab = snapshot.browser.tabs.find((candidate) => candidate.id === tabId);
  if (!tab || !urlsRepresentSamePage(tabUrl(tab), url)) return {};
  const name = snapshot.derived.tabNames.get(tabId);
  const pageTitle = snapshot.derived.tabPageTitles.get(tabId);
  return {
    ...(name ? { name: name.title } : {}),
    ...(pageTitle === undefined ? {} : { pageTitle }),
  };
}

export const hyperModelAtom = atom<HyperModelSnapshot>(
  materialiseHyperModel(0, emptyHyperModelSources),
);

export const hyperRevisionAtom = atom((get) => get(hyperModelAtom).revision);
export const browserTabsAtom = atom((get) => get(hyperModelAtom).browser.tabs);
export const commandStatusesAtom = atom((get) => get(hyperModelAtom).commands);
export const favouritesAtom = atom((get) => get(hyperModelAtom).hyper.favourites);
export const spacesAtom = atom((get) => get(hyperModelAtom).hyper.spaces);
export const structureHealthAtom = atom(
  (get) => get(hyperModelAtom).derived.structureHealth,
);
export const tabDispositionsAtom = atom(
  (get) => get(hyperModelAtom).derived.tabDispositions,
);

export interface CommandSettlement {
  commandId: string;
  failure?: CommandFailureReason;
  phase: 'failed' | 'succeeded';
  result?: unknown;
}

export interface HyperModelCommit {
  /** Terminal outcomes land on the same revision as the state that proves them. */
  settle?: readonly CommandSettlement[];
  sources: HyperModelSources;
}

export const commitHyperModelAtom = atom(
  null,
  (get, set, commit: HyperModelCommit): HyperModelSnapshot => {
    const previous = get(hyperModelAtom);
    const revision = previous.revision + 1;
    const commands = retainCommandStatuses((commit.settle ?? []).reduce(
      (table, settlement) => settleCommand(table, settlement.commandId, settlement, revision),
      previous.commands,
    ));
    // Every reconciliation re-reads and re-derives, so an unchanged model still
    // arrives as new objects. Only the revision is guaranteed to differ, and
    // keeping the previous references lets a view trust identity to mean change.
    const snapshot = preserveIdentity(
      previous,
      materialiseHyperModel(revision, commit.sources, commands),
    );
    set(hyperModelAtom, snapshot);
    return snapshot;
  },
);

/**
 * Command bookkeeping advances the revision without re-deriving the tree, so a
 * view observes `pending` through the same ordered channel as everything else.
 */
export const setCommandStatusesAtom = atom(
  null,
  (get, set, commands: CommandStatusTable): HyperModelSnapshot => {
    const previous = get(hyperModelAtom);
    const snapshot: HyperModelSnapshot = {
      ...previous,
      commands: retainCommandStatuses(commands),
      revision: previous.revision + 1,
    };
    set(hyperModelAtom, snapshot);
    return snapshot;
  },
);

export type HyperModelStore = ReturnType<typeof createStore>;

export function createHyperModelStore(
  initialSources: HyperModelSources = emptyHyperModelSources,
): HyperModelStore {
  const store = createStore();
  store.set(hyperModelAtom, materialiseHyperModel(0, initialSources));
  return store;
}