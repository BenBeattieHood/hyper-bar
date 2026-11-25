import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  loadPendingBackingCleanupJournal,
  MAX_PENDING_BACKING_CLEANUPS,
  savePendingBackingCleanupJournal,
} from './backingCleanupJournal';
import type { TabBackingLocation } from './bookmarkStorage';

const location = (
  backingId: string,
  overrides: Partial<TabBackingLocation> = {},
): TabBackingLocation => ({
  backingId,
  backingToken: `token-${backingId}`,
  spaceId: 'space',
  url: `https://example.com/${backingId}`,
  ...overrides,
});

describe('pending backing cleanup journal', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('loads validated locations and keeps the latest duplicate identity', async () => {
    const get = vi.fn(async () => ({
      'hyperPendingBackingCleanup:v1': [
        location('one'),
        { backingId: 'invalid' },
        {
          ...location('one', { backingToken: 'latest-token', windowId: 7 }),
          tabId: 93,
        },
        location('two'),
      ],
    }));
    vi.stubGlobal('browser', { storage: { local: { get } } });

    await expect(loadPendingBackingCleanupJournal()).resolves.toEqual([
      location('one', { backingToken: 'latest-token', windowId: 7 }),
      location('two'),
    ]);
  });

  it('bounds persisted cleanup work to the newest exact locations', async () => {
    const set = vi.fn(async (_items: Record<string, unknown>) => undefined);
    vi.stubGlobal('browser', {
      storage: { local: { set, remove: vi.fn(async () => undefined) } },
    });
    const locations = Array.from(
      { length: MAX_PENDING_BACKING_CLEANUPS + 2 },
      (_, index) => location(String(index)),
    );

    await savePendingBackingCleanupJournal(locations);

    const persisted = set.mock.calls[0]?.[0]['hyperPendingBackingCleanup:v1'] as
      TabBackingLocation[] | undefined;
    expect(persisted).toBeDefined();
    if (!persisted) throw new Error('The cleanup journal was not persisted.');
    expect(persisted).toHaveLength(MAX_PENDING_BACKING_CLEANUPS);
    expect(persisted[0]!.backingId).toBe('2');
    expect(persisted.at(-1)?.backingId).toBe(String(locations.length - 1));
  });

  it('removes the journal after the last cleanup succeeds', async () => {
    const remove = vi.fn(async () => undefined);
    vi.stubGlobal('browser', {
      storage: { local: { set: vi.fn(async () => undefined), remove } },
    });

    await savePendingBackingCleanupJournal([]);

    expect(remove).toHaveBeenCalledWith('hyperPendingBackingCleanup:v1');
  });
});