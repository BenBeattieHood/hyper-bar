import { clamp, isFiniteNumber, isRecord } from './collections';
import {
  bookmarkHyperMetadata,
  bookmarkTitleWithHyper,
  type BookmarkNode,
} from './bookmarks';
import { clampInPageSidebarWidth, IN_PAGE_SIDEBAR_DEFAULT_WIDTH } from './inPageSidebarProtocol';

/*
 * Preferences belong to the user's Hyper setup, so they persist where the rest
 * of it does: in the title metadata of the `hyper` root bookmark folder, as
 * `hyper {"hyper":{"preferences":{...}}}`. Chrome sync and bookmark export carry
 * them with the spaces they shape, a reinstall keeps them, and the model reads
 * them in the same bookmark read as everything else. Only a preference the user
 * has set is written; the rest keep their defaults.
 */

export interface HyperPreferences {
  /** The share of the combined workspace's height given to Bookmarks. */
  bookmarkPanelPercent: number;
  combineTabsAndBookmarks: boolean;
  autofolders: boolean;
  /** Shows one favourites-bar tile per domain, listing that domain's favourites and tabs. */
  groupFavouritesByDomain: boolean;
  inPageSidebar: boolean;
  inPageSidebarWidth: number;
  /** Lets Search match open tabs by the text on their pages, read through Hyper's page script. */
  pageTextSearch: boolean;
  /** Shows, below this window's tabs, the tabs other devices and earlier installations keep. */
  showOtherSessions: boolean;
  /** Keeps the browser's tab strip and the Tabs list in one order, each following the other's moves. */
  syncTabStripOrder: boolean;
  /** How long every timed message stays up, in whole seconds. */
  timedMessageSeconds: number;
}

export const BOOKMARK_PANEL_MIN_PERCENT = 20;
export const BOOKMARK_PANEL_MAX_PERCENT = 80;

const clampRounded = (min: number, max: number) => (value: number): number =>
  clamp(Math.round(value), min, max);

export const clampBookmarkPanelPercent = clampRounded(BOOKMARK_PANEL_MIN_PERCENT, BOOKMARK_PANEL_MAX_PERCENT);

export const TIMED_MESSAGE_MIN_SECONDS = 3;
export const TIMED_MESSAGE_MAX_SECONDS = 15;

export const clampTimedMessageSeconds = clampRounded(TIMED_MESSAGE_MIN_SECONDS, TIMED_MESSAGE_MAX_SECONDS);

export const defaultHyperPreferences: HyperPreferences = {
  bookmarkPanelPercent: 50,
  combineTabsAndBookmarks: false,
  autofolders: true,
  groupFavouritesByDomain: true,
  inPageSidebar: false,
  inPageSidebarWidth: IN_PAGE_SIDEBAR_DEFAULT_WIDTH,
  pageTextSearch: false,
  showOtherSessions: false,
  syncTabStripOrder: false,
  timedMessageSeconds: 7,
};

const preferenceKeys = Object.keys(defaultHyperPreferences) as Array<keyof HyperPreferences>;

function isPreferenceKey(key: unknown): key is keyof HyperPreferences {
  return preferenceKeys.includes(key as keyof HyperPreferences);
}

const readBoolean = (value: unknown) => typeof value === 'boolean' ? value : undefined;
const readNumber = (bound: (value: number) => number) => (value: unknown) =>
  isFiniteNumber(value) ? bound(value) : undefined;

const preferenceReaders: {
  [Key in keyof HyperPreferences]: (value: unknown) => HyperPreferences[Key] | undefined;
} = {
  autofolders: readBoolean,
  bookmarkPanelPercent: readNumber(clampBookmarkPanelPercent),
  combineTabsAndBookmarks: readBoolean,
  groupFavouritesByDomain: readBoolean,
  inPageSidebar: readBoolean,
  inPageSidebarWidth: readNumber(clampInPageSidebarWidth),
  pageTextSearch: readBoolean,
  showOtherSessions: readBoolean,
  syncTabStripOrder: readBoolean,
  timedMessageSeconds: readNumber(clampTimedMessageSeconds),
};

/** The preference as Hyper understands it, or nothing for an unknown key or a malformed value. */
function readPreference(key: unknown, value: unknown): Partial<HyperPreferences> {
  if (!isPreferenceKey(key)) return {};
  const read = preferenceReaders[key](value);
  return read === undefined ? {} : { [key]: read };
}

/** Everything saved under `preferences`, including keys a newer Hyper wrote. */
function savedPreferenceValues(root: Pick<BookmarkNode, 'title'>): Record<string, unknown> {
  const saved = bookmarkHyperMetadata(root).preferences;
  return isRecord(saved) ? saved : {};
}

export function savedHyperPreferences(
  root: Pick<BookmarkNode, 'title'> | undefined,
): Partial<HyperPreferences> {
  if (!root) return {};
  return Object.assign({}, ...Object.entries(savedPreferenceValues(root)).map(
    ([key, value]) => readPreference(key, value),
  ));
}

export function preferencesFromHyperRoot(
  root: Pick<BookmarkNode, 'title'> | undefined,
): HyperPreferences {
  return { ...defaultHyperPreferences, ...savedHyperPreferences(root) };
}

export function hyperRootTitleWithPreferences(
  root: Pick<BookmarkNode, 'title'>,
  preferences: Partial<HyperPreferences>,
): string {
  return bookmarkTitleWithHyper(root.title, {
    preferences: { ...savedPreferenceValues(root), ...preferences },
  });
}

export function parsePreferencePayload(payload: unknown): Partial<HyperPreferences> {
  const { key, value } = isRecord(payload) ? payload : {};
  const preference = readPreference(key, value);
  if (Object.keys(preference).length === 0) {
    throw new Error('The preference value is invalid.');
  }
  return preference;
}

/**
 * Where earlier versions kept preferences. Startup moves any it finds onto the
 * root folder and removes them, so nothing reads these keys afterwards.
 */
export const legacyPreferenceStorageKeys = [
  'hyperCombineTabsAndBookmarks',
  'hyperInPageSidebar',
  'hyperTabFolderMode',
] as const;

/** Reads the legacy keys exactly as earlier versions did; absent keys stay unset. */
export function legacyStoredPreferences(
  stored: Record<string, unknown>,
): Partial<HyperPreferences> {
  return {
    ...('hyperCombineTabsAndBookmarks' in stored
      ? { combineTabsAndBookmarks: stored.hyperCombineTabsAndBookmarks !== false }
      : {}),
    ...('hyperInPageSidebar' in stored
      ? { inPageSidebar: stored.hyperInPageSidebar === true }
      : {}),
    ...('hyperTabFolderMode' in stored
      ? { autofolders: stored.hyperTabFolderMode === 'autofolders' }
      : {}),
  };
}