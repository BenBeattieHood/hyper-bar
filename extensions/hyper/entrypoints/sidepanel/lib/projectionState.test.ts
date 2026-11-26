import { describe, expect, it } from 'vitest';

import type { HyperSidebarProjection } from '../../lib/modelPort';
import { pageIdentity } from '../../lib/urlIdentity';
import { indexVisibleSpaceIds, projectBrowserState } from './projectionState';

function projection(
  window: Partial<HyperSidebarProjection['window']> = {},
): HyperSidebarProjection {
  return {
    bookmarkImportInProgress: false,
    bookmarkTree: [],
    commands: {},
    hyper: {
      backings: new Map(),
      bookmarks: [],
      favourites: [],
      favouriteSlots: [],
      localBookmarkSpaceIds: [],
      localBookmarksBySpaceId: {},
      spaces: [],
    },
    revision: 1,
    remoteSpacePresence: { bookmarkSpaceIds: {}, otherWindowTabCounts: {}, tabSpaceIds: {} },
    structureHealth: { status: 'healthy' },
    tabOwnerships: {},
    tabs: [],
    window: {
      focused: false,
      groupIdsBySpace: {},
      incognito: false,
      tabDispositions: {},
      tabOwnerships: {},
      tabs: [],
      windowId: 7,
      ...window,
    },
  } as unknown as HyperSidebarProjection;
}

describe('projectBrowserState', () => {
  it('takes window focus from the revision rather than the view', () => {
    expect(projectBrowserState(projection({ focused: true })).currentWindowFocused)
      .toBe(true);
    expect(projectBrowserState(projection({ focused: false })).currentWindowFocused)
      .toBe(false);
  });

  it('takes bookmark import activity from the model projection', () => {
    expect(projectBrowserState({
      ...projection(),
      bookmarkImportInProgress: true,
    }).bookmarkImportInProgress).toBe(true);
  });

  it('reports the groups the model owns for this window', () => {
    const state = projectBrowserState(projection({
      groupIdsBySpace: { 'space-1': 12 },
    }));
    expect(state.spaceGroupIds).toEqual({ 'space-1': 12 });
  });

  it("reports each space's colour from its live groups, and none for a space without one", () => {
    const source = projection();
    source.hyper.spaces = [
      { children: [], colour: 'purple', id: 'space-1', index: 0, title: 'One' },
      { children: [], id: 'space-2', index: 1, title: 'Two' },
    ];
    expect(projectBrowserState(source).spaceColours).toEqual({ 'space-1': 'purple' });
  });

  it('reports no group for a space whose group has gone', () => {
    // Ownership is resolved against the groups that still exist, so a closed
    // group simply stops appearing rather than needing to be forgotten.
    const state = projectBrowserState(projection({
      groupIdsBySpace: {},
    }));
    expect(state.spaceGroupIds).toEqual({});
  });

  it('copies the group maps so later state updates cannot write into the projection', () => {
    const source = projection({ groupIdsBySpace: { 'space-1': 12 } });
    const state = projectBrowserState(source);
    state.spaceGroupIds['space-2'] = 13;
    expect(source.window.groupIdsBySpace).toEqual({ 'space-1': 12 });
  });

  it('merges remote space IDs only for tabs and bookmarks already visible to the view', () => {
    const visibleTab = { id: 12, url: 'https://visible.example' } as Browser.tabs.Tab;
    const visibleBookmark = {
      id: 'visible-bookmark',
      title: 'Saved page',
      url: 'https://saved.example',
    } as Browser.bookmarks.BookmarkTreeNode;
    const index = indexVisibleSpaceIds(
      {
        remoteSpacePresence: {
          bookmarkSpaceIds: {
            'hidden-bookmark': ['hidden-space'],
            'visible-bookmark': ['remote-saved-space'],
          },
          otherWindowTabCounts: {},
          tabSpaceIds: { 12: ['remote-tab-space'], 99: ['hidden-space'] },
        },
        tabSpaceIds: { 12: 'local-space' },
        tabs: [visibleTab],
      },
      [visibleBookmark],
    );

    expect(index.get(pageIdentity(visibleTab.url)!)).toEqual(
      new Set(['local-space', 'remote-tab-space']),
    );
    expect(index.get(pageIdentity(visibleBookmark.url)!)).toEqual(
      new Set(['remote-saved-space']),
    );
    expect(index).toHaveLength(2);
  });
});
