import { describe, expect, it } from 'vitest';
import type { BookmarkNode, BrowserTab } from '../../lib/bookmarks';
import { testTab } from '../../lib/testFixtures';
import {
  domainGroups,
  favouriteBarSlots,
  favouriteRowColumns,
  fitFavouriteBarSlots,
  groupedFavouriteBarSlots,
  groupFavourites,
  groupTabs,
  heldOrder,
  heldRecentOrder,
  orderEntriesBySpace,
  recentBarTabs,
  unpinnedSlotCount,
  withoutDismissed,
} from './favouriteBar';

const origin = 'chrome-extension://hyper/';
const tab = (id: number, overrides: Partial<BrowserTab> = {}) =>
  testTab({ id, index: id, lastAccessed: id * 10, url: `https://site.test/${id}`, windowId: 1, ...overrides }) as BrowserTab & { id: number };
const favourite = (id: string, url: string): BookmarkNode => ({ id, parentId: 'favourites', syncing: false, title: id, url });

describe('the favourites bar row', () => {
  // n columns of tile t need n * t + (n - 1) * 6 px.
  it('shrinks tiles to 28px to keep eight columns, then drops one at a time', () => {
    expect(favouriteRowColumns(8 * 28 + 7 * 6, 6)).toBe(8);
    expect(favouriteRowColumns(8 * 28 + 7 * 6 - 1, 6)).toBe(7);
    expect(favouriteRowColumns(4 * 28 + 3 * 6, 6)).toBe(4);
  });

  it('adds a column once another fits at 34px', () => {
    expect(favouriteRowColumns(9 * 34 + 8 * 6 - 1, 6)).toBe(8);
    expect(favouriteRowColumns(9 * 34 + 8 * 6, 6)).toBe(9);
    expect(favouriteRowColumns(12 * 34 + 11 * 6, 6)).toBe(12);
  });

  it('always keeps one slot and the global bookmarks button', () => {
    expect(favouriteRowColumns(20, 6)).toBe(2);
  });
});

describe('recent tabs on the favourites bar', () => {
  it('puts the current tab first, then the most recently used', () => {
    const tabs = [tab(1), tab(2, { active: true }), tab(3), tab(4, { lastAccessed: undefined })];
    expect(recentBarTabs({ backgroundMusicTabIds: new Set(), extensionOrigin: origin, favourites: [], linkedTabIds: new Set(), tabs, windowId: 1 })
      .map((item) => item.id)).toEqual([2, 3, 1, 4]);
  });

  it('leaves out other windows, Hyper pages, and tabs a pinned favourite stands for', () => {
    const tabs = [
      tab(1, { windowId: 2 }),
      tab(2, { url: `${origin}newtab.html` }),
      tab(3, { url: 'https://site.test/pinned#section' }),
      tab(4),
      tab(5),
    ];
    expect(recentBarTabs({
      backgroundMusicTabIds: new Set(),
      extensionOrigin: origin,
      favourites: [favourite('pin', 'https://site.test/pinned'), undefined],
      linkedTabIds: new Set([5]),
      tabs,
      windowId: 1,
    }).map((item) => item.id)).toEqual([4]);
  });

  it('leaves out the music tabs the model says Now Playing holds', () => {
    expect(recentBarTabs({
      backgroundMusicTabIds: new Set([2]),
      extensionOrigin: origin,
      favourites: [],
      linkedTabIds: new Set(),
      tabs: [tab(1), tab(2), tab(3)],
      windowId: 1,
    }).map((item) => item.id)).toEqual([3, 1]);
  });

  it('leaves out new tab and blank pages, loaded or still loading', () => {
    expect(recentBarTabs({
      backgroundMusicTabIds: new Set(),
      extensionOrigin: origin,
      favourites: [],
      linkedTabIds: new Set(),
      tabs: [
        tab(1, { url: 'chrome://newtab/' }),
        tab(2, { pendingUrl: 'edge://newtab/', url: '' }),
        tab(3, { url: 'about:blank' }),
        tab(4),
      ],
      windowId: 1,
    }).map((item) => item.id)).toEqual([4]);
  });

  it('shows nothing before the window is known', () => {
    expect(recentBarTabs({ backgroundMusicTabIds: new Set(), extensionOrigin: origin, favourites: [], linkedTabIds: new Set(), tabs: [tab(1)], windowId: null }))
      .toEqual([]);
  });
});

describe('recent tabs taken off the bar', () => {
  it('stay off until they are next used', () => {
    const recent = [tab(1), tab(2), tab(3)];
    const dismissed = new Map([[2, 20], [3, 10]]);
    expect(withoutDismissed(recent, dismissed).map((item) => item.id)).toEqual([1, 3]);
  });
});

describe('a held recent order', () => {
  it('keeps shown tabs in place and fills a closed tab\u2019s place with the next most recent', () => {
    const recent = [tab(4), tab(1), tab(3), tab(5)];
    expect(heldRecentOrder([1, 2, 3], recent, 3).map((item) => item.id)).toEqual([1, 4, 3]);
  });

  it('grows into slots that open up while held and never shows more than fit', () => {
    const recent = [tab(4), tab(1), tab(3)];
    expect(heldRecentOrder([1], recent, 2).map((item) => item.id)).toEqual([1, 4]);
    expect(heldRecentOrder([1, 4, 3], recent, 2).map((item) => item.id)).toEqual([1, 4]);
  });

  it('holds when a shown tab is used, and gives a newly recent tab the slot of the one it pushes out', () => {
    expect(heldRecentOrder([1, 2, 3], [tab(3), tab(1), tab(2), tab(4)], 3).map((item) => item.id))
      .toEqual([1, 2, 3]);
    expect(heldRecentOrder([1, 2, 3], [tab(5), tab(1), tab(2), tab(3)], 3).map((item) => item.id))
      .toEqual([1, 2, 5]);
  });
});

