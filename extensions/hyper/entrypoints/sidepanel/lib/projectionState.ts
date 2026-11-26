import {
  indexTabSpacesByPageIdentity,
  type BookmarkNode,
  type BrowserTab,
  type SpaceIdentityIndex,
} from '../../lib/bookmarks';
import type { BrowserCommandCapabilities } from '../../lib/browserCommandCapabilities';
import { noBrowserCommandCapabilities } from '../../lib/browserCommandCapabilities';
import type { HyperRemoteSpacePresence, HyperSidebarProjection } from '../../lib/modelPort';
import type { ProjectedSharedDrag } from '../../lib/sharedDrag';
import { defaultHyperPreferences, type HyperPreferences } from '../../lib/preferences';
import type { TabMediaState } from '../../lib/mediaState';
import type { TabGroupColour } from '../../lib/tabGroups';
import type { TimedMessage } from '../../lib/timedMessages';
import { pageIdentity, tabUrl } from '../../lib/urlIdentity';

/**
 * The subset of the sidebar's state the background model owns outright.
 *
 * A field belongs here once its writes either travel as intents or are held as
 * overlay edits, because both are retired by evidence from the model rather than
 * by the view guessing when its own change has landed.
 */
export interface ProjectedBrowserState {
  activeSpaceId: string | null;
  backgroundMusicTabIds: readonly number[];
  bookmarkImportInProgress: boolean;
  bookmarkTree: BookmarkNode[];
  commandCapabilities: BrowserCommandCapabilities;
  currentWindowFocused: boolean;
  currentWindowId: number;
  currentWindowIncognito: boolean;
  /** This installation's ID; every other one on a backing is another session. */
  installationId?: string;
  mediaControlAvailable: boolean;
  mediaRetainedTabId?: number;
  mediaTarget?: TabMediaState;
  modelRevision: number;
  favouriteIds: string[];
  preferences: HyperPreferences;
  recentlyClosedTabs: HyperSidebarProjection['recentlyClosedTabs'];
  remoteSpacePresence: HyperRemoteSpacePresence;
  favouritesFolderId: string | null;
  globalBookmarksFolderId: string | null;
  sharedDrag: ProjectedSharedDrag | null;
  /** Each space's colour as this window shows it, read from its live tab groups; a space with no group has none. */
  spaceColours: Record<string, TabGroupColour>;
  spaceGroupIds: Record<string, number>;
  spacesFolderId: string | null;
  tabBackingIds: Record<number, string>;
  tabBookmarkLinks: HyperSidebarProjection['window']['tabBookmarkLinks'];
  tabNames: HyperSidebarProjection['window']['tabNames'];
  tabTitles: HyperSidebarProjection['window']['tabTitles'];
  tabSpaceIds: Record<number, string>;
  tabs: BrowserTab[];
  /** The window's one timed message, which the header shows (build spec §27). */
  timedMessage?: TimedMessage;
}

/** What the view shows before the model has answered. */
export const emptyProjectedBrowserState: Omit<
  ProjectedBrowserState,
  'currentWindowId' | 'currentWindowIncognito'
> = {
  activeSpaceId: null,
  backgroundMusicTabIds: [],
  bookmarkImportInProgress: false,
  bookmarkTree: [],
  commandCapabilities: noBrowserCommandCapabilities,
  currentWindowFocused: false,
  favouriteIds: [],
  favouritesFolderId: null,
  globalBookmarksFolderId: null,
  mediaControlAvailable: false,
  modelRevision: 0,
  preferences: defaultHyperPreferences,
  recentlyClosedTabs: [],
  remoteSpacePresence: { bookmarkSpaceIds: {}, otherWindowTabCounts: {}, tabSpaceIds: {} },
  sharedDrag: null,
  spaceColours: {},
  spaceGroupIds: {},
  spacesFolderId: null,
  tabBackingIds: {},
  tabBookmarkLinks: {},
  tabNames: {},
  tabTitles: {},
  tabSpaceIds: {},
  tabs: [],
};

