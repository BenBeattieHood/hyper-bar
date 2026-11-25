# 57. A sidebar too narrow for its lists shows none

**Decision.** Below 150px the sidebar shows only the space's title, the favourites and the spaces bar, and nothing opens the Tabs and Bookmarks lists there ([build-spec §15](../build-spec/15-side-panel-layout.md)).
The "Spaces and tabs" pop-up that opened them at 99px and below is gone, with its `Cmd/Ctrl+Shift+E` shortcut and its Search row.
`useWorkspaceLayout` reports the lists hidden at the same `(width < 150px)` breakpoint as the CSS, so expanding the folders that hold open tabs, and revealing the active tab, wait until the lists show.

**Why.** Rows do not fit below 100px: their controls overlapped, so a click on a favicon landed on the hidden bookmark indicator, the header and toolbar clipped, and labels shrank to one letter.
A sidebar that narrow is a rail for switching spaces and opening favourites, yet at that width the spaces bar showed only inside the pop-up.

**Cost.** At 99px and below the top bar has no Search or Settings button, though their keys still work.
Below 150px the space's tabs and bookmarks are reachable only through Search or by widening the sidebar.
