import { useLayoutEffect, useState, type RefObject } from 'react';
import { MAX_FAVOURITES } from '../../lib/bookmarks';
import { favouriteRowColumns } from '../lib/favouriteBar';
import { listen } from '../lib/listen';
import { LISTS_HIDDEN_QUERY } from './useWorkspaceLayout';

/** The bar's slots that show, laid out in its grid; the hidden global bookmarks button is not one. */
const shownSlots = (grid: HTMLElement) => [...grid.children].filter((element) =>
  element.classList.contains('favourite-slot') && element.getBoundingClientRect().height > 0);

/**
 * How many slots fit above the spaces bar: the rows shown now, plus the rows
 * of free height the spaces bar's auto margin holds, less any the panel
 * overflows by. The bar always keeps its pinned favourites, so on a panel too
 * short even for those the count falls below them and the panel overflows.
 * One tile always shows, so there is a row to measure.
 */
export function fittingFavouriteSlotCount(grid: HTMLElement, scroll: HTMLElement, spacesBar: HTMLElement): number {
  const slots = shownSlots(grid);
  const workspace = spacesBar.parentElement;
  if (slots.length === 0 || !workspace) return MAX_FAVOURITES;
  const style = getComputedStyle(grid);
  const columns = Math.max(1, style.gridTemplateColumns.split(' ').length);
  const pitch = slots[0]!.getBoundingClientRect().height + (Number.parseFloat(style.rowGap) || 0);
  if (pitch <= 0) return MAX_FAVOURITES;
  const free = spacesBar.getBoundingClientRect().top - workspace.getBoundingClientRect().top -
    (scroll.scrollHeight - scroll.clientHeight);
  const rows = Math.ceil(slots.length / columns) + Math.floor(free / pitch + 0.01);
  return Math.max(1, rows * columns);
}

/** The bar's columns on one row, the global bookmarks button's included, from the grid's content width. */
function rowColumns(grid: HTMLElement): number {
  const style = getComputedStyle(grid);
  const width = grid.clientWidth - (Number.parseFloat(style.paddingLeft) || 0) - (Number.parseFloat(style.paddingRight) || 0);
  return favouriteRowColumns(width, Number.parseFloat(style.columnGap) || 0);
}

/**
 * The favourites bar's layout. Where the lists show, the bar is one row of
 * `columns`, as many as fit, the global bookmarks button's included, so
 * `slotCount` is one fewer. Where the sidebar is too narrow for the lists, the
 * bar and the spaces bar are all it shows, so the bar's column takes every row
 * of the height between them for recent tabs, or gives up rows to fit it.
 */
export function useFavouriteSlotCount(gridRef: RefObject<HTMLElement | null>): { columns: number; slotCount: number } {
  const [layout, setLayout] = useState({ columns: MAX_FAVOURITES + 1, slotCount: MAX_FAVOURITES });
  useLayoutEffect(() => {
    const grid = gridRef.current;
    const scroll = grid?.closest<HTMLElement>('.workspace-scroll');
    const spacesBar = scroll?.querySelector<HTMLElement>(':scope > .tree-workspace > .space-pagination');
    const workspace = spacesBar?.parentElement;
    if (!grid || !scroll || !spacesBar || !workspace) return;
    const listsHidden = window.matchMedia(LISTS_HIDDEN_QUERY);
    const update = () => {
      const columns = rowColumns(grid);
      const slotCount = listsHidden.matches ? fittingFavouriteSlotCount(grid, scroll, spacesBar) : columns - 1;
      setLayout((current) => current.columns === columns && current.slotCount === slotCount ? current : { columns, slotCount });
    };
    const observer = new ResizeObserver(update);
    for (const element of [grid, scroll, workspace, spacesBar]) observer.observe(element);
    update();
    const unlisten = listen([listsHidden, 'change', update]);
    return () => {
      observer.disconnect();
      unlisten();
    };
  }, [gridRef]);
  return layout;
}
