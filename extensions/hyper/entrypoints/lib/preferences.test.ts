import { describe, expect, it } from 'vitest';
import { parseBookmarkTitle, visibleBookmarkTitle } from './bookmarks';
import {
  defaultHyperPreferences,
  hyperRootTitleWithPreferences,
  legacyStoredPreferences,
  parsePreferencePayload,
  preferencesFromHyperRoot,
} from './preferences';

describe('preferences on the hyper root folder', () => {
  it('keeps the defaults until the user saves a preference', () => {
    expect(defaultHyperPreferences).toEqual({
      autofolders: true,
      bookmarkPanelPercent: 50,
      combineTabsAndBookmarks: false,
      groupFavouritesByDomain: true,
      inPageSidebar: false,
      inPageSidebarWidth: 360,
      pageTextSearch: false,
      showOtherSessions: false,
      syncTabStripOrder: false,
      timedMessageSeconds: 7,
    });
    expect(preferencesFromHyperRoot(undefined)).toEqual(defaultHyperPreferences);
    expect(preferencesFromHyperRoot({ title: 'hyper' })).toEqual(defaultHyperPreferences);
  });

  it('saves a preference beside the root metadata it does not own', () => {
    const title = hyperRootTitleWithPreferences(
      { title: 'hyper {"hyper":{"theme":"blush"},"future":1}' },
      { autofolders: true },
    );

    expect(visibleBookmarkTitle({ title })).toBe('hyper');
    expect(parseBookmarkTitle(title).metadata).toEqual({
      future: 1,
      hyper: { preferences: { autofolders: true }, theme: 'blush' },
    });
    expect(preferencesFromHyperRoot({ title }).autofolders).toBe(true);
  });

  it('keeps preferences it does not know, so an older Hyper never drops a newer one', () => {
    const title = hyperRootTitleWithPreferences(
      { title: 'hyper {"hyper":{"preferences":{"inPageSidebar":true,"later":"kept"}}}' },
      { autofolders: true },
    );

    expect(parseBookmarkTitle(title).metadata).toEqual({
      hyper: { preferences: { autofolders: true, inPageSidebar: true, later: 'kept' } },
    });
  });

  it('falls back to the default for a malformed saved value', () => {
    expect(preferencesFromHyperRoot({
      title: 'hyper {"hyper":{"preferences":{"autofolders":"yes","inPageSidebar":true}}}',
    })).toEqual({ ...defaultHyperPreferences, inPageSidebar: true });
    expect(preferencesFromHyperRoot({ title: 'hyper {"hyper":{"preferences":[true]}}' }))
      .toEqual(defaultHyperPreferences);
  });

  it('reads the in-page sidebar width as whole pixels within its bounds', () => {
    const width = (saved: unknown) => preferencesFromHyperRoot({
      title: `hyper ${JSON.stringify({ hyper: { preferences: { inPageSidebarWidth: saved } } })}`,
    }).inPageSidebarWidth;

    expect(width(480.6)).toBe(481);
    expect(width(20)).toBe(38);
    expect(width(5_000)).toBe(1200);
    expect(width('wide')).toBe(360);
    expect(parsePreferencePayload({ key: 'inPageSidebarWidth', value: 500 }))
      .toEqual({ inPageSidebarWidth: 500 });
    expect(() => parsePreferencePayload({ key: 'inPageSidebarWidth', value: true })).toThrow();
    expect(() => parsePreferencePayload({ key: 'inPageSidebar', value: 500 })).toThrow();
  });

  it.each([
    ['the bookmark panel split as a whole percentage that leaves both panels room', 'bookmarkPanelPercent', [[33.4, 33], [95, 80], [0, 20]], '50%'],
    ['the timed message duration as whole seconds from fast to relaxed', 'timedMessageSeconds', [[9.6, 10], [1, 3], [60, 15]], '7s'],
  ] as const)('reads %s', (_name, key, clamps, invalid) => {
    for (const [value, clamped] of clamps) expect(parsePreferencePayload({ key, value })).toEqual({ [key]: clamped });
    expect(() => parsePreferencePayload({ key, value: invalid })).toThrow();
  });

  it('reads a saved timed message duration from the hyper root', () => {
    expect(preferencesFromHyperRoot({
      title: 'hyper {"hyper":{"preferences":{"timedMessageSeconds":12}}}',
    }).timedMessageSeconds).toBe(12);
  });

  it('accepts only a known preference with a value of its type', () => {
    expect(parsePreferencePayload({ key: 'autofolders', value: true }))
      .toEqual({ autofolders: true });
    for (const payload of [
      { key: 'autofolders', value: 'none' },
      { key: 'toString', value: true },
      { key: 'theme', value: true },
      null,
      'autofolders',
    ]) {
      expect(() => parsePreferencePayload(payload)).toThrow('The preference value is invalid.');
    }
  });
});

describe('legacy local preferences', () => {
  it('reads each key exactly as earlier versions did and leaves absent keys unset', () => {
    expect(legacyStoredPreferences({})).toEqual({});
    expect(legacyStoredPreferences({ hyperTabFolderMode: 'autofolders' }))
      .toEqual({ autofolders: true });
    expect(legacyStoredPreferences({ hyperTabFolderMode: 'folders' }))
      .toEqual({ autofolders: false });
    expect(legacyStoredPreferences({ hyperTabFolderMode: 'none' }))
      .toEqual({ autofolders: false });
    expect(legacyStoredPreferences({ hyperCombineTabsAndBookmarks: false }))
      .toEqual({ combineTabsAndBookmarks: false });
    expect(legacyStoredPreferences({ hyperCombineTabsAndBookmarks: 'unexpected' }))
      .toEqual({ combineTabsAndBookmarks: true });
    expect(legacyStoredPreferences({ hyperInPageSidebar: true }))
      .toEqual({ inPageSidebar: true });
  });
});
