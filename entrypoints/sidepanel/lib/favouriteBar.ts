import { MAX_FAVOURITES, type BookmarkNode, type BrowserTab } from '../../lib/bookmarks';
import { isBlankTabPage } from '../../lib/tabs';
import { pageIdentity, tabUrl, urlDomain } from '../../lib/urlIdentity';

type OpenTab = BrowserTab & { id: number };

/** One line in a grouped tile's list: a pinned favourite with this window's tabs of it, or another tab. */
export type FavouriteGroupEntry =
  | { kind: 'favourite'; node: BookmarkNode; index: number; tabs: OpenTab[] }
  | { kind: 'tab'; tab: OpenTab };

/** Everything on the bar from one domain, when the bar groups by domain. */
export interface FavouriteGroup {
  key: string;
  domain: string;
  /** Most recently used first; favourites open in no tab of this window last, in slot order. */
  entries: FavouriteGroupEntry[];
}

/**
 * One place on the favourites bar: a pinned favourite, a recent tab in an
 * unpinned slot, or nothing. A tile carries a group only when it stands for
 * more than one entry; otherwise it acts exactly as an ungrouped tile.
 */
export type FavouriteBarSlot =
  | { kind: 'favourite'; index: number; node: BookmarkNode; group?: FavouriteGroup }
  | { kind: 'recent'; index: number; tab: OpenTab; group?: FavouriteGroup }
  | { kind: 'empty'; index: number };

/**
 * This window's tabs from most to least recently used, the current one
 * included, leaving out Hyper's own pages, new tab and blank pages, the tabs a
 * pinned favourite already stands for, and the music the model says Now
 * Playing has in hand.
 */
export function recentBarTabs({
  backgroundMusicTabIds,
  extensionOrigin,
  favourites,
  linkedTabIds,
  tabs,
  windowId,
}: {
  /** Music tabs Now Playing already shows, from the model's projection. */
  backgroundMusicTabIds: ReadonlySet<number>;
  extensionOrigin: string;
  favourites: readonly (BookmarkNode | undefined)[];
  /** Tabs opened from a favourite, which belong to its tile even once they wander. */
  linkedTabIds: ReadonlySet<number>;
  tabs: readonly BrowserTab[];
  windowId: number | null;
}): Array<BrowserTab & { id: number }> {
  if (windowId === null) return [];
  const pinnedIdentities = new Set(favourites.flatMap((node) => {
    const identity = pageIdentity(node?.url);
    return identity ? [identity] : [];
  }));
  return tabs
    .filter((tab): tab is BrowserTab & { id: number } =>
      tab.id !== undefined &&
      tab.windowId === windowId &&
      !linkedTabIds.has(tab.id) &&
      !backgroundMusicTabIds.has(tab.id) &&
      !tabUrl(tab)?.startsWith(extensionOrigin) &&
      !isBlankTabPage(tabUrl(tab), `${extensionOrigin}newtab.html`) &&
      !pinnedIdentities.has(pageIdentity(tabUrl(tab)) ?? ''))
    .sort((left, right) =>
      Number(right.active) - Number(left.active) ||
      (right.lastAccessed ?? 0) - (left.lastAccessed ?? 0) ||
      right.index - left.index);
}

/**
 * Leaves out recent tabs taken off the bar, until each is next used. The map
 * holds when each was last used at the moment it was taken off.
 */
export function withoutDismissed<Tab extends BrowserTab & { id: number }>(
  recent: readonly Tab[],
  dismissed: ReadonlyMap<number, number>,
): Tab[] {
  return recent.filter((tab) => {
    const usedAt = dismissed.get(tab.id);
    return usedAt === undefined || (tab.lastAccessed ?? 0) > usedAt;
  });
}

/**
 * Keeps tabs where they were while the order is held, so a tile does not move
 * from under the pointer. The bar still shows the most recent tabs: one that
 * drops out, by closing or by a newer tab arriving, leaves its place to the
 * newcomer, and every other tile stays put.
 */
export function heldRecentOrder<Tab extends OpenTab>(
  heldTabIds: readonly number[],
  recent: readonly Tab[],
  count: number,
): Tab[] {
  return heldOrder(heldTabIds, recent, count, (tab) => tab.id);
}

