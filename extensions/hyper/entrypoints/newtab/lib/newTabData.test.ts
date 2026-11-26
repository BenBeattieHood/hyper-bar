import { describe, expect, it } from 'vitest';

import type { HyperSidebarProjection } from '../../lib/modelPort';
import { projectNewTabData } from './newTabData';

function tab(id: number, url: string, windowId = 7) {
  return { id, index: 0, url, windowId } as Browser.tabs.Tab;
}

function projection(
  overrides: {
    activeSpaceId?: string;
    media?: Pick<
      HyperSidebarProjection['window'],
      'mediaControlAvailable' | 'mediaRetainedTabId' | 'mediaTarget'
    >;
    spaces?: Array<{ id: string; title: string }>;
    tabOwnerships?: Record<number, { spaceId: string }>;
    tabs?: Browser.tabs.Tab[];
  } = {},
): HyperSidebarProjection {
  return {
    bookmarkTree: [],
    commands: [],
    hyper: { spaces: overrides.spaces ?? [] },
    revision: 1,
    structureHealth: { status: 'healthy' },
    tabOwnerships: {},
    tabs: overrides.tabs ?? [],
    window: {
      activeSpaceId: overrides.activeSpaceId,
      focused: true,
      groupIdsBySpace: {},
      incognito: false,
      mediaControlAvailable: false,
      tabDispositions: {},
      tabOwnerships: overrides.tabOwnerships ?? {},
      tabs: overrides.tabs ?? [],
      windowId: 7,
      ...overrides.media,
    },
  } as unknown as HyperSidebarProjection;
}

describe('projectNewTabData', () => {
  it('takes the window and its spaces from the revision', () => {
    const data = projectNewTabData(
      projection({ activeSpaceId: 's2', spaces: [{ id: 's1', title: 'One' }, { id: 's2', title: 'Two' }] }),
      undefined,
    );
    expect(data.windowId).toBe(7);
    expect(data.activeSpaceId).toBe('s2');
    expect(data.spaces.map((space) => space.id)).toEqual(['s1', 's2']);
  });

  it('falls back to the first space when the active one no longer exists', () => {
    const data = projectNewTabData(
      projection({ activeSpaceId: 'deleted', spaces: [{ id: 's1', title: 'One' }] }),
      undefined,
    );
    expect(data.activeSpaceId).toBe('s1');
  });

  it('reports no active space when there are no spaces at all', () => {
    expect(projectNewTabData(projection(), undefined).activeSpaceId).toBe('');
  });

  it('does not derive a view-owned Search item collection', () => {
    const data = projectNewTabData(
      projection({
        spaces: [{ id: 's1', title: 'One' }],
        tabs: [tab(1, 'https://example.com')],
      }),
      undefined,
    );
    expect('items' in data).toBe(false);
  });

  it.each([
    ['finds the current tab in the window the model reported', [tab(1, 'https://example.com'), tab(2, 'https://other.example')], 2, 2],
    [
      'uses the active projected tab when a normal New Tab has no source id',
      [tab(1, 'https://example.com'), { ...tab(2, 'https://other.example'), active: true }],
      undefined,
      2,
    ],
    ['has no current tab when the model has not seen it', [tab(1, 'https://example.com')], 99, undefined],
  ])('%s', (_name, tabs, sourceTabId, currentTabId) => {
    expect(projectNewTabData(projection({ tabs }), sourceTabId).currentTab?.id).toBe(currentTabId);
  });

  it('carries the committed revision for Search invalidation', () => {
    expect(projectNewTabData(projection(), undefined).revision).toBe(1);
  });

  it('carries the window music state its Search commands are built from', () => {
    const mediaTarget = {
      elementIndex: 0,
      frameId: 0,
      navigationVersion: 1,
      state: 'paused' as const,
      tabId: 3,
      url: 'https://music.example/',
    };
    const data = projectNewTabData(
      projection({ media: { mediaControlAvailable: true, mediaRetainedTabId: 3, mediaTarget } }),
      undefined,
    );
    expect(data).toMatchObject({ mediaControlAvailable: true, mediaRetainedTabId: 3, mediaTarget });
  });

  it('reports no music control until the window has some', () => {
    const data = projectNewTabData(projection(), undefined);
    expect(data.mediaControlAvailable).toBe(false);
    expect(data.mediaRetainedTabId).toBeUndefined();
    expect(data.mediaTarget).toBeUndefined();
  });
});
