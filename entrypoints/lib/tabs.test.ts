import { describe, expect, it, vi } from 'vitest';
import type { BrowserTab, Space } from './bookmarks';
import {
  currentTabContents,
  tabContentRefreshIds,
  type TabContentSnapshots,
} from './tabContent';
import {
  bookmarkTitleForTab,
  advanceTabGeneration,
  canCloseOtherTab,
  canSyncBookmarkTitleFromTab,
  cleanupRestoredTabsInWindow,
  isPlaceholderTabTitle,
  closeTabOrWindow,
  closeOtherTabsConditionally,
  closeTabsConcurrently,
  findReusableTab,
  findTabTargetSpace,
  focusTabInWindow,
  isBlankTabPage,
  isHistoryNavigationCommit,
  isCurrentSpaceRestoreCandidate,
  moveTabsPreservingActive,
  pendingTabOperationIsCurrent,
  recentOpenTabs,
  restoredTabCleanupPlan,
  retainRecentEntries,
  sameNavigationUrl,
  spaceTabActivationTarget,
  tabGenerationsAreCurrent,
  tabWithBackingToken,
  tabDisplayTitle,
  tabDisplayUrl,
  tabVisibleBookmarkState,
  resolveSpaceRestoreGroup,
  spaceRestoreCandidates,
  tabsInBrowsingContext,
  unplacedTabIds,
  waitForRestoredTabGroup,
  waitForStableTabSnapshot,
} from './tabs';
import {
  createEffectFence,
  createTargetLedger,
  SupersededTargetError,
  tabTarget,
  windowTarget,
} from './modelGuards';
import { tabsOwnedBySpace } from './tabOwnership';
import { testTab } from './testFixtures';
import { normaliseUrl } from './urlIdentity';

const fakeClock = () => {
  const clock = {
    elapsed: 0,
    now: () => clock.elapsed,
    wait: async (durationMs: number) => {
      clock.elapsed += durationMs;
    },
  };
  return clock;
};

const tab = (id: number, incognito: boolean): BrowserTab => testTab({
  id,
  incognito,
  index: id,
  windowId: incognito ? 2 : 1,
});

describe('tab display metadata', () => {
  it('uses pending navigation metadata before the current URL', () => {
    const navigating = {
      ...tab(1, false),
      title: '   ',
      pendingUrl: 'https://next.example/',
      url: 'https://current.example/',
    };

    expect(tabDisplayTitle(navigating)).toBe('https://next.example/');
    expect(tabDisplayUrl(navigating)).toBe('https://next.example/');
  });

  it('supports context-specific title fallbacks', () => {
    const untitled = { ...tab(1, false), title: '', url: undefined };

    expect(tabDisplayTitle(untitled)).toBe('Untitled tab');
    expect(tabDisplayTitle(untitled, 'Playing audio')).toBe('Playing audio');
    expect(tabDisplayUrl(untitled)).toBe('');
  });
});

describe('recent open tabs', () => {
  it('returns at most twenty current-window user tabs in descending recency', () => {
    // Recency runs against strip order, so the result cannot pass on the index tiebreak alone.
    const tabs = Array.from({ length: 24 }, (_, index) => testTab({
      id: index + 1,
      active: index === 0,
      index,
      lastAccessed: (24 - index) * 10,
      url: `https://example.com/${index}`,
      windowId: 1,
    }));
    tabs.push(testTab({
      id: 100,
      index: 24,
      lastAccessed: 1_000,
      url: 'chrome-extension://hyper/sidepanel.html',
      windowId: 1,
    }));
    tabs.push(testTab({
      id: 101,
      index: 0,
      lastAccessed: 2_000,
      url: 'https://other-window.example/',
      windowId: 2,
    }));

    expect(recentOpenTabs(tabs, 1, 'chrome-extension://hyper/').map((item) => item.id))
      .toEqual(Array.from({ length: 20 }, (_, index) => index + 2));
  });
});

describe('closeTabOrWindow', () => {
  const closeApi = (liveTab: { id: number } | undefined, windowTabIds: number[]) => ({
    tabs: {
      get: vi.fn(async () => liveTab ?? Promise.reject(new Error('No tab with id: 7'))),
      query: vi.fn(async () => windowTabIds.map((id) => ({ id }))),
      remove: vi.fn(async () => undefined),
    },
    windows: { remove: vi.fn(async () => undefined) },
  });

  it('closes the window instead of replacing its final tab', async () => {
    const api = closeApi(undefined, [7]);

    await closeTabOrWindow(7, 3, api);

    expect(api.windows.remove).toHaveBeenCalledWith(3);
    expect(api.tabs.remove).not.toHaveBeenCalled();
  });

  it('keeps the window when another tab is present', async () => {
    const api = closeApi(undefined, [7, 8]);

    await closeTabOrWindow(7, 3, api);

    expect(api.tabs.remove).toHaveBeenCalledWith(7);
    expect(api.windows.remove).not.toHaveBeenCalled();
  });

  it('rejects when the browser reports success but the tab remains open', async () => {
    await expect(closeTabOrWindow(7, 3, closeApi({ id: 7 }, [7, 8]))).rejects.toThrow(
      'The browser did not close the requested tab.',
    );
  });
});

