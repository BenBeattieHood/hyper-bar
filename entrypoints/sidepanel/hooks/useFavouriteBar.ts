import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { MAX_FAVOURITES, type BookmarkNode, type BrowserTab } from '../../lib/bookmarks';
import {
  domainGroups,
  favouriteBarSlots,
  fitFavouriteBarSlots,
  groupedFavouriteBarSlots,
  heldOrder,
  heldRecentOrder,
  recentBarTabs,
  unpinnedSlotCount,
  withoutDismissed,
  type FavouriteBarSlot,
} from '../lib/favouriteBar';
import { listen } from '../lib/listen';

/**
 * Whether the pointer is in the top third of the sidebar, where the favourites
 * bar sits, or anywhere above the bar's foot where it runs further down. Focus
 * is ignored: clicking a tile hands focus to the tab it opens while the pointer
 * stays over the bar.
 */
function usePointerNearBar(barRef: RefObject<HTMLElement | null>): boolean {
  const [near, setNear] = useState(false);
  useEffect(() => {
    const move = (event: PointerEvent) => setNear(event.clientY < Math.max(
      window.innerHeight / 3,
      barRef.current?.getBoundingClientRect().bottom ?? 0,
    ));
    const leave = () => setNear(false);
    return listen(
      [window, 'pointermove', move, { passive: true }],
      [window, 'pointerdown', move, { passive: true }],
      [document.documentElement, 'pointerleave', leave],
    );
  }, [barRef]);
  return near;
}

/**
 * The favourites bar's slots: pinned favourites where they were pinned, and the
 * window's most recent tabs in the rest. The recent tabs hold still while the
 * pointer is near the bar or something is being dragged, so a tile never moves
 * as it is reached for, except that taking one off the bar lets the rest catch
 * up at once. A recent tab taken off the bar stays off until it is
 * next used, without being closed. Music the model reports Now Playing as
 * holding stays off too.
 *
 * With `groupByDomain`, the bar shows one tile per domain instead, and a
 * domain group holds its place as a tab does.
 *
 * `slotCount` is how many tiles fit. Past the favourites' own slots, the extra
 * ones hold recent tabs only; in the bar's row they show empty when no tab
 * fills them, but in the `column`, where the lists are hidden, only when one
 * does. Fewer than the favourites' own slots, the bar keeps every pinned
 * favourite and drops empty slots, then the least recent tabs.
 */
export function useFavouriteBar({
  backgroundMusicTabIds,
  barRef,
  column,
  dragging,
  extensionOrigin,
  favourites,
  groupByDomain,
  hold,
  slotCount: fit,
  tabBookmarkLinks,
  tabs,
  windowId,
}: {
  backgroundMusicTabIds: readonly number[];
  barRef: RefObject<HTMLElement | null>;
  column: boolean;
  dragging: boolean;
  extensionOrigin: string;
  favourites: readonly (BookmarkNode | undefined)[];
  groupByDomain: boolean;
  /** Holds the order, as the pointer near the bar does, such as while a tile's list is open. */
  hold: boolean;
  slotCount: number;
  tabBookmarkLinks: Readonly<Record<number, { bookmarkId: string } | undefined>>;
  tabs: readonly BrowserTab[];
  windowId: number | null;
}): { dismiss(tabs: ReadonlyArray<BrowserTab & { id: number }>): void; slots: FavouriteBarSlot[] } {
  const pointerNearBar = usePointerNearBar(barRef);
  const slotCount = Math.max(MAX_FAVOURITES, fit);
  // Tab ids, or domain group keys while grouped.
  const shownKeys = useRef<unknown[]>([]);
  // Taking a tab off the bar is a deliberate rearrangement, so the bar catches up at once.
  const releaseHold = useRef(false);
  const holding = (pointerNearBar || dragging || hold) && !releaseHold.current;
  const [dismissed, setDismissed] = useState<ReadonlyMap<number, number>>(new Map());
  const dismiss = useCallback((dismissedTabs: ReadonlyArray<BrowserTab & { id: number }>) => {
    releaseHold.current = true;
    setDismissed((current) => {
      const next = new Map(current);
      for (const tab of dismissedTabs) next.set(tab.id, tab.lastAccessed ?? 0);
      return next;
    });
  }, []);
  const recent = useMemo(() => {
    const favouriteIds = new Set(favourites.flatMap((node) => node ? [node.id] : []));
    const linkedTabIds = new Set(Object.entries(tabBookmarkLinks).flatMap(([tabId, link]) =>
      link && favouriteIds.has(link.bookmarkId) ? [Number(tabId)] : []));
    return withoutDismissed(
      recentBarTabs({
        backgroundMusicTabIds: new Set(backgroundMusicTabIds),
        extensionOrigin,
        // Grouped, a favourite's tabs stay in so its tile can list them.
        favourites: groupByDomain ? [] : favourites,
        linkedTabIds: groupByDomain ? new Set() : linkedTabIds,
        tabs,
        windowId,
      }),
      dismissed,
    );
  }, [backgroundMusicTabIds, dismissed, extensionOrigin, favourites, groupByDomain, tabBookmarkLinks, tabs, windowId]);
  const groups = useMemo(() => groupByDomain
    ? domainGroups({
      favourites,
      recent,
      slotCount,
      tabBookmarkIds: new Map(Object.entries(tabBookmarkLinks).flatMap(([tabId, link]) =>
        link ? [[Number(tabId), link.bookmarkId]] : [])),
    })
    : undefined, [favourites, groupByDomain, recent, slotCount, tabBookmarkLinks]);
  let slots: FavouriteBarSlot[];
  let keys: unknown[];
  if (groups) {
    const count = slotCount - groups.pinned.length;
    const shown = holding
      ? heldOrder(shownKeys.current, groups.recent, count, (group) => group.key)
      : groups.recent.slice(0, count);
    slots = groupedFavouriteBarSlots(groups.pinned, shown, slotCount);
    keys = shown.map((group) => group.key);
  } else {
    const count = unpinnedSlotCount(favourites, slotCount);
    const shown = holding
      ? heldRecentOrder(shownKeys.current as number[], recent, count)
      : recent.slice(0, count);
    slots = favouriteBarSlots(favourites, shown, slotCount);
    keys = shown.map((tab) => tab.id);
  }
  useEffect(() => {
    shownKeys.current = keys;
    releaseHold.current = false;
  });
  return { dismiss, slots: fitFavouriteBarSlots(slots, fit, column ? MAX_FAVOURITES : slotCount) };
}
