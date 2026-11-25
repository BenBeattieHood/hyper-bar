# 14. A view shows its own edit at once, without trusting it

**Decision.** When a view sends an intent that changes something it shows, it may lay the expected result over the projection it renders (`modelOverlay.ts`).
The edit is held against its command and retired by evidence: when the revision that settles the command arrives, or at once if the intent was rejected or the port dropped.
Nothing is retired by a timer, and an overlay never reaches the model or another view.

**Why.** Waiting for the browser makes a drag or a toggle visibly snap back before it lands.
Writing the guess into view state instead would make the view a second authority that can disagree with the model.
A layer that is removed exactly when the model carries the change gives the first without the second: a settling revision carries both the terminal status and the tree that proves it.

**Cost.** Optimistic transforms must mirror the background's effect closely (for example `moveBookmarkOptimistically` reproduces the browser's index rule for a move within one parent), or the view jumps when the overlay is retired.