describe('closeTabsConcurrently', () => {
  it('starts every unique tab close before waiting for completion', async () => {
    const resolvers = new Map<number, () => void>();
    const closeTab = vi.fn((tabId: number) => new Promise<void>((resolve) => {
      resolvers.set(tabId, resolve);
    }));

    const closing = closeTabsConcurrently([7, 8, 7, 9], closeTab);
    await vi.waitFor(() => expect(closeTab).toHaveBeenCalledTimes(3));
    expect(closeTab.mock.calls.map(([tabId]) => tabId)).toEqual([7, 8, 9]);

    for (const resolve of resolvers.values()) resolve();
    await expect(closing).resolves.toBeUndefined();
  });

  it('waits for sibling closes before rethrowing the first failure', async () => {
    let finishSecondClose: (() => void) | undefined;
    const failure = new Error('close failed');
    const closeTab = vi.fn((tabId: number) => tabId === 7
      ? Promise.reject(failure)
      : new Promise<void>((resolve) => {
          finishSecondClose = resolve;
        }));

    const closing = closeTabsConcurrently([7, 8], closeTab);
    let settled = false;
    void closing.catch(() => undefined).then(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(closeTab).toHaveBeenCalledTimes(2));
    expect(settled).toBe(false);

    finishSecondClose?.();
    await expect(closing).rejects.toBe(failure);
  });
});

describe('closeOtherTabsConditionally', () => {
  it('rechecks every old target and preserves pinned, active, moved, and kept tabs', async () => {
    const tabs = new Map<number, BrowserTab>([
      [6, testTab({ id: 6, pinned: false, windowId: 3 })],
      [7, testTab({ id: 7, pinned: false, windowId: 3 })],
      [8, testTab({ id: 8, pinned: true, windowId: 3 })],
      [9, testTab({ active: true, id: 9, pinned: false, windowId: 3 })],
      [10, testTab({ id: 10, pinned: false, windowId: 4 })],
    ]);
    const close = vi.fn(async () => undefined);

    await closeOtherTabsConditionally(
      [6, 7, 8, 9, 10, 6],
      { keepTabId: 7, windowId: 3 },
      async (tabId) => tabs.get(tabId),
      close,
    );

    expect(close).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledWith(6, 3);
    expect(canCloseOtherTab(testTab({ active: true, id: 6, windowId: 3 }), {
      keepTabId: 7,
      windowId: 3,
    })).toBe(false);
  });
});

describe('tabVisibleBookmarkState', () => {
  const bookmark = {
    id: 'bookmark',
    syncing: false,
    title: 'Reference',
    url: 'https://www.example.com/reference',
  };

  it('distinguishes absent and current visible bookmarks', () => {
    expect(tabVisibleBookmarkState(undefined, bookmark.url)).toBe('none');
    expect(tabVisibleBookmarkState(bookmark, 'https://www.example.com/reference'))
      .toBe('bookmarked');
  });

  it('requires an update after exact navigation state changes', () => {
    expect(tabVisibleBookmarkState(
      bookmark,
      'https://www.example.com/reference/',
    )).toBe('update');
    expect(tabVisibleBookmarkState(
      bookmark,
      'https://www.example.com/reference?view=latest',
    )).toBe('update');
    expect(tabVisibleBookmarkState(
      bookmark,
      'https://www.example.com/reference#details',
    )).toBe('update');
  });
});

describe('tabWithBackingToken', () => {
  it('selects the live tab matching the remembered backing token', () => {
    const tabs = [tab(1, false), tab(2, false)];

    expect(tabWithBackingToken(tabs, {
      1: { spaceId: 'space', backingToken: 'first' },
      2: { spaceId: 'space', backingToken: 'remembered' },
    }, 'remembered')?.id).toBe(2);
  });

  it('does not select a fallback for a stale token', () => {
    expect(tabWithBackingToken([tab(1, false)], {
      1: { spaceId: 'space', backingToken: 'first' },
    }, 'missing')).toBeUndefined();
  });
});

