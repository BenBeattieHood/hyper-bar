# 50. An archived space stays a space

**Decision.** Archiving marks the space folder's title metadata `hyper.archived`; the folder stays among the other space folders with its bookmarks and its tab backings.
Archived and shown spaces share the folder's order: archiving or unarchiving without a chosen place moves the folder to the end, so it lands last in the archived list or in pagination.
`deriveSpaces` still returns archived spaces, flagged `archived: true`, and every place that chooses or shows a space a window can switch to goes through `shownSpaces`: pagination, window maintenance, tab routing, favourites, the model port projection, remote tabs, search scopes and deletion's neighbour choice.
One intent, `setSpaceArchived`, archives or unarchives a space and optionally places its folder before another space, so a drop into the archived list or onto pagination is one user choice.
What archiving and unarchiving do to windows and tabs is in [build-spec §12.5](../build-spec/12-spaces-windows-and-activation.md).

**Why.** Bookmarks are the durable store, so the flag lives on the folder and survives sync and reinstall like the rest of a space.
Keeping archived spaces in the derived list means rename, delete, search and the backings all work unchanged; only choice points filter, and the filter is one named function the reader can grep for.
A separate archive folder would have made archiving a move across parents and doubled the folder-identity rules.

**Cost.** Pagination positions are not folder indexes, because archived folders sit between shown ones; a pagination reorder resolves its destination against the real folder children.
Any new code that picks a space for a window must remember `shownSpaces`, or it can land a window on an archived space; `spaceSwitch` and `spaceActivation` reject an archived target as the last line of defence.
Search still finds an archived space's bookmarks, ranked below every other space's.
