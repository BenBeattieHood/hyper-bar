# 51. A row that moves under a still pointer still takes the click

**Decision.** Whole-row click classification (`isItemClick`) judges only the pointer: a primary press released within 800ms and 3px of where it started, with no selection modifier at either end.
It does not reject a click because the row itself moved between press and release.

**Why.** A 0.5px displacement rule suited rows dragging through dnd-kit's mouse sensor, when a dragged row could still be displaced as the button came up.
Rows drag natively, and the browser sends no click after a native drag, so that rule would only catch rows that slid under a still pointer.
That happens while the list smooth-scrolls to reveal the active tab, and for 240ms while a row above tweens in or out, such as the next tab clicked straight after closing one.
Such clicks would be dropped without a word.
The browser sends the click to a row only when press and release both land on it, so a row that slides out from under the pointer still cannot take it.

**Cost.** A press on a row that is still sliding into place under the pointer opens that row, as a link or a native list would.