describe('spaceTabActivationTarget', () => {
  it('prefers the live active tab during automatic reconciliation', () => {
    const remembered = tab(1, false);
    const active = { ...tab(2, false), active: true };
    const ownerships = {
      1: { spaceId: 'space', backingToken: 'remembered' },
      2: { spaceId: 'space', backingToken: 'active' },
    };

    expect(spaceTabActivationTarget(
      [remembered, active],
      ownerships,
      'remembered',
      true,
    )?.id).toBe(2);
    expect(spaceTabActivationTarget(
      [remembered, active],
      ownerships,
      'remembered',
      false,
    )?.id).toBe(1);
  });

  it('uses the first ordered tab when explicit activation has no remembered match', () => {
    const first = tab(1, false);
    const incidentallyActive = { ...tab(2, false), active: true };

    expect(spaceTabActivationTarget(
      [first, incidentallyActive],
      {
        1: { spaceId: 'space', backingToken: 'first' },
        2: { spaceId: 'space', backingToken: 'second' },
      },
      'missing',
      false,
    )?.id).toBe(1);
  });
});

describe('focusTabInWindow', () => {
  const focusApi = (tabs: Record<string, unknown> = {}) => ({
    tabs: { ...tabs, update: vi.fn().mockResolvedValue(undefined) },
    windows: { update: vi.fn().mockResolvedValue(undefined) },
  });

  it('activates a same-window duplicate without refocusing the window', async () => {
    const api = focusApi();

    await expect(focusTabInWindow(22, 4, 4, api)).resolves.toBe(true);

    expect(api.tabs.update).toHaveBeenCalledWith(22, { active: true });
    expect(api.windows.update).not.toHaveBeenCalled();
  });

  it('activates a cross-window duplicate before focusing its window', async () => {
    const api = focusApi();

    await expect(focusTabInWindow(22, 8, 4, api)).resolves.toBe(true);

    expect(api.tabs.update).toHaveBeenCalledWith(22, { active: true });
    expect(api.windows.update).toHaveBeenCalledWith(8, { focused: true });
    expect(api.tabs.update.mock.invocationCallOrder[0]!).toBeLessThan(
      api.windows.update.mock.invocationCallOrder[0]!,
    );
  });

  it('revalidates before focusing a cross-window duplicate', async () => {
    const api = focusApi();
    const canFocusWindow = vi.fn().mockResolvedValue(false);

    await expect(focusTabInWindow(22, 8, 4, api, canFocusWindow)).resolves.toBe(false);

    expect(canFocusWindow).toHaveBeenCalledOnce();
    expect(api.tabs.update).not.toHaveBeenCalled();
    expect(api.windows.update).not.toHaveBeenCalled();
  });

  it('restores the prior active tab when the target moves during activation', async () => {
    const api = focusApi({
      get: vi.fn().mockResolvedValue({ id: 22, windowId: 9 }),
      query: vi.fn().mockResolvedValue([{ id: 31, windowId: 8 }, { id: 41, windowId: 9 }]),
    });
    const canFocusWindow = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    await expect(focusTabInWindow(22, 8, 4, api, canFocusWindow)).resolves.toBe(false);

    expect(api.tabs.update).toHaveBeenNthCalledWith(1, 22, { active: true });
    expect(api.tabs.update).toHaveBeenNthCalledWith(2, 41, { active: true });
    expect(api.windows.update).not.toHaveBeenCalled();
  });
});

