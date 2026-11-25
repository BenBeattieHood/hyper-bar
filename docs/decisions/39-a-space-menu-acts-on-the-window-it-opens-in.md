# 39. A space's menu acts on the window it opens in

**Decision.** Right-clicking a space's pagination dot, or pressing the menu key or `Shift+F10` on it, opens a menu laid out as a row's is: Rename, Duplicate, Duplicate with tabs, Reload, Close, Archive and Delete space (`spaceMenu.ts`).
Each choice is one intent that acts on the asking window's unpinned tabs in the space, which the background picks as it runs, so the counts the menu shows only label it.
What each choice does is in [build-spec §12.5](../build-spec/12-spaces-windows-and-activation.md).

**Why.** Arc and Zen offer these actions on a space, and a space with many tabs needs them more than any row does.
Running each in the background serializes it with other changes and acts on the tabs as they are, not as the view last saw them, while the journal means a copy is never left half made.
Acting only on the asking window matches what the menu counts and shows; another window showing the same space is not changed under its user.
The usual next step with a copy is to change it, and naming it at once avoids two spaces with names that are easy to confuse.
Without a stand-in tab, closing the shown tabs lets the browser show a neighbouring tab, which may be another space's, and so switch space under the user.
Reloading an unloaded tab would load it in the background, spending the memory the browser freed, for a page nobody is looking at.

**Cost.** Deleting a space has no undo.
Close and Reload act on one window, so a space shown in two windows needs its menu used in each.
A copied tab, and a tab Undo reopens, is a new tab: it loads afresh, without its history, form state or scroll position.
