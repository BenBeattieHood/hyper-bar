# 12. Spaces, Windows, and Activation

Spaces are global.
Each native window independently owns:

- its active-space preference;
- its live tab subset in each space;
- its per-space last-active backing token;
- one Chromium group per represented space;
- session-local group IDs.

## 12.1 Explicit space switching

Switching must feel immediate and obey latest intent:

1. Increment the activation version and establish an activation token.
2. Resolve the destination tab before doing broad group reconciliation.
3. Prefer the window-specific last-active token, then a valid live active/remembered destination, then the first owned tab, then a newly routed blank tab only when genuinely empty, no tab in the window is still being placed (including one dragged in from another window), and the user chose the space.
   Reconciling a window after a window event never opens a blank tab, so closing the only tab of a window, such as one dragged out of another window, closes that window.
4. Focus/activate the destination tab first, before any sibling group collapses: collapsing the group that holds the active tab makes the browser activate a different tab, which would otherwise be remembered as the space's last-used tab.
5. Let the resulting native activation participate in expanding the destination group and collapsing inactive Hyper groups.
6. Persist active space before slower reconciliation finishes.
7. Reject stale group/activation events from an older switch without blocking a genuine later browser activation.
8. A slower earlier request never switches the UI or browser back.

When reconciling an already-selected space on startup, preserve an existing browser-active owned tab and write its token as the new remembered tab.
Explicit later switching remains remembered-token-first.

## 12.2 Browser-driven activation

Whenever the browser activates a tab by any mechanism, Hyper's active row and selected space must match it.
Expand that tab's owned group and collapse other Hyper groups.
Selection survives an external activation ([§19](19-selection-row-states-and-accessibility.md)).

## 12.3 Chromium groups

- Group ownership, mapping and recovery follow [model §7](../model/07-critical-event-policies.md): one owned group per `(windowId, spaceId)`, session mapping and live ownership beating ordinal-title recovery, and arbitrary user groups never taken.
- Create a new group with the window it belongs to; Chromium otherwise creates it in the last focused window and moves the tabs there.
- Name groups with compact ordinals such as `𝒉¹`, `𝒉²`, and so on.
- A space's colour is the colour its open tab groups wear, read live and stored nowhere else; a window prefers the space's group in that window, else one in another window.
  A space with no open group has no colour and is drawn in the muted tone of the sidebar's icons.
  A group Hyper creates takes the colour the space's groups wear in other windows, else one derived from the space's ID.
  Every owned group of a space, in every window, wears one colour: a colour the user gives a Hyper group in the browser reaches the space's groups in other windows ([decision 45](../decisions/45-a-space-wears-its-tab-group-s-colour.md)).
- Serialize group changes per window and bracket programmatic updates.
- Expand active and collapse inactive owned groups.
- Do not explicitly discard inactive tabs during switching.

Moving a Hyper-owned native group reorders the durable space folders by `Space.id`, never by `Space.rootId`, and propagates that durable order to other windows.
Pagination reorder likewise moves the durable space folder and then updates native group order.

A tab dragged from one window's tab strip into another joins the space that window shows.
Dragged out into a new window, it keeps its own space, and the new window shows that space.
The browser attaches the tab while the drag still holds every tab strip, refusing group edits with "Tabs cannot be edited right now", so placing it retries until the drag lets go, ahead of any other group change, including the space a new window would otherwise be given.

## 12.4 Firefox and portable mode

Without `tabGroups`, derive membership from per-tab session ownership.
Selecting a space restores missing current-window tabs where ownership is certain, orders them by current-window backing order, creates one blank tab only if required, and activates one owned tab.

## 12.5 Space lifecycle

- Create: create the durable space folder, marked `tabs` and `bookmarks` roots, select it, move the window's focused new tab page into it or else create/route its default tab, and begin inline naming.
- Rename: preserve the folder ID and update group presentation.
- Reorder: preserve the exact folder ID and every child subtree.
- Delete: require another shown (unarchived) space.
  A space holding bookmarks first asks to Move them, Skip, or Cancel; Cancel keeps it and shows its bookmarks.
  Move sends `deleteSpace` with `moveBookmarks: true`, and before anything closes `spaceDeletionController.ts` (`moveSpaceBookmarks` in `spaceDeletion.ts`) moves the space's top-level bookmarks and folders, in order, into a new folder at the end of the `rootId` of the first shown space other than the deleted one.
  That folder is titled for the space and numbered past any top-level folder already called that, ignoring case.
  Then every window showing the deleted space switches to another shown space: the current window's active space if it is another shown one, else the deleted space's shown neighbour (`neighbourShownSpace` in `bookmarks.ts`).
  Then close owned tabs across windows (up to three sweeps for late joiners), release owned group mappings, remove the space folder and its authored bookmarks, and verify postconditions.
  Journal the operation for recovery.
  On failure, restore affected windows' active-space choices best-effort; already closed tabs are not rolled back.
- Menu: right-click on a space's pagination dot, the menu key, or Shift+F10 opens the space's menu (`spaceMenu.ts`); its intents are handled in `spaceIntentHandlers.ts`.
  It offers Rename, set apart by a separator, and Duplicate; Duplicate with tabs, Reload n tabs and Close n tabs when this window holds pages in the space; then Archive and Delete space when another space is shown.
  An archived space's row in the archived list offers Unarchive and Rename, then Delete space.
  A menu the keyboard opens sits below the dot, or above it when there is no room, never over it.
  Each choice sends one intent, and its count is of the tabs the background acts on: this window's unpinned tabs in the space other than blank new tab pages, and for Reload only those that hold their page.
  Rename edits the title in a dialog without switching space; Delete space does what dropping the dot on the bin does.
- Duplicate: copy the space's folder beside it with its bookmarks and folders, titled with the first free number after the source's name, so "Space 1" gives "Space 2" and "Work" gives "Work 2".
  With tabs, also copy this window's tabs in the space as backings of the copy (`rebuildTabTree`), in their tab folders and split views, each with its own token; they open when the window first shows the copy.
  Journal the operation as `duplicate-space`; a copy that fails, or that a stopped worker left part made, is removed whole.
  Then switch the window to the copy and ask for its name; Cancel keeps the numbered name.
- Close all: close this window's tabs in the space; Undo rebuilds them with the same `rebuildTabTree` Duplicate uses.
  A window showing the space keeps showing it, on a blank new tab page it holds or a new one, rather than letting the browser show another space's tab.
  The window's timed message offers Undo ([§27.6](27-timed-messages.md)).
- Reload: reload this window's tabs in the space that hold their page.
- Archive: mark the space folder archived ([decision 50](../decisions/50-an-archived-space-stays-a-space.md)), keeping its bookmarks and backings, and move it last among the archived spaces unless it was dropped on an archived row.
  Switch every window showing it to a neighbouring shown space, then park its open tabs: close them and keep their backings.
  The last shown space cannot be archived.
  An archived space is hidden from pagination and from every choice of the space a window shows, and its bookmarks rank below every other space's in Search.
- Unarchive: clear the mark and return the space to pagination, at the end or before the dot it was dropped on; its parked tabs open when a window next shows it.
  A discarded or never-loaded tab is left to load when shown; a frozen tab still holds its page, so it is reloaded.
- Closing the final native tab should allow the browser window to close; do not reflexively recreate a tab in a window that is shutting down.

Generated provisional spaces/folders are removed only if their title remains unchanged and fresh non-recursive revalidation proves no user content arrived.
Empty marked infrastructure does not count as user content.
