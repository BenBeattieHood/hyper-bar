import { describe, expect, it, vi } from 'vitest';
import { createBackingCleanup } from './backingCleanup';
import type { TabBackingLocation } from './bookmarkStorage';

const location: TabBackingLocation = {
  backingId: 'backing-1',
  backingToken: 'token-1',
  spaceId: 'one',
  url: 'https://example.test',
  windowId: 1,
};

const journal = {
  loadPendingJournal: vi.fn(async () => [] as TabBackingLocation[]),
  savePendingJournal: vi.fn(async () => undefined),
};

describe('backing cleanup', () => {
  it('retains an in-memory or persisted backing claim from another live tab', async () => {
    const removeTabBackingBookmark = vi.fn(async () => undefined);
    const cleanup = createBackingCleanup({
      ...journal,
      getTabOwnership: vi.fn(async () => ({
        backingToken: location.backingToken,
        spaceId: location.spaceId,
      })),
      queryTabs: vi.fn(async () => [{ id: 1 }, { id: 2 }]),
      removeTabBackingBookmark,
      tabBackingLocations: new Map([[2, location]]),
    });

    await cleanup.removeBackingIfUnclaimed(1, location);

    expect(removeTabBackingBookmark).not.toHaveBeenCalled();
    expect(await cleanup.backingClaimedByAnotherLiveTab(1, location)).toBe(true);
  });

  it('removes a backing when no other live tab claims its exact identity', async () => {
    const removeTabBackingBookmark = vi.fn(async () => undefined);
    const cleanup = createBackingCleanup({
      ...journal,
      getTabOwnership: vi.fn(async () => undefined),
      queryTabs: vi.fn(async () => [{ id: 1 }, { id: 2 }]),
      removeTabBackingBookmark,
      tabBackingLocations: new Map(),
    });

    await cleanup.removeBackingIfUnclaimed(1, location);

    expect(removeTabBackingBookmark).toHaveBeenCalledWith(location);
  });

  it('journals a failed removal and clears it once a retry succeeds', async () => {
    const earlier = { ...location, backingId: 'backing-0', backingToken: 'token-0' };
    const savePendingJournal = vi.fn(async () => undefined);
    const removeTabBackingBookmark = vi.fn(async () => undefined)
      .mockRejectedValueOnce(new Error('bookmarks unavailable'));
    const cleanup = createBackingCleanup({
      getTabOwnership: vi.fn(async () => undefined),
      loadPendingJournal: vi.fn(async () => [earlier]),
      queryTabs: vi.fn(async () => []),
      removeTabBackingBookmark,
      savePendingJournal,
      tabBackingLocations: new Map(),
    });

    await cleanup.rememberPending(location);
    expect(savePendingJournal).toHaveBeenLastCalledWith([earlier, location]);

    await cleanup.retryPending();
    expect(removeTabBackingBookmark).toHaveBeenLastCalledWith(location);
    expect(savePendingJournal).toHaveBeenLastCalledWith([]);
  });
});