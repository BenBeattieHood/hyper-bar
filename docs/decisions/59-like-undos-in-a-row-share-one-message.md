# 59. Like undos in a row share one message

**Decision.** An undo offer may name a series and the items it acted on ([build-spec §27.4](../build-spec/27-timed-messages.md)).
While a message of the same series shows, `timedMessages.ts` joins the next offer into it: the text counts the distinct items, the time starts again, and Undo undoes the whole run, newest first.
The undos of one run share a map of the IDs they gave bookmarks they made again, which `recreateTrees`, `restorePlacements`, `restoreTabFolder` and `rebuildTabTree` read and add to.

**Why.** One message per window meant closing three tabs one by one left only the last close undoable, though the user saw them as one tidy-up.
Undoing a run newest first puts each item back on top of the state it was taken from, but a newer undo can make a folder again under a new ID that an older undo still knows by the old one; the shared map is what lets the older undo find it.

**Cost.** A joined message loses the single item's title as its detail.
Undo acts on the whole run; there is no way to undo only its last action.
