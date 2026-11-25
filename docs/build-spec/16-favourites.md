# 16. Favourites

- Exactly seven logical slots with stable `hyper.favouriteSlot` metadata, then a global bookmarks button.
- A favourite is pinned: it keeps its slot and shows a small pin.
- Slots without a favourite show this window's tabs, most recently used first, the current tab included, leaving out Hyper pages, new tab and blank pages, and tabs a favourite stands for. The order holds while the pointer is in the top third of the sidebar or a drag is under way, and changes animate.
  While held, clicking a tile moves nothing; a newly recent tab takes the slot of the tab it pushes out, and a closed tab's slot goes to the next most recent.
  Taking a recent tab off the bar is the exception: the remaining recent tabs take their most recently used order at once.
- While Now Playing is shown, recent tabs leave out music sites such as YouTube Music and Spotify, because music plays in the background and Now Playing already controls it.
- Slots left over are drop targets, not commands.
- Middle-click unpins a favourite and takes a recent tab off the bar until it is next used; neither closes a tab.
- `Ctrl`/`Cmd`+middle-click closes a tile: it takes the tile off the bar as middle-click does and closes the tile's tabs.
- Favourites and recent tabs have the row menu: cut, copy, paste, reload, pin or unpin, and close; a recent tab's menu also has Remove, which takes it off the bar like middle-click, leaving the tab open. Unpin, Remove and Close show their click beside them. Pasting on a slot pins as a drop there would.
- The global bookmarks button shows `hyper/bookmarks` in place of the space's workspace, expanding down from the button; Escape, another click or a change of space closes it. Holding a drag over it opens it; dropping tabs bookmarks them there, favourites copy there, and tree bookmarks move there unless the copy modifier is held.
- Always show favicon tiles with accessible title/URL labels.
- Open count and state derive from same-context live tabs across all spaces/windows.
- Favourite and recent tiles have no border; only the global bookmarks button keeps one.
- A line drawn like the space list's line (2px, nearly tile-wide, half strength, full strength on the current tab's tile) runs along the bottom of a tile and wears the colour of the space its tab is in: a recent tab's own space, and for a favourite the space opening it goes to ([§13.2](13-opening-reuse-and-deduplication.md)).
  A favourite open in no space has no line.
- The tile that is this window's current tab has a background tinted with its space colour.
- Clicking a tile opens its tab in that space, switching the window to it.
- Sleeping state does not reduce opacity.
- Bookmark to Favourite copies.
- Favourite to bookmark tree copies.
- Replacing a favourite moves the displaced item into the acting window's active space bookmark root instead of deleting it.
- A bookmarkable live tab may populate a slot.
- A second ordinary click may edit the favourite title; `Alt` always force-opens instead.

## Grouped by domain

Settings > Favourites/Recent > Group tiles by domain (`groupFavouritesByDomain`, on by default) shows one tile per site, like a taskbar that groups windows.
A sidebar too narrow for its lists never groups, as its single column of named tiles has no room for a tile's list ([§15](15-side-panel-layout.md)).
See [decision 54](../decisions/54-favourites-group-by-domain.md).

- A site is a tab's domain without `www.`; a favourite's tab stays in its favourite's group even after it wanders to another site.
- Favourites on one site share the tile of the left-most of them, and this window's tabs on a favourite's site join that tile.
- The slots of the favourites that merged into another hold recent groups; dropping or pasting on such a slot replaces the hidden favourite as it would any other.
- Recent groups fill the free slots in the order of their most recently used tab, and hold that order as single tabs do.
- A group with one entry is an ordinary tile with its ordinary label, menu and clicks.
- A tile with several entries shows the edge of a second card under it and names its site.
- Hovering such a tile, or focusing it from the keyboard, lists its entries below the bar, gathered by space and most recently used first within a space.
- In the in-page sidebar ([§21.2](21-search-new-tab-and-page-overlay.md#212-in-page-sidebar)) the list drops directly below the tile instead, from the tile's left edge kept inside the bar's padding, or rises above the tile when there is too little room below.
- Where the in-page sidebar is narrower than 290px, only a click or the keyboard opens the list; hovering names the tile as for any other.
- Spaces in the list rank by their most recently used entry, so the first row is still the most recent; entries in no space come last.
- An entry's space is its tab's space; a favourite's is its most recent tab's here, otherwise the space opening it goes to.
- Each row carries its space's colour as a line down its left edge, drawn like the space line under a tile: half strength, full strength on the current tab's row.
  Consecutive rows in the same space join into one unbroken line.
- The list lists only this window's tabs, marks favourites with a pin and the current tab with a tint.
- Clicking such a tile toggles its list instead of opening a tab; the list stays open until Escape, a choice, another click on the tile, or a click or focus elsewhere.
- `ArrowDown` or `Enter` on the tile enters the list at its first row and `ArrowUp` at its last; in the list `ArrowUp`/`ArrowDown` move and wrap, `Home`/`End` jump, `Enter` opens, `Delete` closes the row's tabs, and `Escape` closes the list and hands focus back to the tile.
- Clicking a row opens it as its tile would; middle-clicking it or its close button closes its tabs.
- A row has the row menu: a tab's offers pin, cut, copy, reload, remove and close; a favourite's offers unpin, cut, copy, reload and close.
- Middle-click on a grouped tile unpins all its favourites, or takes all its tabs off the bar; `Ctrl`/`Cmd`+middle-click also closes them, and the tile's menu acts on all of them.
