# 40. A menu opened from the keyboard never covers its item

**Decision.** A context menu the menu key or `Shift+F10` opens takes its item's box as its reference, not a point.
`contextMenuAnchor` reads a `contextmenu` event without pointer coordinates as a keyboard one and answers `keyboardMenuAnchor(item)`: the item's top and bottom, and a point up to 24px in from its left edge.
`ContextMenu` gives Floating UI a reference that spans the item, so the menu opens below it and flips above it when there is no room below.
`openContextMenuFromKey(item)` dispatches that event on the item, which tree rows and the space dots use; Search results pass `keyboardMenuAnchor` straight to their menu.
A menu a pointer opens still opens at the pointer.

**Why.** A menu anchored to a zero-height point at the item's bottom edge flips up over the item near the bottom of the sidebar.
That hides the space dots, and tree rows and Search results near the bottom edge, while their menu is open.
Spanning the item lets the positioning library clear it on either side without code of its own.

**Cost.** Each place that opens a menu from the keyboard must go through these helpers, or its menu can cover its item again.
