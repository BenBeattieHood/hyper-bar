import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BrowserTab } from './bookmarks';
import {
  createTabOwnershipWriter,
  getTabOwnership,
  loadTabOwnerships,
  loadTabSpaceIds,
  removeTabSpaceId,
  setTabOwnership,
  setTabSpaceId,
  tabsOwnedBySpace,
} from './tabOwnership';
import { testTab } from './testFixtures';

describe('tab ownership', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('prefers and sanitizes authoritative tab session values', async () => {
    const getTabValue = vi.fn(async () => ({
      spaceId: 'work',
      windowId: 3,
      backingId: 'bookmark-1',
      backingToken: 'token-1',
      url: 'https://example.com',
      ignored: true,
    }));
    const get = vi.fn(async () => ({ 'tabSpaceId:7': 'fallback' }));
    vi.stubGlobal('browser', {
      sessions: { getTabValue },
      storage: { session: { get } },
    });

    await expect(getTabOwnership(7)).resolves.toEqual({
      spaceId: 'work',
      windowId: 3,
      backingId: 'bookmark-1',
      backingToken: 'token-1',
      url: 'https://example.com',
    });
    expect(getTabValue).toHaveBeenCalledWith(7, 'hyperSpaceId');
    expect(get).not.toHaveBeenCalled();
  });

  it('falls back to mirrored storage and accepts legacy space IDs', async () => {
    vi.stubGlobal('browser', {
      sessions: {
        getTabValue: vi.fn(async () => {
          throw new Error('tab session unavailable');
        }),
      },
      storage: {
        session: {
          get: vi.fn(async () => ({ 'tabSpaceId:7': 'legacy-space' })),
        },
      },
    });

    await expect(getTabOwnership(7)).resolves.toEqual({ spaceId: 'legacy-space' });
  });

  it('updates the space while preserving backing identity', async () => {
    const current = {
      spaceId: 'personal',
      backingId: 'bookmark-1',
      backingToken: 'token-1',
    };
    const setTabValue = vi.fn(async () => undefined);
    vi.stubGlobal('browser', {
      sessions: {
        getTabValue: vi.fn(async () => current),
        setTabValue,
      },
      storage: { session: { set: vi.fn(async () => undefined) } },
    });

    await setTabSpaceId(7, 'work');

    expect(setTabValue).toHaveBeenCalledWith(7, 'hyperSpaceId', {
      ...current,
      spaceId: 'work',
    });
  });

  it('writes the native tab value, mirrors it, then notifies the model', async () => {
    const ownership = { spaceId: 'work' };
    const setTabValue = vi.fn(async () => undefined);
    const set = vi.fn(async () => undefined);
    const onPersisted = vi.fn(() => {
      expect(setTabValue).toHaveBeenCalledWith(7, 'hyperSpaceId', ownership);
    });
    vi.stubGlobal('browser', { sessions: { setTabValue }, storage: { session: { set } } });

    await createTabOwnershipWriter(onPersisted)(7, ownership);

    expect(onPersisted).toHaveBeenCalledOnce();
    expect(set).toHaveBeenCalledWith({ 'tabSpaceId:7': ownership });
  });

  it('does not hide a failed native write behind the mirror', async () => {
    vi.stubGlobal('browser', {
      sessions: { setTabValue: vi.fn(async () => Promise.reject(new Error('session write failed'))) },
      storage: { session: { set: vi.fn(async () => undefined) } },
    });

    await expect(setTabOwnership(7, { spaceId: 'work' })).rejects.toThrow('session write failed');
  });

  it('falls back to extension session storage when tab values are unavailable', async () => {
    const ownership = { spaceId: 'work', backingId: 'bookmark-1' };
    const set = vi.fn(async () => undefined);
    vi.stubGlobal('browser', {
      storage: { session: { get: vi.fn(async () => ({ 'tabSpaceId:7': ownership })), set } },
    });

    await setTabOwnership(7, ownership);

    expect(set).toHaveBeenCalledWith({ 'tabSpaceId:7': ownership });
    await expect(getTabOwnership(7)).resolves.toEqual(ownership);
  });

  it('clears mirrored ownership even when the native removal fails', async () => {
    const removeTabValue = vi.fn(async () => Promise.reject(new Error('tab no longer exists')));
    const remove = vi.fn(async () => undefined);
    vi.stubGlobal('browser', { sessions: { removeTabValue }, storage: { session: { remove } } });

    await expect(removeTabSpaceId(7)).rejects.toThrow('tab no longer exists');
    expect(removeTabValue).toHaveBeenCalledWith(7, 'hyperSpaceId');
    expect(remove).toHaveBeenCalledWith('tabSpaceId:7');
  });

  it('loads ownership in bulk and ignores tabs without IDs', async () => {
    const getTabValue = vi.fn(async (tabId: number) =>
      tabId === 1 ? { spaceId: 'work', windowId: 3 } : undefined);
    vi.stubGlobal('browser', {
      sessions: { getTabValue },
      storage: { session: { get: vi.fn(async () => ({})) } },
    });
    const tabs: BrowserTab[] = [
      testTab({ id: 1 }),
      testTab({ id: 2 }),
      testTab({ id: undefined }),
    ];

    await expect(loadTabOwnerships(tabs)).resolves.toEqual({
      1: { spaceId: 'work', windowId: 3 },
    });
    await expect(loadTabSpaceIds(tabs)).resolves.toEqual({ 1: 'work' });
    expect(tabsOwnedBySpace(tabs, { 1: { spaceId: 'work' } }, 'work'))
      .toEqual([tabs[0]]);
    expect(getTabValue).toHaveBeenCalledTimes(4);
  });

  it('reads every unresolved tab from storage in one call', async () => {
    const get = vi.fn(async (keys: string[]) => Object.fromEntries(keys.flatMap((key) =>
      key === 'tabSpaceId:2' ? [[key, { spaceId: 'home', backingId: 'b2' }]] : [])));
    vi.stubGlobal('browser', { storage: { session: { get } } });

    await expect(loadTabOwnerships([testTab({ id: 1 }), testTab({ id: 2 })]))
      .resolves.toEqual({ 2: { spaceId: 'home', backingId: 'b2' } });
    expect(get).toHaveBeenCalledOnce();
    expect(get).toHaveBeenCalledWith(['tabSpaceId:1', 'tabSpaceId:2']);
  });
});