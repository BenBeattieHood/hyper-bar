# 15. Side-Panel Layout

Stable top-to-bottom regions:

1. editable current-space title with Search and Settings;
2. seven-slot Favourites and the global bookmarks button;
3. Tabs/Bookmarks workspace;
4. footer with Now Playing/recent controls and ordered space pagination;
5. contextual drag targets such as space pagination destinations and Trash.

Below 720px, the `combineTabsAndBookmarks` preference defaults off; when enabled, it stacks Bookmarks above Tabs.
The combined Tabs list hides every tab whose page matches a bookmark in the space's tree (`displayedSpaceTabs` in `sidepanel/hooks/useTabTree.ts`, through `findBookmarkPathByUrl()`), because that bookmark row already shows it.
Between the two panes sits a focusable horizontal separator: Up/Down steps by five percentage points, Home/End choose 20/80, double-click resets to 50, and pointer dragging keeps both panes at least 96px tall where geometry permits.
The new position shows locally during a gesture, and only when a drag or key press ends is it saved, rounded and clamped to 20-80%, as the `bookmarkPanelPercent` preference.
Keep root folder creation and Recent Tabs available above the combined list.
The Recent Tabs menu lists up to twenty of the window's other open tabs, most recently used first, then, below a "Recently closed" separator, up to ten recently closed web pages from `sessions.getRecentlyClosed`; choosing one restores that exact session.
When disabled, mount one pane and expose Tabs/Bookmarks controls; hovering the other control for 500ms during a drag switches view and may switch back repeatedly in the same gesture.
Holding a bookmark or tab drag over another space's pagination button plays the same fill on it and opens that space mid-drag ([§20](20-drag-and-drop-contract.md)).

At 720px and wider, ignore the compact preference, mount both panes side by side, order them according to sidebar side, and support direct cross-pane dragging.
While the lists show, the favourites bar is always one row of as many columns as fit, the global bookmarks button's included (`favouriteRowColumns` in `sidepanel/lib/favouriteBar.ts`).
The columns share the row's width evenly, so tiles are the width divided by the column count, less the gaps.
They shrink to 28px to keep the seven slots and the button, then the bar drops a slot at a time.
Where wide enough, from about 385px, it adds a slot each time another fits at 34px or more, so tiles stay between 34px and about 39px there.
Like the column's, these extra slots hold recent tabs only; with no recent tab to fill one, it shows as an empty slot that takes no drop or paste.
To fit, it drops empty slots and then the least recent tiles, never a pinned favourite, so pinned favourites that do not fit run onto a second row.
Grouped by domain, it fits the same way.
Below 240px, tabs and bookmarks inside folders are not indented.
Below 150px, the favourites stack in one column, the global bookmarks button is hidden, and the Tabs and Bookmarks lists and their header are hidden, leaving the spaces bar at the foot.
Nothing opens the lists there; Search still finds the space's tabs and bookmarks ([decision 57](../decisions/57-a-sidebar-too-narrow-for-its-lists-shows-none.md)).
In that column, the tiles fill the height down to the spaces bar, and the column refills as the panel's height changes.
Recent tabs fill the slots past the seventh; these extra slots hold recent tabs only, so they are not drop targets, and pinning one pins it into the first free favourite slot.
On a panel too short for seven slots, the column gives up empty slots first, then the least recent tabs, but always keeps every pinned favourite and at least one tile, so only a panel too short for those overflows.
The column never groups by domain, whatever the setting; each tab and favourite keeps its own tile.
Each tile spans the column's width and names its page under its icon on one line, clipped at the tile's edge without an ellipsis.
Hovering a tile shows its full name in the browser's native tooltip instead of the label below the bar.
In place of the space line, a tile open in a space is washed faintly in that space's colour, more strongly for the window's current tab; a favourite open in no space keeps the neutral tile.
Neighbouring tiles in the same space join into one block, with no gap or rounded corners between them.
Below 150px, the top bar shrinks to the space's title in compact 12px text, the same size at every narrower width.
At 99px and below, the top bar keeps only the space's title, without its Search and Settings buttons, and controls compress further at 49px and below.

Pagination remains visible in every workspace mode.
When the spaces' names do not fit, each space shows as a dot.
Dots that do not fit stay on one row, clipped: the row scrolls to centre the current space's dot as far as it can and fades at each edge that hides a dot.
Keep Add/Trash aligned right.
During any drag, Trash replaces Add in the same slot (`SpacePaginationNav.tsx`).
Trash is disabled when the dragged item cannot be deleted (`activeDragTrashDisabled` in `sidepanel/lib/dragPresentation.ts`): an item `trashDropAction()` in `lib/drag.ts` has no action for, such as an external drag, or the last shown space, though an archived space always can be.
During bookmark-scope dragging, expose destination space roots; when Trash is active, its full-width overlay fades the other destinations without layout shifts.
Each space's dot opens that space's menu ([§12.5](12-spaces-windows-and-activation.md)).
When any space is archived, or during any space drag, an Archive button sits left of the pagination dots, styled like Add.
Clicking it swaps the Tabs and Bookmarks workspace for a flat list of archived spaces, as the global bookmarks button does, and closes the global bookmarks panel; clicking an archived row does nothing.
Dropping a space on the Archive button archives it; holding a space drag over the button for 500ms opens the list so the space can be dropped at a chosen row.
An archived row dragged onto a pagination dot unarchives the space before or after that dot, by which half the pointer is over; dropped on Trash it is deleted.
A shown space dragged onto another dot likewise lands beside that dot's nearer edge, left or right.
While a space drag is over the pagination, the dots hold still and a bar marks the edge it would land beside, showing through the drag preview, which turns see-through over a dot; a keyboard drag has no pointer, so a step right lands after the dot and a step left before it.

Settings > Tabs/Bookmarks > Import bookmarks requires an explicit import destination for each import.
The Import bookmarks button is always available; after the user selects a browser bookmark folder, a dialog asks for the destination space or Global bookmarks, and Import stays disabled until one is chosen.
Imports target that space's `Space.rootId` or the global bookmarks root, never the active space by default.

## 15.1 List ends

The Tabs list and the bookmark lists (the space's Bookmarks and Global bookmarks) end with their last row, then the root drop target, with no add row.
"New tab" and "Add bookmark" add rows used to close these lists; they are hidden for now, and reverting the commit that removed them restores them.
A new tab still opens by double-clicking empty Tabs space, and the current tab is still bookmarked at the end of the space's list root with its `addBookmark` key or by dragging it there.

The Tabs header (`WorkspaceViewToolbar.tsx`) offers "Create tab folder" and the "Recent tabs" menu, and the Bookmarks header offers "Create bookmark folder"; the combined list's header in `sidepanel/App.tsx` offers "Create tab folder" and "Recent tabs".

When other windows hold tabs of the space, the Tabs list closes with a footnote at its very bottom, "+N open in other windows", from the projection's `otherWindowTabCounts` ([model §3](../model/03-model-contents-and-authority.md)).
It counts live tabs, so a closed window's tabs never count; a blank page counts, a pinned tab does not, and at zero the footnote is absent.
It is 10px faint text below the last row, the list's drop space and any other sessions, resting on the list's bottom edge (or ending its scroll), inset 12px each side at every width, wrapping into balanced lines when narrow.
Its tooltip says how many tabs from the space are open in other windows.