describe('moveTabsPreservingActive', () => {
  /** The active tab before the move and, if given, a different one after it. */
  const moveApi = (activeId: number | undefined, activeAfterId?: number) => {
    const active = (id: number | undefined) => id === undefined ? [] : [{ id }];
    const query = vi.fn().mockResolvedValue(active(activeId));
    if (activeAfterId !== undefined) query.mockResolvedValueOnce(active(activeId)).mockResolvedValueOnce(active(activeAfterId));
    return {
      tabs: { move: vi.fn().mockResolvedValue(undefined), query, update: vi.fn().mockResolvedValue(undefined) },
    };
  };
  const fence = (...targets: Parameters<typeof createEffectFence>[2]) => {
    const ledger = createTargetLedger();
    return { effects: createEffectFence(ledger, 'move-1', targets), ledger };
  };

  it('reactivates the current tab after moving tabs', async () => {
    const api = moveApi(22);

    await moveTabsPreservingActive([24, 22, 23], 4, 7, api);

    expect(api.tabs.query).toHaveBeenCalledWith({ active: true, windowId: 4 });
    expect(api.tabs.move).toHaveBeenCalledWith([24, 22, 23], { index: 7, windowId: 4 });
    expect(api.tabs.update).toHaveBeenCalledWith(22, { active: true });
    expect(api.tabs.move.mock.invocationCallOrder[0]!).toBeLessThan(
      api.tabs.update.mock.invocationCallOrder[0]!,
    );
  });

  it('does not invent an active tab when the window has none', async () => {
    const api = moveApi(undefined);

    await moveTabsPreservingActive(24, 4, 7, api);

    expect(api.tabs.update).not.toHaveBeenCalled();
  });

  it('does not overwrite a newer active tab after the move settles', async () => {
    const api = moveApi(22, 31);

    await moveTabsPreservingActive([24, 22, 23], 4, 7, api);

    expect(api.tabs.update).not.toHaveBeenCalled();
  });

  it('restores the active tab when the move itself activates a moved tab', async () => {
    const api = moveApi(22, 24);

    await moveTabsPreservingActive([24, 23], 4, 7, api);

    expect(api.tabs.update).toHaveBeenCalledWith(22, { active: true });
  });

  it('cancels restoration at the final continuation check', async () => {
    const api = moveApi(22);
    const shouldContinue = vi.fn()
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true)
      .mockReturnValue(false);

    await moveTabsPreservingActive([24, 23], 4, 7, api, shouldContinue);

    expect(api.tabs.query).toHaveBeenCalledTimes(2);
    expect(api.tabs.update).not.toHaveBeenCalled();
  });

  it('moves and reactivates under a fence when nothing is superseded', async () => {
    const { effects } = fence(tabTarget(24), tabTarget(22), windowTarget(4));
    const api = moveApi(22);

    await moveTabsPreservingActive([24, 22], 4, 7, api, undefined, effects);

    expect(api.tabs.move).toHaveBeenCalledWith([24, 22], { index: 7, windowId: 4 });
    expect(api.tabs.update).toHaveBeenCalledWith(22, { active: true });
  });

  it('does not move when an external change superseded a fenced tab', async () => {
    const { effects, ledger } = fence(tabTarget(24), tabTarget(22), windowTarget(4));
    const api = moveApi(22);
    // An external actor changes one of the tabs after the command was admitted.
    ledger.observe(tabTarget(24), 'moved');

    await expect(moveTabsPreservingActive([24, 22], 4, 7, api, undefined, effects))
      .rejects.toBeInstanceOf(SupersededTargetError);

    expect(api.tabs.move).not.toHaveBeenCalled();
    expect(api.tabs.update).not.toHaveBeenCalled();
  });

  it('declares the move it causes so the resulting event is expected, not external', async () => {
    const { effects, ledger } = fence(tabTarget(24));

    await moveTabsPreservingActive(24, 4, 7, moveApi(undefined), undefined, effects);

    // The onAttached observation the move produces matches the declaration and
    // does not bump the target, so a concurrent plan fenced on it is not
    // superseded by Hyper's own move. A second, undeclared move is external.
    expect(ledger.observe(tabTarget(24), 'moved')).toBe('expected');
    expect(ledger.observe(tabTarget(24), 'moved')).toBe('external');
  });

  it('does not reactivate when a fenced target is superseded during the move', async () => {
    const { effects, ledger } = fence(tabTarget(24), windowTarget(4));
    const api = moveApi(22);
    api.tabs.move.mockImplementation(async () => {
      // The destination window changes externally while the move is in flight.
      ledger.observe(windowTarget(4), 'updated');
    });

    await expect(moveTabsPreservingActive([24], 4, 7, api, undefined, effects))
      .rejects.toBeInstanceOf(SupersededTargetError);

    expect(api.tabs.move).toHaveBeenCalledTimes(1);
    expect(api.tabs.update).not.toHaveBeenCalled();
  });
});

describe('unplacedTabIds', () => {
  const origin = 'chrome-extension://hyper/';
  const windowTab = (id: number, url: string, extra: Partial<BrowserTab> = {}) =>
    testTab({ id, index: id, url, windowId: 2, ...extra });

  it('counts a tab dragged in from another window until it is placed here', () => {
    const tabs = [
      windowTab(1, 'https://example.com/placed'),
      windowTab(2, 'https://example.com/arriving'),
      windowTab(3, 'https://example.com/new'),
      windowTab(4, 'https://example.com/pinned', { pinned: true }),
      windowTab(5, `${origin}newtab.html`),
    ];
    const ownerships = {
      1: { spaceId: 'work', windowId: 2 },
      2: { spaceId: 'work', windowId: 1 },
    };

    expect(unplacedTabIds(tabs, ownerships, origin)).toEqual([3, 2]);
    expect(unplacedTabIds(tabs.slice(0, 1), ownerships, origin)).toEqual([]);
  });
});

