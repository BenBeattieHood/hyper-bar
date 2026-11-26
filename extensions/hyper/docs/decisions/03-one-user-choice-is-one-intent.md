# 3. One user choice is one intent

**Decision.** A view sends a single intent for a single choice, and the background performs every step of it:

- Opening a page that lives in another space, or focusing a tab in another space, switches the window first (`windowSpaceChoice.ts`).
- Creating a space takes the creating window to it.
- A new tab page that hands the user to an open tab closes itself.
- Creating or copying a favourite carries its slot (`favouriteSlot`).
- A search from the sidebar opens its own tab (`navigateTab` with `newTab`).
- Dropping a selection sends one intent carrying `items` (`eachItem` in `modelIntentPayloads.ts`).

**Why.** A view that sequences intents (create, then select; activate, then close) leaves the gap between them open to every other event: another choice in the same window, a browser event, a worker suspension.
The background decides in one place which choice is latest (`switcher.admit` when an intent is admitted, `runIfLatest` when it runs), so a stale step cannot undo a newer one.
One intent also means one settlement, so the view waits for a single outcome.

**Cost.** Intent payloads grow a little (`favouriteSlot`, `newTab`, `items`).
`items` runs in order as one command but is not transactional: if one item fails, the ones before it stay done and the command reports failure.
Each item is an ordinary bookmark change that the user can see and undo.
Bookmarking several tabs closes up past a tab already bookmarked there, which is the one place the background adjusts an item from an earlier result.
