# 54. Favourites can group by domain

**Decision.** A preference, `groupFavouritesByDomain`, on by default, folds the favourites bar into one tile per site.
Favourites on one site merge at the left-most of their slots, and this window's tabs on a favourite's site join its tile rather than taking a slot of their own.
A tile with several entries opens a list instead of a tab, and the list holds the choices a single tile would offer: open, close and the row menu.
The grouping is a pure function in `entrypoints/sidepanel/lib/favouriteBar.ts` over the same favourites and recent tabs the ungrouped bar uses, so the background model, the stored slots and the intents do not change.
Unpinning a grouped tile unpins all its favourites as one `deleteBookmark` selection, so one choice stays one intent and one undo.

**Why.** Seven slots fill quickly when several tabs share a site, and a dock or taskbar that groups windows is a familiar answer.
Merging favourites and their tabs keeps one tile per site, which is the point of grouping; a separate tile for a site's other tabs would bring the duplication back.
Clicking a grouped tile opens its list because no one entry is the obvious choice, and the list shows only this window's tabs because the bar already speaks for this window.
The list gathers entries by space, ranking spaces by their most recent entry, because a site's pages are usually split by task and spaces are how the user splits tasks; its first row stays the most recent either way.
Keeping grouping in the view leaves the stored favourites untouched, so turning the setting off brings back the exact bar the user had.

**Cost.** A favourite merged into another keeps its stored slot while hiding it, so a drop on that slot replaces it and moves it to the space's bookmarks as any replaced favourite moves.
A grouped tile needs a click more than a single tile to reach a tab.
