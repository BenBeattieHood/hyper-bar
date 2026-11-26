# 23. Deleting a space asks after its bookmarks

**Decision.** Dropping a space that holds bookmarks on the bin asks whether to move them to the default space, which is the first shown (unarchived) space other than the one being deleted (`spaceDeletionController.ts`).
Move gathers them in a new folder in that space, Skip deletes them with the space, and Cancel keeps the space.
The answer travels on `deleteSpace` as `moveBookmarks`, and the background moves the bookmarks before anything closes ([build-spec §12.5](../build-spec/12-spaces-windows-and-activation.md)).
A space with no bookmarks is deleted without asking.

**Why.** Deleting a space removes its whole bookmark folder, so one drag could lose every bookmark in it.
Sending the answer with the deletion keeps the choice one intent, and moving first means a failure leaves each bookmark in one space or the other.

**Cost.** A deletion that fails after the move leaves the space without its bookmarks.
The count in the question comes from the sidebar's projection, so a bookmark added elsewhere meanwhile is moved without being counted.