describe('tabsInBrowsingContext', () => {
  it('keeps regular and private tab state isolated', () => {
    const tabs = [tab(1, false), tab(2, true), tab(3, false)];

    expect(tabsInBrowsingContext(tabs, false).map(({ id }) => id)).toEqual([1, 3]);
    expect(tabsInBrowsingContext(tabs, true).map(({ id }) => id)).toEqual([2]);
  });

  it('never persists private tab titles into synced bookmarks', () => {
    const regular = { ...tab(1, false), title: 'Account overview' };
    const privateTab = { ...tab(2, true), title: 'Private account overview' };

    expect(canSyncBookmarkTitleFromTab(regular)).toBe(true);
    expect(canSyncBookmarkTitleFromTab(privateTab)).toBe(false);
    expect(bookmarkTitleForTab(regular, 'https://example.com/account')).toBe(
      'Account overview',
    );
    expect(bookmarkTitleForTab(privateTab, 'https://example.com/account')).toBe(
      'https://example.com/account',
    );
    expect(bookmarkTitleForTab(tab(3, false), 'https://example.com/account')).toBe(
      'https://example.com/account',
    );
  });
});

describe('isPlaceholderTabTitle', () => {
  const url = 'https://www.example.com/docs/a%20b?q=1#top';

  it('recognises the blank, address and host titles the browser makes up', () => {
    for (const title of [
      undefined,
      ' ',
      url,
      'example.com',
      'www.example.com',
      'example.com/docs/a b',
      'www.example.com/docs/a%20b?q=1',
    ]) {
      expect(isPlaceholderTabTitle(title, url)).toBe(true);
    }
  });

  it('accepts a title the page gave itself', () => {
    expect(isPlaceholderTabTitle('Docs', url)).toBe(false);
    expect(isPlaceholderTabTitle('example.org', url)).toBe(false);
    expect(isPlaceholderTabTitle('Docs', undefined)).toBe(false);
  });
});

describe('spaceRestoreCandidates', () => {
  it('includes tabs Chrome restored after the original window snapshot', () => {
    const originalTabs = [{ ...tab(1, false), groupId: 9 }];
    const restoredTabs = [...originalTabs, { ...tab(2, false), groupId: 9 }];

    expect(spaceRestoreCandidates(restoredTabs, {}, {
      claimUnowned: false,
      groupId: 9,
      spaceId: 'green',
      windowId: 1,
    }).map(({ id }) => id)).toEqual([1, 2]);
  });

  it('waits for Chrome-restored group tabs to stop materializing', async () => {
    const snapshots = [
      [{ ...tab(1, false), groupId: 9, url: 'https://example.com/one' }],
      [
        { ...tab(1, false), groupId: 9, url: 'https://example.com/one' },
        { ...tab(2, false), groupId: 9, url: 'https://example.com/two' },
      ],
    ];
    const clock = fakeClock();

    const settled = await waitForStableTabSnapshot(
      async () => snapshots[Math.min(clock.elapsed / 50, snapshots.length - 1)]!,
      { ...clock, pollIntervalMs: 50, quietPeriodMs: 100, timeoutMs: 500 },
    );

    expect(settled.map(({ id }) => id)).toEqual([1, 2]);
    expect(clock.elapsed).toBe(150);
  });

  it('waits for a native group that appears after the initial startup snapshot', async () => {
    const clock = fakeClock();
    const queryTabs = vi.fn(async () => [{ ...tab(1, false), groupId: clock.elapsed >= 100 ? 9 : -1 }]);

    const groupId = await waitForRestoredTabGroup(
      queryTabs,
      async (tabs) => tabs.find((candidate) => candidate.groupId >= 0)?.groupId,
      { ...clock, pollIntervalMs: 50, timeoutMs: 500 },
    );

    expect(groupId).toBe(9);
    expect(clock.elapsed).toBe(100);
    expect(queryTabs).toHaveBeenCalledTimes(3);
  });

  it('stops waiting for a native group when recovery is superseded', async () => {
    const clock = fakeClock();
    const queryTabs = vi.fn(async () => [{ ...tab(1, false), groupId: -1 }]);

    await expect(waitForRestoredTabGroup(
      queryTabs,
      async () => undefined,
      { ...clock, shouldContinue: () => clock.elapsed < 50 },
    )).resolves.toBeUndefined();

    expect(clock.elapsed).toBe(50);
    expect(queryTabs).toHaveBeenCalledOnce();
  });

  it('stops waiting when a newer space activation supersedes the restore', async () => {
    const clock = fakeClock();
    const settled = await waitForStableTabSnapshot(
      async () => [{ ...tab(1, false), groupId: 9 }],
      { ...clock, shouldContinue: () => clock.elapsed < 50 },
    );

    expect(settled.map(({ id }) => id)).toEqual([1]);
    expect(clock.elapsed).toBe(50);
  });
});

