# 19. A drag between windows goes through the model

**Decision.** Tab, tab folder, bookmark, and favourite rows drag with the browser's native drag and drop, fed into dnd-kit by `NativeDragSensor` (`sidepanel/lib/nativeDrag.ts`); everything else drags with pointer events.
When a drag leaves its sidebar, the sidebar offers what it holds to the model (`shareDrag`) under a random token it also writes into the drag.
The worker checks the items, holds the drag (`sharedDrag.ts`) and projects it to every other window's sidebar, which plays it out on a hidden stand-in (`useSharedDrag`, `DragStandIns`) so its own targets and drop handling apply.
The worker side is in [model §3](../model/03-model-contents-and-authority.md) and the sidebar side in [build-spec §20.1](../build-spec/20-drag-and-drop-contract.md).

**Why.** Native drag and drop is the only way a browser hands one gesture from one window to another.
Pointer events stop at the window's edge, and a side panel cannot know where it sits on screen.
But a native drag shows its data only when it lands, so the receiving sidebar could neither say what was coming nor tell Hyper's drag from a page's.
Another window's sidebar must agree on what is being dragged, so the model carries the drag (decisions 1 and 2), and the worker can check that the offering sidebar owns the tabs.
Tabs reach other windows only as opaque items, as remote presence does, and the worker resolves them only for a sidebar taking them into its own window.
The drop and the source's end of the drag race to the worker, so a withdrawn drag stops being shown but stays takeable until another replaces it.

**Cost.**
- A row drag starts at the browser's own threshold, one task after it begins, because Chrome abandons a drag whose source moves away from the pointer at `dragstart`.
- The browser sends no mouse or pointer events during a native drag, so hover effects that rely on them do not follow it.
- The drag image is blank, so nothing follows the pointer outside a sidebar.
- Tab folders do not cross windows.
- Tabs from another window land only in a tab list or on a space, not in its bookmarks or trash.
- Two windows cannot be driven in one end-to-end test, so the tests send the receiving sidebar the events a drop from another window would.
