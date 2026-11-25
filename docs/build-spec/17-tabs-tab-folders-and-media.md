# 17. Tabs, Tab Folders, and Media

Each tab row includes favicon, durable display title, active/loading/discarded state, media state, bookmark-sync action, space indicator group, and compact Close.
A row belongs to its tab, not its backing: a tab with no backing yet, or one Hyper cannot back, still shows, and when its backing arrives the same row takes the backing's place rather than closing while a copy opens.

Do not use a favicon overlay as the bookmark-state control.
Show an explicit bookmark-sync action:

- `create`: current page has no matching visible bookmark;
- `remove`: current navigation has a matching visible bookmark;
- `update`: a previously matching bookmark and tab diverged within the same domain;
- `revert`: while Update is engaged and Command/Ctrl is held, return the tab to the bookmark;
- `open`: on a bookmark row, focus the matching current-space tab.

Modifier changes must update while the pointer remains still over the action.
Put bookmark-sync controls after space indicators.
Keep static and update states mutually exclusive.

Marked, user-created tab folders shared across windows are always available.
The `autofolders` preference stores the Use Autofolders toggle:

- when on, top-level tabs render inside unsaved domain folders placed where each domain's first top-level tab sits; tabs inside manual folders are untouched;
- a top-level split view folder (§17.1) renders in the autofolder of its first pane, the tab the other was dropped on, whatever the other pane's domain;
- autofolders are a display projection over the real tab tree, so dragging a tab into a manual folder moves its backing there, and dropping a tab on or into an autofolder moves it back to the top level, where its autofolder renders it.

Automatic folders are never bookmarks and cannot be created, renamed, nested, or deleted.
Retain a tab's settled domain while navigation is loading, then regroup on completion.

Top-frame `webNavigation` start/complete/error is authoritative for favicon loading; merge native lifecycle over stale tab queries.
A cached loading state never overrides a later completion.
Events from frames inside a page are ignored: they change nothing the model shows, and busy pages load frames constantly.

## 17.1 Split views

Where the browser shows two tabs side by side in one window, Tabs mirrors it.
Chrome 140+ reports `tab.splitViewId` (`-1` for none); Chrome 155+ adds `tabs.createSplit([a, b])`, `tabs.unsplit(splitViewId)` and `tabs.create({ splitWithTabId })`, and a split holds exactly two adjacent tabs sharing a window, group and pinned state.
Report `commandCapabilities.splitViewTabs` as 2 when `createSplit` and `unsplit` exist, else 0.

- Store each split as a split view folder (§6.1) holding its backings in pane order, so it outlives the tabs.
  It stays a tab folder, so a browser without split view, an older Hyper, or anything else that cannot show panes shows it as a folder.
  The sidebar derives pane rows from the projection (`splitViewRows` in `entrypoints/sidepanel/lib/splitRows.ts`): a split view folder holding between two and `splitViewTabs` tabs, each displayed and no folder among them, renders as one row with one pane per tab (favicon, title, Close) in folder order, listed as a single leaf so drops land before or after it, never inside.
  Any other split view folder, including every one in a browser without split view, renders as a folder.
- Dropping one tab, or one non-folder bookmark or favourite, on a tab row's right half, between 25% and 75% of its height, shows a dashed drop zone over that half and sends `splitTab`.
  Offer it only while the split would stay within `splitViewTabs`, so never on a pane row in Chrome, and never on a bookmark row.
- `splitTab` with `withTabId` unsplits that tab's own split, moves it to just after the target in the tab strip, aligns its group, calls `createSplit([target, tab])`, and stores the pair, target first.
  With `url`, it opens the page through the same path as a forced-new open with `splitWithTabId` and `index: target.index + 1`, then stores the pair the same way.
  Storing creates the split view folder at the target backing's place, or at the place of the split view folder it already sits in, so they never nest.
- Keep stored splits and the browser's in step: `planSplitViews` in `entrypoints/lib/splitViewController.ts` plans from each committed snapshot, and the controller acts in the mutation queue once restored windows settle, checking the browser again before each step.
  Store a split made in the browser's own UI (`gatherSplitViewFolder`).
  Split a stored pair again where both tabs are open apart in one window and neither was seen split this browser session, because Hyper reopened it after a restart or when a parked space opened; dissolve its folder if the browser refuses.
  Dissolve a stored split whose tabs were taken apart or that holds fewer than two tabs (`dissolveSplitViewFolder`), putting its backings where it sat in order.
  Leave a folder holding a folder or more than `splitViewTabs` tabs as a folder, wait while any of a split's tabs is closed (so closing a window keeps the split) or targeted by a pending command, and do nothing where `splitViewTabs` is under 2.
  Which tabs were seen split is kept in `storage.session` (`hyperSplitViewTabIds`), pruned to open tabs, because tab IDs last only a browser session and a suspended worker must still tell a pair taken apart from one Hyper reopened.
