import type { useBrowserState } from './useBrowserState';
import { usePreferenceSetting } from './usePreferenceSetting';
import { useTimedMessageSetting } from './useTimedMessageSetting';

/** The preferences Settings changes, each saved on the `hyper` root folder through an intent. */
export function useSettingsPreferences({
  onNotice,
  preferences,
  setPreference,
}: Pick<ReturnType<typeof useBrowserState>, 'preferences' | 'setPreference'> & {
  onNotice: (message: string) => void;
}) {
  return {
    combineTabsAndBookmarks: usePreferenceSetting({
      enabled: preferences.combineTabsAndBookmarks,
      failureNotice: 'The tabs and bookmarks layout setting could not be changed',
      onNotice,
      setEnabled: (enabled) => setPreference('combineTabsAndBookmarks', enabled),
    }),
    contentSearch: usePreferenceSetting({
      enabled: preferences.pageTextSearch,
      failureNotice: 'The page text search setting could not be changed',
      onNotice,
      setEnabled: (enabled) => setPreference('pageTextSearch', enabled),
    }),
    favouriteGrouping: usePreferenceSetting({
      enabled: preferences.groupFavouritesByDomain,
      failureNotice: 'The favourites grouping setting could not be changed',
      onNotice,
      setEnabled: (enabled) => setPreference('groupFavouritesByDomain', enabled),
    }),
    inPageSidebarSetting: usePreferenceSetting({
      enabled: preferences.inPageSidebar,
      failureNotice: 'The in-page sidebar setting could not be changed',
      onNotice,
      setEnabled: (enabled) => setPreference('inPageSidebar', enabled),
    }),
    tabFolders: usePreferenceSetting({
      enabled: preferences.autofolders,
      failureNotice: 'The autofolders setting could not be changed',
      onNotice,
      setEnabled: (enabled) => setPreference('autofolders', enabled),
    }),
    tabStripOrder: usePreferenceSetting({
      enabled: preferences.syncTabStripOrder,
      failureNotice: 'The tab order setting could not be changed',
      onNotice,
      setEnabled: (enabled) => setPreference('syncTabStripOrder', enabled),
    }),
    timedMessageSetting: useTimedMessageSetting({
      onNotice,
      saved: preferences.timedMessageSeconds,
      save: (seconds) => setPreference('timedMessageSeconds', seconds),
    }),
  };
}

export type SettingsPreferences = ReturnType<typeof useSettingsPreferences>;