describe('tab operation generations', () => {
  it('never reuses a stale generation when a native tab ID is reused', () => {
    const generations = new Map<number, number>();
    const staleUpdate = advanceTabGeneration(generations, 42);

    advanceTabGeneration(generations, 42);
    const replacement = advanceTabGeneration(generations, 42);

    expect(staleUpdate).toBe(1);
    expect(replacement).toBe(3);
    expect(generations.get(42)).not.toBe(staleUpdate);
  });

  it('rejects a delayed operation after either native tab ID is reused', () => {
    const generations = new Map([[41, 3], [42, 7]]);

    expect(tabGenerationsAreCurrent(generations, [[41, 3], [42, 7]]))
      .toBe(true);
    advanceTabGeneration(generations, 41);
    expect(tabGenerationsAreCurrent(generations, [[41, 3], [42, 7]]))
      .toBe(false);
    advanceTabGeneration(generations, 42);
    expect(tabGenerationsAreCurrent(generations, [[41, 4], [42, 7]]))
      .toBe(false);
  });

  it('rejects a delayed operation replaced while browser state is read', () => {
    const expected = {};
    const pending = new Map<number, object>([[41, expected]]);
    const generations = new Map([[41, 3], [42, 7]]);
    const expectedGenerations = [[41, 3], [42, 7]] as const;

    expect(pendingTabOperationIsCurrent(
      pending,
      41,
      expected,
      generations,
      expectedGenerations,
    )).toBe(true);

    pending.set(41, {});

    expect(pendingTabOperationIsCurrent(
      pending,
      41,
      expected,
      generations,
      expectedGenerations,
    )).toBe(false);
  });

  it('drops the oldest lifecycle entries once the retention limit is exceeded', () => {
    const generations = new Map<number, number>();
    for (let tabId = 1; tabId <= 5; tabId += 1) {
      advanceTabGeneration(generations, tabId);
    }

    retainRecentEntries(generations, 3);

    expect([...generations.keys()]).toEqual([3, 4, 5]);
  });

  it('treats an evicted lifecycle entry as stale rather than current', () => {
    const generations = new Map<number, number>();
    const generation = advanceTabGeneration(generations, 1);
    advanceTabGeneration(generations, 2);

    retainRecentEntries(generations, 1);

    expect(tabGenerationsAreCurrent(generations, [[1, generation]])).toBe(false);
  });

  it('leaves a map within the retention limit untouched', () => {
    const generations = new Map([[1, 1], [2, 1]]);

    retainRecentEntries(generations, 2);

    expect([...generations.keys()]).toEqual([1, 2]);
  });
});

describe('restoredTabCleanupPlan', () => {
  const newTabUrl = 'chrome-extension://hyper/newtab.html';
  const blank = (id: number) => ({ ...tab(id, false), url: 'about:blank' });
  const ready = (id: number) => ({ ...tab(id, true), url: 'https://example.test/ready' });

  it('does not create a replacement when a real tab appears after the startup snapshot', () => {
    expect(restoredTabCleanupPlan([blank(1), ready(2)], new Set([1]), newTabUrl))
      .toEqual({ createReplacement: false, removableTabIds: [1] });
  });

  it('does not remove a startup candidate that has since navigated', () => {
    expect(restoredTabCleanupPlan([ready(1)], new Set([1]), newTabUrl))
      .toEqual({ createReplacement: false, removableTabIds: [] });
  });

  /** Cleans window 4, whose startup candidate is tab 1, reading the given snapshots in turn. */
  const cleanup = async (secondSnapshot: BrowserTab[], create: () => Promise<BrowserTab>, generations: Map<number, number>) => {
    const api = {
      create: vi.fn(create),
      query: vi.fn().mockResolvedValueOnce([blank(1)]).mockResolvedValueOnce(secondSnapshot),
      remove: vi.fn().mockResolvedValue(undefined),
    };
    await cleanupRestoredTabsInWindow(4, new Map([[1, 1]]), newTabUrl, api, (tabId) => generations.get(tabId));
    return api;
  };

  it('revalidates startup candidates after creating a replacement tab', async () => {
    const api = await cleanup([{ ...ready(1), incognito: false }, blank(2)], async () => blank(2), new Map([[1, 1]]));

    expect(api.create).toHaveBeenCalledWith({ active: false, windowId: 4 });
    expect(api.query).toHaveBeenCalledTimes(2);
    expect(api.remove).not.toHaveBeenCalled();
  });

  it('does not remove a blank tab that reused a startup candidate ID', async () => {
    const generations = new Map([[1, 1]]);
    const api = await cleanup([blank(1), blank(2)], async () => {
      generations.set(1, 3);
      return blank(2);
    }, generations);

    expect(api.remove).not.toHaveBeenCalled();
  });
});

