# 35. A held drag over a space opens it

**Decision.** Holding a tree bookmark or tab drag over a space pagination button for 500ms opens that space, to Bookmarks for a bookmark and to Tabs for a tab, with the same glimmer fill as a held drag over the Tabs/Bookmarks header controls.
A drag cancelled or dropped where nothing lands returns to where it began, so a hold that opened somewhere by mistake costs nothing.
Tabs from another space dropped in the Tabs list go through `moveTabs {tabIds, tree}`, the intent paste already uses.
The full contract is [build-spec §20](../build-spec/20-drag-and-drop-contract.md).

**Why.** Dropping on a space button moves an item to the end of that space; holding lets the user choose an exact position instead, without dropping and dragging again.
Reusing the header's fill keeps the hold-to-open idea consistent across the sidebar.
A tab tree reorder only moves nodes within one space, so a tab carried in from another space needs the intent that also moves its backing.

**Cost.** Favourites, tab folders, session tabs and drags from outside Hyper do not open a space.
A tab folder has no move between spaces' tab trees; dropping it on a space button still moves its tabs to the end of that space.
