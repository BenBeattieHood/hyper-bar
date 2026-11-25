import { describe, expect, it } from 'vitest';
import {
  resolveRemoteTabTarget,
  spacePageTabIds,
} from './remoteTab';
import { remoteTabSnapshot } from './testFixtures';

const snapshot = remoteTabSnapshot;

describe('resolveRemoteTabTarget', () => {
  it('resolves a unique owned remote tab from a visible local tab', () => {
    expect(resolveRemoteTabTarget(snapshot(), 1, {
      spaceId: 'two',
      source: { kind: 'tab', tabId: 1 },
    })).toMatchObject({ tabId: 2, windowId: 2 });
  });

  it('resolves a visible bookmark without making hidden bookmarks actionable', () => {
    const visible = {
      id: 'visible', index: 0, parentId: 'bookmarks', title: 'Visible', url: 'https://shared.example',
    } as Browser.bookmarks.BookmarkTreeNode;
    const hidden = {
      id: 'hidden', index: 1, parentId: 'bookmarks', title: 'Hidden', url: 'https://shared.example',
    } as Browser.bookmarks.BookmarkTreeNode;
    const base = snapshot();
    const model = snapshot({
      hyper: { ...base.hyper, localBookmarksBySpaceId: { one: [visible] } },
      runtime: { ...base.runtime, activeSpaceIds: { 1: 'one' } },
    });

    expect(resolveRemoteTabTarget(model, 1, {
      source: { bookmarkId: 'visible', kind: 'bookmark' }, spaceId: 'two',
    })?.tabId).toBe(2);
    expect(resolveRemoteTabTarget(model, 1, {
      source: { bookmarkId: hidden.id, kind: 'bookmark' }, spaceId: 'two',
    })).toBeUndefined();
  });

  it('rejects ambiguous or non-owned remote matches', () => {
    const base = snapshot();
    const ambiguous = snapshot({
      browser: {
        ...base.browser,
        tabs: [...base.browser.tabs, {
          id: 3, windowId: 3, url: 'https://shared.example',
        } as Browser.tabs.Tab],
        windows: [...base.browser.windows, {
          id: 3, incognito: false, type: 'normal',
        } as Browser.windows.Window],
      },
      runtime: {
        ...base.runtime,
        tabOwnerships: {
          ...base.runtime.tabOwnerships,
          3: { backingId: 'backing-3', spaceId: 'two' },
        },
      },
      derived: {
        ...base.derived,
        tabDispositions: new Map([
          ...base.derived.tabDispositions,
          [3, { backingId: 'backing-3', spaceId: 'two', status: 'owned' as const }],
        ]),
      },
    });

    expect(resolveRemoteTabTarget(ambiguous, 1, {
      source: { kind: 'tab', tabId: 1 }, spaceId: 'two',
    })).toBeUndefined();
  });
});

describe('spacePageTabIds', () => {
  it('finds every tab the space has for the page, in this window or another', () => {
    const base = snapshot();
    const owned = (tabId: number, spaceId: string) =>
      [tabId, { backingId: `backing-${tabId}`, spaceId, status: 'owned' as const }] as const;
    const model = snapshot({
      browser: {
        ...base.browser,
        tabs: [...base.browser.tabs, ...[
          { id: 3, windowId: 1, url: 'https://shared.example/#top' },
          { id: 4, windowId: 2, url: 'https://other.example' },
          { id: 5, windowId: 2, url: 'https://shared.example' },
          { id: 6, incognito: true, windowId: 2, url: 'https://shared.example' },
          { id: 7, windowId: 2, url: 'https://shared.example' },
        ] as Browser.tabs.Tab[]],
      },
      runtime: {
        ...base.runtime,
        tabOwnerships: {
          ...base.runtime.tabOwnerships,
          3: { backingId: 'backing-3', spaceId: 'two' },
          4: { backingId: 'backing-4', spaceId: 'two' },
          5: { backingId: 'backing-5', spaceId: 'three' },
          6: { backingId: 'backing-6', spaceId: 'two' },
          7: { backingId: 'backing-7', spaceId: 'two' },
        },
      },
      derived: {
        ...base.derived,
        tabDispositions: new Map([
          ...base.derived.tabDispositions,
          // This window's tabs count by ownership, as its own dots do.
          [3, { spaceId: 'two', status: 'pending-recovery' as const }],
          owned(4, 'two'), owned(5, 'three'), owned(6, 'two'),
          [7, { spaceId: 'two', status: 'pending-recovery' as const }],
        ]),
      },
    });
    const request = { source: { kind: 'tab' as const, tabId: 1 }, spaceId: 'two' };

    expect(spacePageTabIds(model, 1, request)).toEqual([2, 3]);
    expect(spacePageTabIds(model, 2, request)).toEqual([]);
    expect(spacePageTabIds(model, 1, { ...request, spaceId: 'one' })).toEqual([]);
  });
});