/** {@link heldRecentOrder} for anything with a stable key, such as a domain group. */
export function heldOrder<Item, Key>(
  heldKeys: readonly Key[],
  items: readonly Item[],
  count: number,
  keyOf: (item: Item) => Key,
): Item[] {
  const current = items.slice(0, count);
  const byKey = new Map(current.map((item) => [keyOf(item), item]));
  const kept = heldKeys.slice(0, count).map((key) => byKey.get(key));
  const placed = new Set(kept.flatMap((item) => item === undefined ? [] : [keyOf(item)]));
  const fresh = current.filter((item) => !placed.has(keyOf(item)));
  return kept
    .map((item) => item ?? fresh.shift())
    .concat(fresh)
    .filter((item): item is Item => item !== undefined)
    .slice(0, count);
}

/** Pinned favourites keep their slots; recent tabs fill the others from the left. */
export function favouriteBarSlots(
  favourites: readonly (BookmarkNode | undefined)[],
  recent: ReadonlyArray<BrowserTab & { id: number }>,
  slotCount: number,
): FavouriteBarSlot[] {
  const queue = [...recent];
  return Array.from({ length: slotCount }, (_, index): FavouriteBarSlot => {
    const node = favourites[index];
    if (node) return { kind: 'favourite', index, node };
    const tab = queue.shift();
    return tab ? { kind: 'recent', index, tab } : { kind: 'empty', index };
  });
}

/**
 * The slots a column of `limit` tiles shows, in slot order. Pinned favourites
 * always show, then recent tabs from the left, then empty slots; an empty slot
 * past the favourites' own `favouriteSlotCount` never shows.
 */
export function fitFavouriteBarSlots(
  slots: readonly FavouriteBarSlot[],
  limit: number,
  favouriteSlotCount: number,
): FavouriteBarSlot[] {
  let room = Math.max(0, limit - slots.filter((slot) => slot.kind === 'favourite').length);
  const recent = new Set<FavouriteBarSlot>(slots.filter((slot) => slot.kind === 'recent').slice(0, room));
  room -= recent.size;
  const empty = new Set<FavouriteBarSlot>(slots
    .filter((slot) => slot.kind === 'empty' && slot.index < favouriteSlotCount)
    .slice(0, room));
  return slots.filter((slot) => slot.kind === 'favourite' || recent.has(slot) || empty.has(slot));
}

/** The smallest a tile shrinks to keep the bar's seven slots and global bookmarks button on one row. */
const MIN_TILE = 28;
/** The smallest a tile shrinks to make room for a slot past those seven. */
const MIN_EXTRA_TILE = 34;

/**
 * How many columns, the global bookmarks button's included, fit on one row
 * `width` wide with `gap` between them. Tiles shrink to `MIN_TILE` to keep the
 * seven slots and the button, then the bar drops a column at a time; where
 * wider, it adds one each time another fits at `MIN_EXTRA_TILE`. There is
 * always room for one slot and the button.
 */
export function favouriteRowColumns(width: number, gap: number): number {
  const fit = (tile: number) => Math.floor((width + gap) / (tile + gap) + 1e-6);
  return Math.max(2, fit(MIN_EXTRA_TILE), Math.min(MAX_FAVOURITES + 1, fit(MIN_TILE)));
}

export const unpinnedSlotCount = (
  favourites: readonly (BookmarkNode | undefined)[],
  slotCount: number,
) => Array.from({ length: slotCount }, (_, index) => favourites[index]).filter((node) => !node).length;

const domainKey = (url?: string) => {
  const domain = urlDomain(url);
  return domain ? { domain, key: `domain:${domain}` } : undefined;
};

/** The tabs a grouped tile stands for, most recent first. */
export const groupTabs = (group: FavouriteGroup): OpenTab[] =>
  group.entries.flatMap((entry) => entry.kind === 'tab' ? [entry.tab] : entry.tabs);

/** The favourites a grouped tile stands for, in slot order. */
export const groupFavourites = (group: FavouriteGroup): BookmarkNode[] =>
  group.entries
    .flatMap((entry) => entry.kind === 'favourite' ? [entry] : [])
    .sort((left, right) => left.index - right.index)
    .map((entry) => entry.node);

/**
 * A group's entries for its list: gathered by space, each space ranked by its
 * most recent entry, and most recent first within a space. `entries` must be
 * most recent first; entries in no space go last.
 */
export function orderEntriesBySpace<Entry>(
  entries: readonly Entry[],
  spaceOf: (entry: Entry) => string | undefined,
): Entry[] {
  const spaceRank = new Map<string | undefined, number>();
  for (const entry of entries) {
    const spaceId = spaceOf(entry);
    if (spaceId !== undefined && !spaceRank.has(spaceId)) spaceRank.set(spaceId, spaceRank.size);
  }
  const rankOf = (entry: Entry) => spaceRank.get(spaceOf(entry)) ?? Infinity;
  return [...entries].sort((left, right) => rankOf(left) - rankOf(right));
}