export function projectBrowserState(
  projection: HyperSidebarProjection,
): ProjectedBrowserState {
  const { hyper, window } = projection;
  const ownerships = Object.entries(projection.tabOwnerships);
  return {
    activeSpaceId: window.activeSpaceId ?? null,
    backgroundMusicTabIds: window.backgroundMusicTabIds,
    bookmarkImportInProgress: projection.bookmarkImportInProgress,
    bookmarkTree: projection.bookmarkTree,
    commandCapabilities: projection.commandCapabilities,
    currentWindowFocused: window.focused,
    currentWindowId: window.windowId,
    currentWindowIncognito: window.incognito,
    installationId: projection.installationId,
    mediaControlAvailable: window.mediaControlAvailable,
    mediaRetainedTabId: window.mediaRetainedTabId,
    mediaTarget: window.mediaTarget,
    modelRevision: projection.revision,
    favouriteIds: hyper.favourites.map((node) => node.id),
    preferences: projection.preferences,
    recentlyClosedTabs: projection.recentlyClosedTabs,
    remoteSpacePresence: {
      bookmarkSpaceIds: Object.fromEntries(Object.entries(
        projection.remoteSpacePresence.bookmarkSpaceIds,
      ).map(([bookmarkId, spaceIds]) => [bookmarkId, [...spaceIds]])),
      otherWindowTabCounts: { ...projection.remoteSpacePresence.otherWindowTabCounts },
      tabSpaceIds: Object.fromEntries(Object.entries(
        projection.remoteSpacePresence.tabSpaceIds,
      ).map(([tabId, spaceIds]) => [Number(tabId), [...spaceIds]])),
    },
    favouritesFolderId: hyper.favouritesRootId ?? null,
    globalBookmarksFolderId: hyper.globalBookmarksRootId ?? null,
    sharedDrag: projection.sharedDrag,
    // Group ownership is resolved against the groups that still exist, so a
    // group the user closed leaves these on its own.
    spaceColours: Object.fromEntries(hyper.spaces.flatMap((space) =>
      space.colour ? [[space.id, space.colour] as const] : [])),
    spaceGroupIds: { ...window.groupIdsBySpace },
    spacesFolderId: hyper.spacesRootId ?? null,
    tabBackingIds: Object.fromEntries(ownerships.flatMap(([tabId, ownership]) =>
      ownership.backingId ? [[Number(tabId), ownership.backingId] as const] : [])),
    tabBookmarkLinks: window.tabBookmarkLinks,
    tabNames: window.tabNames,
    tabTitles: window.tabTitles,
    tabSpaceIds: Object.fromEntries(ownerships.map(
      ([tabId, ownership]) => [Number(tabId), ownership.spaceId] as const,
    )),
    tabs: projection.tabs,
    timedMessage: window.timedMessage,
  };
}

/** Adds remote presence only to page identities already available to the view. */
export function indexVisibleSpaceIds(
  state: Pick<ProjectedBrowserState, 'remoteSpacePresence' | 'tabSpaceIds' | 'tabs'>,
  bookmarks: readonly BookmarkNode[],
): SpaceIdentityIndex {
  const { remoteSpacePresence, tabSpaceIds, tabs } = state;
  const index = new Map<string, Set<string>>();
  for (const [identity, spaceIds] of indexTabSpacesByPageIdentity([...tabs], tabSpaceIds)) {
    index.set(identity, new Set(spaceIds));
  }
  const addRemoteSpaceIds = (url: string | undefined, spaceIds: readonly string[] | undefined) => {
    const identity = pageIdentity(url);
    if (!identity || !spaceIds || spaceIds.length === 0) return;
    const matches = index.get(identity) ?? new Set<string>();
    for (const spaceId of spaceIds) matches.add(spaceId);
    index.set(identity, matches);
  };
  for (const tab of tabs) {
    if (tab.id === undefined) continue;
    addRemoteSpaceIds(tabUrl(tab), remoteSpacePresence.tabSpaceIds[tab.id]);
  }
  const visit = (nodes: readonly BookmarkNode[]) => {
    for (const node of nodes) {
      addRemoteSpaceIds(node.url, remoteSpacePresence.bookmarkSpaceIds[node.id]);
      visit(node.children ?? []);
    }
  };
  visit(bookmarks);
  return index;
}