describe('space restore group resolution', () => {
  // Problem A is paired with the startup timeout test below. Navigation must be
  // allowed to restore after observing its group without weakening Problem B's guard.
  it('allows missing-tab restoration when navigation observes the existing group', async () => {
    const queryTabs = vi.fn(async () => [{ ...tab(1, false), groupId: 9 }]);

    await expect(resolveSpaceRestoreGroup(
      [{ ...tab(1, false), groupId: 9 }],
      async (tabs) => tabs.find((candidate) => candidate.groupId === 9)?.groupId,
      queryTabs,
      { awaitsRestoredTab: async () => true, recoverGroup: false },
    )).resolves.toEqual({ canRestore: true, groupId: 9 });

    expect(queryTabs).not.toHaveBeenCalled();
  });

  // Problem B is paired with the navigation test above. Startup must fail closed
  // rather than recreate every backing when the native group cannot yet be observed.
  it('blocks missing-tab restoration when startup group recovery times out', async () => {
    const clock = fakeClock();

    await expect(resolveSpaceRestoreGroup(
      [{ ...tab(1, false), groupId: -1 }],
      async () => undefined,
      async () => [{ ...tab(1, false), groupId: -1 }],
      { ...clock, awaitsRestoredTab: async () => true, pollIntervalMs: 50, recoverGroup: true, timeoutMs: 100 },
    )).resolves.toEqual({ canRestore: false, groupId: undefined });

    expect(clock.elapsed).toBe(100);
  });

  // A closed tab's backing lives until its release, which queues behind this wait.
  it('does not wait for a group when every backing in the window is closing', async () => {
    const queryTabs = vi.fn(async () => [{ ...tab(1, false), groupId: -1 }]);

    await expect(resolveSpaceRestoreGroup(
      [{ ...tab(1, false), groupId: -1 }],
      async () => undefined,
      queryTabs,
      { awaitsRestoredTab: async () => false, recoverGroup: true },
    )).resolves.toEqual({ canRestore: true, groupId: undefined });

    expect(queryTabs).not.toHaveBeenCalled();
  });

  it('stops waiting for a group once the last awaited tab is closed', async () => {
    const clock = fakeClock();

    await expect(resolveSpaceRestoreGroup(
      [{ ...tab(1, false), groupId: -1 }],
      async () => undefined,
      async () => [{ ...tab(1, false), groupId: -1 }],
      { ...clock, awaitsRestoredTab: async () => clock.elapsed < 100, pollIntervalMs: 50, recoverGroup: true, timeoutMs: 5_000 },
    )).resolves.toEqual({ canRestore: true, groupId: undefined });

    expect(clock.elapsed).toBe(100);
  });
});

describe('current restore candidates', () => {
  it('includes a recovered group tab that appeared after candidate IDs were captured', () => {
    const lateTab = { ...tab(2, false), groupId: 9 };

    expect(isCurrentSpaceRestoreCandidate(lateTab, 1, new Set([1]), 9)).toBe(true);
    expect(isCurrentSpaceRestoreCandidate(
      { ...lateTab, groupId: 10 },
      1,
      new Set([1]),
      9,
    )).toBe(false);
  });
});

describe('findReusableTab', () => {
  const docs = 'https://example.com/docs';
  const docsTab = (id: number, extra: Partial<BrowserTab> = {}) =>
    ({ ...tab(id, extra.incognito ?? false), url: docs, ...extra });
  const tabs = [
    docsTab(1, { windowId: 2, active: true }),
    docsTab(2, { windowId: 1 }),
    docsTab(3, { incognito: true, windowId: 1, active: true }),
  ];
  const reuse = (candidates: BrowserTab[], scope: 'browser' | 'window', url = docs) =>
    findReusableTab(candidates, url, { incognito: false, windowId: 1 }, scope)?.id;

  it('reuses browser-wide or within the receiving window, never across private context', () => {
    expect(reuse(tabs, 'browser')).toBe(1);
    expect(reuse(tabs, 'window')).toBe(2);
    expect(reuse([tabs[0]!, tabs[2]!], 'window')).toBeUndefined();
    expect(reuse(tabs, 'browser', 'https://example.com/other')).toBeUndefined();
  });

  it('prefers a live match and then falls back to a discarded match', () => {
    const discarded = docsTab(4, { discarded: true });

    expect(reuse([discarded, docsTab(5)], 'browser')).toBe(5);
    expect(reuse([discarded], 'browser')).toBe(4);
  });

  it('does not reuse a Google search when any query parameter differs', () => {
    const existingUrl = 'https://www.google.com/search?q=what+is+apollo+graphql+readfragment&oq=what+is+apollo+graphql+readfragment';
    const requestedUrl = 'https://www.google.com/search?q=what+is+apollo+graphql+readfragment&oq=what+is+best+react+library';

    expect(reuse([docsTab(4, { url: existingUrl })], 'browser', normaliseUrl(requestedUrl)!)).toBeUndefined();
  });

  it('reuses another window only when ownership matches the destination space', () => {
    const reusable = tabsOwnedBySpace(
      [docsTab(10, { windowId: 1 }), docsTab(11, { windowId: 2, active: true }), docsTab(12, { windowId: 3, active: true })],
      { 10: { spaceId: 'blue' }, 11: { spaceId: 'green' }, 12: { spaceId: 'blue' } },
      'green',
    );

    expect(reuse(reusable, 'browser')).toBe(11);
  });
});

