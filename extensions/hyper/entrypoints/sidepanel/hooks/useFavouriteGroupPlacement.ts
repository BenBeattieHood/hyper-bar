import { useLayoutEffect, useState } from 'react';
import { NARROW_IN_PAGE_WIDTH, type FavouriteGroupPlacement } from '../lib/favouriteGroupPlacement';
import { isInPageSidebar } from '../lib/sidebarPlacement';

/** Where grouped tile lists open, and whether only a click opens them, as the in-page sidebar's width allows. */
export function useFavouriteGroupPlacement(): { clickOnly: boolean; placement: FavouriteGroupPlacement } {
  const inPage = isInPageSidebar();
  const [narrow, setNarrow] = useState(false);
  useLayoutEffect(() => {
    if (!inPage) return;
    const shell = document.querySelector<HTMLElement>('.app-shell');
    if (!shell) return;
    const update = () => setNarrow(shell.getBoundingClientRect().width < NARROW_IN_PAGE_WIDTH);
    const observer = new ResizeObserver(update);
    observer.observe(shell);
    update();
    return () => observer.disconnect();
  }, [inPage]);
  return { clickOnly: inPage && narrow, placement: inPage ? 'tile' : 'bar' };
}
