import { useEffect, useState } from 'react';
import { NARROW_IN_PAGE_QUERY, type FavouriteGroupPlacement } from '../lib/favouriteGroupPlacement';
import { listen } from '../lib/listen';
import { isInPageSidebar } from '../lib/sidebarPlacement';

/** Where grouped tile lists open, and whether only a click opens them, as the in-page sidebar's width allows. */
export function useFavouriteGroupPlacement(): { clickOnly: boolean; placement: FavouriteGroupPlacement } {
  const inPage = isInPageSidebar();
  const [narrow, setNarrow] = useState(() => matchMedia(NARROW_IN_PAGE_QUERY).matches);
  useEffect(() => {
    if (!inPage) return;
    return listen([window, 'resize', () => setNarrow(matchMedia(NARROW_IN_PAGE_QUERY).matches)]);
  }, [inPage]);
  return { clickOnly: inPage && narrow, placement: inPage ? 'tile' : 'bar' };
}
