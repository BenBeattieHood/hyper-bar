# 53. Rejected designs stay rejected

**Decision.** Do not restore a design below without a new decision that replaces the one it cites.

Storage and identity:

- A Bookmarks pane of global bookmarks only, or of global and space bookmarks side by side; global bookmarks open from the favourites bar ([28](28-the-favourites-bar-fills-itself-and-leads-to-global-bookmarks.md)).
- Moving a deleted space's bookmarks into global bookmarks ([23](23-deleting-a-space-asks-after-its-bookmarks.md)).
- Migrating existing bookmarks into a new layout, beyond moving a favourite out of the former eighth slot ([28](28-the-favourites-bar-fills-itself-and-leads-to-global-bookmarks.md)).
- Treating `Space.rootId` as the space's identity, or moving the root when spaces reorder ([build-spec §5](../build-spec/05-durable-bookmark-model.md)).
- Tab backings in Search results or bookmark duplicate checks ([build-spec §21](../build-spec/21-search-new-tab-and-page-overlay.md)).
- One page identity that strips every query string ([build-spec §9](../build-spec/09-url-page-and-navigation-identity.md)).
- Preferences in `storage.local`, or a panel split the view persists ([5](05-preferences-live-on-the-hyper-folder.md)).
- One active space for every window ([build-spec §7](../build-spec/07-local-session-and-in-memory-state.md)).
- Failed backing cleanup kept only in worker memory ([6](06-what-stays-in-storage-local-and-why.md)).

Tabs and activation:

- Remapping windows, or reopening a window's own missing tabs, on an extension-only restart ([8](08-only-a-browser-start-restores-a-window-s-tabs.md)).
- A separate section for tabs no bookmark backs; such a tab is an ordinary row ([build-spec §17](../build-spec/17-tabs-tab-folders-and-media.md)).
- Opening a tab to keep a window alive when the browser closes its last tab ([44](44-only-a-user-choice-opens-a-blank-tab.md)).
- Split views kept only as browser state ([18](18-a-split-view-is-a-tab-folder-that-can-draw-as-one-row.md)).
- Switching groups first and resolving the destination tab after ([build-spec §12](../build-spec/12-spaces-windows-and-activation.md)).
- Clearing the selection whenever the browser activates a tab ([build-spec §12](../build-spec/12-spaces-windows-and-activation.md)).

Intents and drag:

- Chaining intents in a view, such as `selectSpace` then `openBookmark`, or `activateTab` then `closeTabs` ([3](03-one-user-choice-is-one-intent.md)).
- One intent per item for a multi-item drop, instead of one `items` payload ([3](03-one-user-choice-is-one-intent.md)).
- Rows dragged by dnd-kit pointer events alone, which cannot leave their window ([19](19-a-drag-between-windows-goes-through-the-model.md)).
- Overlapping nested drop zones or nested sortable contexts ([build-spec §20](../build-spec/20-drag-and-drop-contract.md)).

Look:

- Search in a browser popup for page Ctrl/Cmd+P, or a Search separate from the new tab page's ([build-spec §21](../build-spec/21-search-new-tab-and-page-overlay.md)).
- Favicon overlays for a row's bookmarked or updated state, which its bookmark-sync control shows ([build-spec §17](../build-spec/17-tabs-tab-folders-and-media.md)).
- Space-coloured bookmark folders, sleeping opacity on rows, duplicate-count badges, or a current-space dot beside the row's own state ([build-spec §18](../build-spec/18-bookmark-trees-and-indicators.md)).
- A selected row's fill spreading onto its detached controls ([build-spec §19](../build-spec/19-selection-row-states-and-accessibility.md)).
- A pop-up that opens the Tabs and Bookmarks lists where the sidebar is too narrow to show them ([57](57-a-sidebar-too-narrow-for-its-lists-shows-none.md)).
- A grouped tile's list opening beside the in-page sidebar, over the page, in an overlay frame; it opens below its tile ([build-spec §16](../build-spec/16-favourites.md)).

**Why.** Each was built or proposed and then replaced, and old commits, tests and prose still show them, so an agent reading history can take one for an open option.

**Cost.** The list needs pruning once an item can no longer plausibly return.
