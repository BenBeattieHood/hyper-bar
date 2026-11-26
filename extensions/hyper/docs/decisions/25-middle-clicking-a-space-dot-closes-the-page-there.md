# 25. Middle-clicking a space dot closes the page there

**Decision.** Middle-clicking another space's dot on a tab or bookmark row, or on a Search result, closes every tab of that page the space holds, in this window and others, without switching space.
Search stays open on its query with the field focused, so a result's other copies can be closed in turn.
The view sends an opaque local reference rather than tab IDs, and the worker resolves the tabs (`spacePageTabIds` in `remoteTab.ts`); the intent is in [model §3](../model/03-model-contents-and-authority.md).
Every client may send it, page Search included, because the worker accepts only a source in the client's own window; page Search still cannot name tabs to close.

**Why.** Middle-click already closes a tab row, and the dot stands for that space's copy of the page, so the gesture means the same wherever a dot appears.
Sending a reference rather than tab IDs keeps other windows' tabs out of the view (decision 16).

**Cost.** A dot can stand for several tabs, and middle-clicking it closes them all.
A Search result shows dots only for this window's tabs, yet the close also reaches that space's copies in other windows.
Middle-clicking the collapsed summary of several spaces does nothing.