/**
 * Gathers the bar by domain. Favourites on one domain merge into the tile of
 * the left-most, and take this window's tabs of that domain; a tab opened from
 * a favourite stays with it even once it wanders. Other tabs gather into one
 * group per domain, ordered by their most recent tab. `recent` must already be
 * this window's tabs, most recent first, with nothing a favourite stands for
 * left out.
 */
export function domainGroups({
  favourites,
  recent,
  slotCount,
  tabBookmarkIds,
}: {
  favourites: readonly (BookmarkNode | undefined)[];
  recent: readonly OpenTab[];
  slotCount: number;
  /** The bookmark each tab was opened from, where the model knows one. */
  tabBookmarkIds: ReadonlyMap<number, string>;
}): { pinned: Array<{ group: FavouriteGroup; index: number; node: BookmarkNode }>; recent: FavouriteGroup[] } {
  const pinnedByKey = new Map<string, { group: FavouriteGroup; index: number; node: BookmarkNode }>();
  const favouriteById = new Map<string, Extract<FavouriteGroupEntry, { kind: 'favourite' }>>();
  const favouriteByIdentity = new Map<string, Extract<FavouriteGroupEntry, { kind: 'favourite' }>>();
  for (let index = 0; index < slotCount; index += 1) {
    const node = favourites[index];
    if (!node) continue;
    const entry = { kind: 'favourite' as const, node, index, tabs: [] as OpenTab[] };
    favouriteById.set(node.id, entry);
    const identity = pageIdentity(node.url);
    if (identity && !favouriteByIdentity.has(identity)) favouriteByIdentity.set(identity, entry);
    const { domain, key } = domainKey(node.url) ?? { domain: '', key: `bookmark:${node.id}` };
    const pinned = pinnedByKey.get(key);
    if (pinned) pinned.group.entries.push(entry);
    else pinnedByKey.set(key, { group: { domain, entries: [entry], key }, index, node });
  }
  const recentByKey = new Map<string, FavouriteGroup>();
  for (const tab of recent) {
    const url = tabUrl(tab);
    const bookmarkId = tabBookmarkIds.get(tab.id);
    const favourite = (bookmarkId && favouriteById.get(bookmarkId)) ||
      favouriteByIdentity.get(pageIdentity(url) ?? '');
    if (favourite) {
      favourite.tabs.push(tab);
      continue;
    }
    const { domain, key } = domainKey(url) ?? { domain: '', key: `tab:${tab.id}` };
    const pinned = pinnedByKey.get(key);
    if (pinned) {
      pinned.group.entries.push({ kind: 'tab', tab });
      continue;
    }
    const group = recentByKey.get(key) ?? { domain, entries: [], key };
    group.entries.push({ kind: 'tab', tab });
    recentByKey.set(key, group);
  }
  const rank = new Map(recent.map((tab, position) => [tab.id, position]));
  const entryRank = (entry: FavouriteGroupEntry) => entry.kind === 'tab'
    ? rank.get(entry.tab.id) ?? Infinity
    : Math.min(Infinity, ...entry.tabs.map((tab) => rank.get(tab.id) ?? Infinity));
  const pinned = [...pinnedByKey.values()];
  for (const { group } of pinned) {
    group.entries.sort((left, right) => entryRank(left) - entryRank(right));
  }
  return { pinned, recent: [...recentByKey.values()] };
}

/**
 * The grouped bar's slots: each favourite group in the slot of its left-most
 * favourite, and recent groups filling every other slot, including those of
 * favourites merged into another tile.
 */
export function groupedFavouriteBarSlots(
  pinned: ReturnType<typeof domainGroups>['pinned'],
  recent: readonly FavouriteGroup[],
  slotCount: number,
): FavouriteBarSlot[] {
  const pinnedByIndex = new Map(pinned.map((item) => [item.index, item]));
  const queue = [...recent];
  const shared = (group: FavouriteGroup) => group.entries.length > 1 ? { group } : {};
  return Array.from({ length: slotCount }, (_, index): FavouriteBarSlot => {
    const favourite = pinnedByIndex.get(index);
    if (favourite) return { kind: 'favourite', index, node: favourite.node, ...shared(favourite.group) };
    const group = queue.shift();
    const lead = group?.entries[0];
    return group && lead?.kind === 'tab'
      ? { kind: 'recent', index, tab: lead.tab, ...shared(group) }
      : { kind: 'empty', index };
  });
}
