/**
 * Where a grouped tile's list opens: below the whole bar in the browser's side
 * panel, and directly below the tile in the in-page sidebar.
 */
export type FavouriteGroupPlacement = 'bar' | 'tile';

/** Where the in-page sidebar's bar is too narrow for a list to sit clear of the tiles, its lists open below their tiles and on click only. */
export const NARROW_IN_PAGE_WIDTH = 290;
export const GROUP_LIST_WIDTH = 280;

interface Box {
  bottom: number;
  left: number;
  right: number;
  top: number;
}

/** Below this much room under its tile, a list opens above the tile instead, if there is more room there. */
const MIN_ROOM_BELOW = 160;

/**
 * A list below its tile, from the tile's left edge but kept inside the
 * section's padding, or above the tile where the room below is too short.
 * Offsets are from the section; `viewport` bounds where the list may reach.
 */
export function tileListBox(section: Box, tile: Box, inline: number, viewport: { bottom: number; top: number }) {
  const width = Math.min(GROUP_LIST_WIDTH, section.right - section.left - 2 * inline);
  const left = Math.max(inline, Math.min(tile.left - section.left, section.right - section.left - inline - width));
  const below = viewport.bottom - tile.bottom;
  const above = tile.top - viewport.top;
  return below >= MIN_ROOM_BELOW || below >= above
    ? { left, maxHeight: below, top: tile.bottom - section.top, width }
    : { bottom: section.bottom - tile.top, left, maxHeight: above, width };
}
