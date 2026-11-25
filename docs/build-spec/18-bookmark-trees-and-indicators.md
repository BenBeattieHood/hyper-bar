# 18. Bookmark Trees and Indicators

Render only the active space's bookmarks as a single tree, without scope separators or labels.
All folder icons use the neutral folder color; they do not take the space color.

Tree behavior:

- one flattened `SortableContext`, never nested sortable contexts;
- visible-node flattening with source descendants removed from candidates;
- whole-row collision target;
- vertical pointer placement plus source-relative horizontal depth projection;
- valid-parent clamping and ancestor-boundary snapping;
- before/after line-and-dot marker positioned without affecting layout;
- inside folder highlight and child marker;
- reject self/descendant cycles;
- stable collapsed inside target expands after 2.3 seconds;
- folders toggle; URL rows open; slow title double click renames;
- direct root/folder actions create a bookmark for the current tab or create a folder, through the same path, and open the target folder and its ancestors so the new row shows; at the root, bookmarking the current tab is its `addBookmark` key ([§15.1](15-side-panel-layout.md#151-list-ends));
- collapsed folders hide subfolder creation and show compact descendant count/open state;
- bookmark rows never receive sleeping opacity.

An empty tree shows the status "No bookmarks found" above an Import bookmarks button, both centred and never wider than the list.
The message wraps, hyphenating a word too long for its line, and the button's label truncates rather than overflow; at 189px and below the button's padding tightens so the whole label fits the narrowest list, 150px wide.

Bookmark/folder Close is an attached compact action that closes matching live tabs without deleting the bookmark.
Delete remains a separate explicit operation/Trash outcome.

Open-space indicators derive from live ownership, not backing placement.
Current-space open/active state is represented on the row and bookmark-sync control, not by a redundant extra dot.
Other-space destinations are detached sibling buttons.
A destination whose tab is in the current window has a filled indicator; one whose tab is only in another window has a hollow indicator ([model §3](../model/03-model-contents-and-authority.md) defines remote presence).
If one other space is available, show it directly.
If several are available, show one summary containing miniature correctly colored dots; expanding animates to the total width of the individual 30px controls and collapses when pointer/focus leaves the group.
Selecting a destination focuses that exact owned tab/space.
Middle-clicking a destination closes the row's page wherever that space has it open, in any window, without switching space ([decision 25](../decisions/25-middle-clicking-a-space-dot-closes-the-page-there.md)); middle-clicking the collapsed summary does nothing.