- A pane dropped on its own row does nothing; dropped anywhere else its backing leaves the folder.
- Tab tree moves, native tab moves, and moves to another space unsplit any split they take only part of (`releaseDeparting`), because the browser keeps a split's tabs adjacent and in one group.

## 17.2 Tab strip order

The browser's tab strip shows each space's tabs in the order of its Tabs list: the space's tab tree depth first, gathered into autofolders when they are on.
The model is the authority, and the strip is rendered from it ([decision 31](../decisions/31-the-tab-strip-follows-the-model.md)).
Settings > Tabs/Bookmarks > Re-arrange browser tab bar (`syncTabStripOrder`, on by default) turns this off and back on ([decision 55](../decisions/55-tab-strip-sync-can-be-switched-off.md)).
With it off, Hyper neither reorders the strip, including when a space is shown, nor takes strip moves into the tree, and a multi-tab drag in the list moves backed tabs through the tree as a single-tab drag does.
Turning it back on puts the strip in the list's order.

- After each committed snapshot, after restored windows settle and in the mutation queue, move each window's out-of-order tabs into list order, reading the bookmarks and ownerships themselves rather than a snapshot that may trail them.
  Leave in place the longest run already in order, keep pinned tabs among pinned tabs, and keep each moved tab in its tab group.
- So a list drag, a folder change, a space change, and a navigation that completes on another site (§17 autofolders) each reorder the strip.
- Order only backed tabs; a tab with no backing yet keeps its strip place until it has one.
- Declare each of Hyper's own moves to the target ledger.
  A move Hyper did not make, as the user dragging in the tab strip, is first taken into the tab tree: the tab, or its split view folder, moves beside its new strip neighbours, preferring their shared folder.
  A move that already matches the list changes nothing.
- A new backing takes its tab's strip place, so a tab backed late, as a new tab page given its first address, moves in neither the list nor the strip.
  A tab the browser opens from a link gets its backing after the backing of its opener, or of the last tab that opener already opened next to it, matching the browser's own placement.
  Any other tab gets it after the backing of the nearest backed tab before it, in the deepest tab folder that also holds the nearest backed tab after it.
  With no backed tab before it, the backing goes before the next one's top-level node, joining no folder, and with no backed tab after it, as for a new tab at the strip's end, it goes last.
- Wait while the browser refuses tab edits, as during a drag, and stop retrying an order the browser will not take until the order changes.

## 17.3 Now Playing

Show compact current-window media controls in the footer.
The source button is independently focusable and draggable; play/pause or mute is a separate control and cannot begin drag or focus the source.

Inspect `audio`/`video` in all frames through Hyper's own page script, or, where that script is not running, by scripting the page when Hyper holds the optional `scripting` permission and access to the site.
Provide Play/Pause for media found either way, and Mute/Unmute through the tab API where neither reaches the page.
Prefer playing media, otherwise resumable paused media with progress.
Retain a paused controlled source until navigation, window departure, access loss, or invalid media removes it.

Chrome does not run Hyper's page script in pages that were already open when Hyper was installed or reloaded, so Now Playing can only mute them.
While it can only mute the page it shows, offer "Fix play/pause?"
([§27.5](27-timed-messages.md)).
Its tick asks for that site's access and the `scripting` permission, then inspects the page again; a refusal, or a page that still has no player Hyper can control, is reported.
The offer returns every five minutes while the page stays out of reach, and only into a window showing no other message.
It goes once the site's access is granted, the page can be controlled, or another tab takes Now Playing.
Firefox runs Hyper's page script in open pages and needs no such offer.

Search offers the same controls as music commands ([§21](21-search-new-tab-and-page-overlay.md)).

When the media tab is already focused, change the source action to a Back control that returns to the previously visible eligible tab.
After returning, show the media source again.
Transition between media favicon and Back with the established reduced-motion-aware 3D rotation.
