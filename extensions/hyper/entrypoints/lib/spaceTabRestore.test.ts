import { beforeEach, describe, expect, it, vi } from 'vitest';
import { deriveSpaces } from './bookmarks';
import { ensureTabBackingBookmark, windowTabBackings } from './bookmarkStorage';
import { createSpaceTabRestore } from './spaceTabRestore';
import { testBookmark } from './testBookmarkTree';

vi.mock('./bookmarks', async (importOriginal) => ({
  ...await importOriginal<typeof import('./bookmarks')>(),
  deriveSpaces: vi.fn(),
}));
vi.mock('./bookmarkStorage', async (importOriginal) => ({
  ...await importOriginal<typeof import('./bookmarkStorage')>(),
  ensureTabBackingBookmark: vi.fn(),
  windowTabBackings: vi.fn(),
}));
vi.mock('./operationJournal', () => ({
  advanceDurableOperation: vi.fn(async () => undefined),
  beginDurableOperation: vi.fn(async () => undefined),
  completeDurableOperation: vi.fn(async () => undefined),
}));
vi.mock('./tabOwnership', () => ({
  getTabOwnership: vi.fn(async () => undefined),
  tabOwnershipsById: vi.fn(async () => new Map()),
}));

const backing = (id: string, url: string) => testBookmark(
  id,
  `${url} ${JSON.stringify({ hyper: { spaceId: 'space', tab: true, tabToken: `${id}-token`, windowId: 3 } })}`,
  url,
);

describe('restoring the tabs of a space', () => {
  beforeEach(() => {
    let nextTabId = 20;
    vi.stubGlobal('browser', {
      bookmarks: { getTree: vi.fn(async () => []) },
      tabs: {
        create: vi.fn(async ({ url, windowId }: { url: string; windowId: number }) =>
          ({ active: false, id: (nextTabId += 1), index: 0, url, windowId })),
        query: vi.fn(async () => []),
        remove: vi.fn(async () => undefined),
      },
    });
    vi.mocked(deriveSpaces).mockReturnValue([{ id: 'space' } as ReturnType<typeof deriveSpaces>[number]]);
    vi.mocked(windowTabBackings).mockResolvedValue([
      backing('closed', 'https://closed.test/'),
      backing('missing', 'https://missing.test/'),
    ]);
    vi.mocked(ensureTabBackingBookmark).mockImplementation(async (tab, spaceId, location) =>
      location?.backingId
        ? {
            backingId: location.backingId,
            backingToken: location.backingToken ?? '',
            spaceId,
            url: tab.url ?? '',
            windowId: tab.windowId,
          }
        : undefined);
  });

  it('reopens a tab no live tab claims, but not one that has just closed', async () => {
    const restore = createSpaceTabRestore({
      activationTokens: new Map(),
      backingClaimedByAnotherLiveTab: vi.fn(async () => false),
      backingClosing: vi.fn(async ({ backingId }) => backingId === 'closed'),
      markIntentionalTab: vi.fn(),
      persistTabOwnership: vi.fn(async () => undefined),
      tabBackingLocations: new Map(),
    });

    await expect(restore('space', 3, [])).resolves.toEqual([21]);
    expect(browser.tabs.create).toHaveBeenCalledTimes(1);
    expect(browser.tabs.create).toHaveBeenCalledWith({
      active: false,
      url: 'https://missing.test/',
      windowId: 3,
    });
  });
});
