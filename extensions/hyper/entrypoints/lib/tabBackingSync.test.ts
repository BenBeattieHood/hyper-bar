import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ensureTabBackingBookmark,
  removeTabBackingBookmark,
  type TabBackingLocation,
} from './bookmarkStorage';
import { createTabBackingSync } from './tabBackingSync';
import { testTab } from './testFixtures';
import { getTabOwnership, loadTabOwnerships } from './tabOwnership';

vi.mock('./bookmarkStorage', async (importOriginal) => ({
  ...await importOriginal<typeof import('./bookmarkStorage')>(),
  ensureTabBackingBookmark: vi.fn(),
  removeTabBackingBookmark: vi.fn(),
}));
vi.mock('./tabOwnership', async (importOriginal) => ({
  ...await importOriginal<typeof import('./tabOwnership')>(),
  getTabOwnership: vi.fn(),
  loadTabOwnerships: vi.fn(),
  removeTabSpaceId: vi.fn(async () => undefined),
}));

const location: TabBackingLocation = {
  backingId: 'backing',
  backingToken: 'token',
  spaceId: 'space',
  url: 'https://example.test/page',
  windowId: 3,
};

function setup(live: { pendingUrl?: string; url: string }) {
  const tab = testTab({ id: 7, windowId: 3, ...live });
  vi.stubGlobal('browser', {
    tabs: {
      get: vi.fn(async () => ({ ...tab })),
      query: vi.fn(async () => [{ ...tab }]),
    },
  });
  const tabBackingLocations = new Map([[7, location]]);
  const persistTabOwnership = vi.fn(async () => undefined);
  const sync = createTabBackingSync({
    generations: new Map(),
    persistTabOwnership,
    rememberPendingBackingCleanup: vi.fn(async () => undefined),
    removeBackingIfUnclaimed: vi.fn(async () => undefined),
    removedTabs: new Map(),
    tabBackingLocations,
  });
  return { persistTabOwnership, sync, tab, tabBackingLocations };
}

describe('syncing a tab with its backing', () => {
  beforeEach(() => {
    vi.mocked(getTabOwnership).mockResolvedValue({ ...location });
    vi.mocked(loadTabOwnerships).mockResolvedValue({});
    vi.mocked(ensureTabBackingBookmark).mockReset().mockResolvedValue(undefined);
    vi.mocked(removeTabBackingBookmark).mockReset().mockResolvedValue(undefined);
  });

  it('keeps the backing of a tab that briefly reports no address between navigations', async () => {
    const { persistTabOwnership, sync, tab, tabBackingLocations } = setup({ url: '' });

    await sync.syncTabBacking(tab, 'space');

    expect(ensureTabBackingBookmark).not.toHaveBeenCalled();
    expect(removeTabBackingBookmark).not.toHaveBeenCalled();
    expect(persistTabOwnership).not.toHaveBeenCalled();
    expect(tabBackingLocations.get(7)).toBe(location);
  });

  it('lets a tab that leaves for a page with no bookmark go of its backing', async () => {
    const { persistTabOwnership, sync, tab, tabBackingLocations } = setup({ url: 'chrome://settings/' });

    await sync.syncTabBacking(tab, 'space');

    expect(removeTabBackingBookmark).toHaveBeenCalledWith(location);
    expect(tabBackingLocations.has(7)).toBe(false);
    expect(persistTabOwnership).toHaveBeenCalledWith(7, { spaceId: 'space', windowId: 3 });
  });

  it('places a new backing between the backed tabs of its space either side of its tab', async () => {
    const strip = [
      testTab({ id: 5, index: 0, windowId: 3, url: 'https://before.test/' }),
      testTab({ id: 6, index: 1, windowId: 3, url: 'chrome://newtab/' }),
      testTab({ id: 7, index: 2, windowId: 3, url: 'https://example.test/page' }),
      testTab({ id: 9, index: 3, windowId: 3, url: 'https://elsewhere.test/' }),
      testTab({ id: 8, index: 4, windowId: 3, url: 'https://after.test/' }),
    ];
    vi.stubGlobal('browser', {
      tabs: {
        get: vi.fn(async (tabId: number) => ({ ...strip.find((tab) => tab.id === tabId)! })),
        query: vi.fn(async () => strip.map((tab) => ({ ...tab }))),
      },
    });
    vi.mocked(getTabOwnership).mockResolvedValue({ spaceId: 'space', windowId: 3 });
    vi.mocked(loadTabOwnerships).mockResolvedValue({
      5: { spaceId: 'space', windowId: 3 },
      6: { spaceId: 'space', windowId: 3 },
      8: { backingId: 'after', spaceId: 'space', windowId: 3 },
      9: { backingId: 'elsewhere', spaceId: 'other', windowId: 3 },
    });
    const sync = createTabBackingSync({
      generations: new Map(),
      persistTabOwnership: vi.fn(async () => undefined),
      rememberPendingBackingCleanup: vi.fn(async () => undefined),
      removeBackingIfUnclaimed: vi.fn(async () => undefined),
      removedTabs: new Map(),
      tabBackingLocations: new Map([[5, { ...location, backingId: 'before' }]]),
    });

    await sync.syncTabBacking(strip[2]!, 'space');

    const placeNewBacking = vi.mocked(ensureTabBackingBookmark).mock.calls[0]?.[5];
    await expect(placeNewBacking?.()).resolves.toEqual({ previous: 'before', next: 'after' });
  });
});

describe('releasing a removed tab', () => {
  it('holds its backing as closing until its release has run, unless its window closed', async () => {
    const removeBackingIfUnclaimed = vi.fn(async () => undefined);
    const sync = createTabBackingSync({
      generations: new Map([[7, 2], [8, 2]]),
      persistTabOwnership: vi.fn(async () => undefined),
      rememberPendingBackingCleanup: vi.fn(async () => undefined),
      removeBackingIfUnclaimed,
      removedTabs: new Map([[7, false], [8, true]]),
      tabBackingLocations: new Map(),
    });
    // A worker that restarted since knows the backing only from the stored ownership.
    const release = sync.tabRemoved({
      isWindowClosing: false,
      locationAtRemoval: undefined,
      ownershipAtRemoval: Promise.resolve({ ...location }),
      removalGeneration: 2,
      tabId: 7,
    });
    sync.tabRemoved({
      isWindowClosing: true,
      locationAtRemoval: { ...location, backingId: 'kept', backingToken: 'kept-token' },
      ownershipAtRemoval: Promise.resolve(undefined),
      removalGeneration: 2,
      tabId: 8,
    });

    await expect(sync.backingClosing({ backingId: 'backing' })).resolves.toBe(true);
    await expect(sync.backingClosing({ backingId: 'copy', backingToken: 'token' })).resolves.toBe(true);
    await expect(sync.backingClosing({ backingId: 'kept' })).resolves.toBe(false);

    await release();

    expect(removeBackingIfUnclaimed).toHaveBeenCalledWith(-1, location);
    await expect(sync.backingClosing({ backingId: 'backing' })).resolves.toBe(false);
  });
});