describe('isBlankTabPage', () => {
  const hyperNewTabUrl = 'chrome-extension://hyper/newtab.html';

  it('recognises Hyper and browser-native blank tab pages', () => {
    expect(isBlankTabPage(`${hyperNewTabUrl}?source=browser#focus`, hyperNewTabUrl)).toBe(true);
    expect(isBlankTabPage('about:blank', hyperNewTabUrl)).toBe(true);
    expect(isBlankTabPage('about:newtab', hyperNewTabUrl)).toBe(true);
    expect(isBlankTabPage('chrome://newtab/', hyperNewTabUrl)).toBe(true);
    expect(isBlankTabPage('edge://newtab/', hyperNewTabUrl)).toBe(true);
  });

  it('keeps real pages open after history navigation', () => {
    expect(isBlankTabPage('https://example.com/', hyperNewTabUrl)).toBe(false);
    expect(isBlankTabPage(undefined, hyperNewTabUrl)).toBe(false);
  });

  it('correlates browser-normalised URLs without collapsing history state', () => {
    expect(sameNavigationUrl('https://example.com', 'https://example.com/')).toBe(true);
    expect(sameNavigationUrl('https://example.com/?state=1', 'https://example.com/?state=2'))
      .toBe(false);
    expect(sameNavigationUrl('https://example.com/#one', 'https://example.com/#two'))
      .toBe(false);
  });

  it('identifies only top-level history commits for the source tab', () => {
    const commit = {
      frameId: 0,
      tabId: 8,
      transitionQualifiers: ['forward_back'],
    };

    expect(isHistoryNavigationCommit(commit, 8)).toBe(true);
    expect(isHistoryNavigationCommit({ ...commit, tabId: 9 }, 8)).toBe(false);
    expect(isHistoryNavigationCommit({ ...commit, frameId: 2 }, 8)).toBe(false);
    expect(isHistoryNavigationCommit({ ...commit, transitionQualifiers: [] }, 8)).toBe(false);
  });
});

describe('findTabTargetSpace', () => {
  const spaces: Space[] = ['work', 'personal'].map((id, index) =>
    ({ children: [], id, index, rootId: id, title: id }));
  const target = (options: Parameters<typeof findTabTargetSpace>[1]) =>
    findTabTargetSpace(spaces, options)?.id;

  it('prefers the explicit destination, then the current owner, then the active space if enabled', () => {
    expect(target({ activeSpaceId: 'work', assignUnmatchedToActiveSpace: true, fallbackSpaceId: 'personal' }))
      .toBe('personal');
    expect(target({ assignUnmatchedToActiveSpace: false, currentSpaceId: 'work', fallbackSpaceId: 'personal' }))
      .toBe('personal');
    expect(target({ assignUnmatchedToActiveSpace: false, currentSpaceId: 'personal' })).toBe('personal');
    expect(target({ activeSpaceId: 'work', assignUnmatchedToActiveSpace: true })).toBe('work');
    expect(target({ activeSpaceId: 'work', assignUnmatchedToActiveSpace: false })).toBeUndefined();
  });
});

const contentTab = (
  id: number,
  url: string,
  overrides: Partial<BrowserTab> = {},
): BrowserTab => testTab({
  id,
  url,
  title: url,
  index: id,
  ...overrides,
});

const contentSnapshot = (
  url: string,
  navigationVersion = 0,
): TabContentSnapshots[number] => ({ url, text: 'page text', navigationVersion });

describe('tab content snapshots', () => {
  it('keeps only snapshots for the current URL and navigation version', () => {
    const tabs = [
      contentTab(1, 'https://current.example'),
      contentTab(2, 'https://changed.example'),
    ];
    const snapshots = {
      1: contentSnapshot('https://current.example'),
      2: contentSnapshot('https://old.example'),
      3: contentSnapshot('https://closed.example'),
    };

    expect(currentTabContents(tabs, {}, snapshots)).toEqual({ 1: snapshots[1] });
  });

  it('refreshes new and navigated eligible tabs only', () => {
    const tabs = [
      contentTab(1, 'https://current.example'),
      contentTab(2, 'https://navigated.example'),
      contentTab(3, 'chrome://settings'),
      contentTab(4, 'https://sleeping.example', { discarded: true }),
      contentTab(5, 'https://new.example'),
    ];
    const snapshots = {
      1: contentSnapshot('https://current.example'),
      2: contentSnapshot('https://navigated.example', 0),
    };

    expect(tabContentRefreshIds(tabs, { 2: 1 }, snapshots)).toEqual([2, 5]);
  });
});