describe('favourites bar slots', () => {
  it('keeps pinned favourites in their slots and fills the rest with recent tabs from the left', () => {
    const pinned = favourite('pin', 'https://site.test/pinned');
    expect(favouriteBarSlots([undefined, pinned], [tab(7)], 4)).toEqual([
      { index: 0, kind: 'recent', tab: tab(7) },
      { index: 1, kind: 'favourite', node: pinned },
      { index: 2, kind: 'empty' },
      { index: 3, kind: 'empty' },
    ]);
    expect(unpinnedSlotCount([undefined, pinned], 4)).toBe(3);
  });

  it('fits a short column by dropping empty slots, then the least recent tabs, but never a favourite', () => {
    const pinned = favourite('pin', 'https://site.test/pinned');
    const slots = favouriteBarSlots([undefined, undefined, pinned], [tab(7), tab(8), tab(9)], 6);
    const indices = (limit: number) => fitFavouriteBarSlots(slots, limit, 5).map((slot) => slot.index);
    expect(indices(6)).toEqual([0, 1, 2, 3, 4]);
    expect(indices(4)).toEqual([0, 1, 2, 3]);
    expect(indices(2)).toEqual([0, 2]);
    expect(indices(0)).toEqual([2]);
  });
});

describe('the favourites bar grouped by domain', () => {
  const at = (id: number, url: string, overrides: Partial<BrowserTab> = {}) => tab(id, { url, ...overrides });
  const entryIds = (group: { entries: Array<{ kind: string; tab?: { id: number }; node?: { id: string } }> }) =>
    group.entries.map((entry) => entry.kind === 'tab' ? entry.tab!.id : entry.node!.id);

  it('merges favourites on one domain into the left-most, with that domain\'s tabs most recent first', () => {
    const mail = favourite('mail', 'https://www.mail.test/inbox');
    const sent = favourite('sent', 'https://mail.test/sent');
    const recent = [at(4, 'https://mail.test/drafts'), at(3, 'https://mail.test/sent'), at(2, 'https://other.test/')];
    const { pinned, recent: others } = domainGroups({
      favourites: [undefined, mail, undefined, sent],
      recent,
      slotCount: 7,
      tabBookmarkIds: new Map(),
    });

    expect(pinned).toHaveLength(1);
    expect(pinned[0]).toMatchObject({ index: 1, node: mail });
    // The open favourite ranks by its tab; the unopened one comes last.
    expect(entryIds(pinned[0]!.group)).toEqual([4, 'sent', 'mail']);
    expect(groupFavourites(pinned[0]!.group)).toEqual([mail, sent]);
    expect(groupTabs(pinned[0]!.group).map((item) => item.id)).toEqual([4, 3]);
    expect(others.map((group) => [group.domain, entryIds(group)])).toEqual([['other.test', [2]]]);
  });

  it('keeps a tab opened from a favourite with it after it wanders to another domain', () => {
    const docs = favourite('docs', 'https://docs.test/');
    const { pinned, recent } = domainGroups({
      favourites: [docs],
      recent: [at(5, 'https://elsewhere.test/page'), at(6, 'https://elsewhere.test/other')],
      slotCount: 7,
      tabBookmarkIds: new Map([[5, 'docs']]),
    });
    expect(groupTabs(pinned[0]!.group).map((item) => item.id)).toEqual([5]);
    expect(recent.map(entryIds)).toEqual([[6]]);
  });

  it('fills every slot no favourite group leads with recent groups, and marks only shared tiles as groups', () => {
    const mail = favourite('mail', 'https://mail.test/');
    const sent = favourite('sent', 'https://mail.test/sent');
    const { pinned, recent } = domainGroups({
      favourites: [mail, sent],
      recent: [at(1, 'https://a.test/1'), at(2, 'https://a.test/2'), at(3, 'https://b.test/')],
      slotCount: 4,
      tabBookmarkIds: new Map(),
    });
    const slots = groupedFavouriteBarSlots(pinned, recent, 4);

    expect(slots.map((slot) => slot.kind)).toEqual(['favourite', 'recent', 'recent', 'empty']);
    expect(slots[0]).toMatchObject({ node: mail, group: { domain: 'mail.test' } });
    expect(slots[1]).toMatchObject({ tab: { id: 1 }, group: { domain: 'a.test' } });
    expect(slots[2]).toMatchObject({ tab: { id: 3 } });
    expect(slots[2]).not.toHaveProperty('group');
  });

  it('holds domain groups in place as recent tabs are held', () => {
    expect(heldOrder(['b', 'a'], ['a', 'c', 'b'], 2, (key) => key)).toEqual(['c', 'a']);
  });
});

describe('a grouped tile\'s list', () => {
  it('gathers entries by space, ranking spaces by their most recent entry, and keeps entries in no space last', () => {
    const spaces: Record<string, string | undefined> = { a: 'work', b: 'home', c: 'work', d: undefined, e: 'home' };
    expect(orderEntriesBySpace(['a', 'd', 'b', 'c', 'e'], (entry) => spaces[entry])).toEqual(['a', 'c', 'b', 'e', 'd']);
  });
});
