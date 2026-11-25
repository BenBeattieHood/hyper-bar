# Hyper

Hyper is an Arc-inspired browser sidebar for organizing live tabs into spaces while keeping favourites and long-term bookmarks close at hand.
It is built with WXT, React, and TypeScript.

Specifications, a decision log and a debugging guide live in [docs/](docs/README.md), whose index says which to read for a task.

## Reason

AI lets people initiate and inspect more software work than they can hold the context for.
The bottleneck moves from producing code to framing intent, validating evidence, and keeping several concurrent lines of work coherent.
The engineer gains a layer of separation from the code, much as managed runtimes once removed one: AI becomes the language you program through, decisions draw on a whole system rather than on one person's specialist knowledge, and attention shifts from how each part operates to why it exists and how the parts interact.
The same shift is visible outside engineering, wherever the implementation now changes faster than the people responsible for it can track.

The cost is diffusion.
Working across more systems at a shallower depth spreads attention without giving it structure, and the browser - where most of that work is started, researched, and reviewed - offers almost none.
Threads are either finished or lost; the path taken to a conclusion survives only as whichever tabs happen to still be open.

Hyper is an attempt to tool for this at that layer.
It makes unfinished work durable, separates it into focused, clonable, recoverable spaces, and keeps the journey of thought retrievable: persistent vertical tabs that breadcrumb research, a search designed to work with the user's own memory of where they have been rather than against it, and spaces that segment and clone grouped work.
Tabs, bookmarks, groups, and search exist in every browser.
How they are channelled and presented is the design point.

## Behaviour

- Browser bookmarks are authoritative.
  Hyper creates `hyper/favourites`, `hyper/bookmarks` and `hyper/spaces` under the bookmark bar.
  Every space owns marked `tabs` and `bookmarks` roots, so synced browser bookmarks carry the durable model without a Hyper account or backend.
- The Bookmarks pane shows the active space's bookmarks.
  Bookmarks that belong to no space are global bookmarks, kept in `hyper/bookmarks` and opened from the button at the end of the favourites bar.
  Search covers every space's bookmarks, ranking the current space first.
  Among equally good matches, recently visited pages rank higher, with the boost going to a page's tab or bookmark where one exists rather than to its history entry.
  Below 720px, Tabs and Bookmarks are stacked by default with a keyboard- and pointer-resizable divider whose position is kept with the other settings; Settings can restore separate switchable views, where a 500ms drag hover changes views without ending the gesture.
  At 720px and wider, both panes remain mounted side by side for direct cross-pane dragging.
- Each folder directly inside `hyper/spaces` is a global swipeable space that may span native windows.
  Every eligible non-pinned, non-incognito bookmarkable live tab receives its own record beneath `hyper/spaces/<space>/tabs`, directly or inside a shared tab folder, including duplicate tabs with the same URL.
  Each backing carries its space, native-window, and installation identity, so current-window restoration remains precise and one synced installation cannot delete another installation's records.
  After a browser restart, Hyper restores missing tabs for every mapped space from this installation's backings, including inactive spaces the browser did not restore natively.
  When only Hyper restarts (a reload, update, or re-enable), every window is still the one it was: tabs re-attach to their records, and a record of an open window that no open tab claims is removed rather than reopened, so a tab closed or sent elsewhere meanwhile stays that way.
  Closing a window never loses its space tabs: they reopen in another window already showing that space, or wait, parked, until the space is next opened, including after the browser quits.
  Removing and re-adding the extension keeps them too: Hyper carries on as the installation whose tabs fill the open windows, or, failing that, takes over the tabs the installation it replaced left parked when their spaces next open.
  When the browser reopens a window or a session itself, Hyper lets it finish and then restores only the tabs it did not bring back.
- Repair adopts a direct plain `bookmarks` folder inside a space as its marked local root without replacing its ID or children.
  It does not automatically move other direct local bookmarks; those remain available for manual migration.
  Repair also merges duplicate canonical Hyper folders conservatively.
- In Chrome and Edge, spaces use compact native groups named `𝒉¹`, `𝒉²`, and so on.
  Switching spaces expands the destination and collapses inactive groups while leaving tab lifecycle management to the browser.
  The background keeps every window in a space whether or not the sidebar is open: a new window takes the space its tabs belong to (else the first space) and its pages join that space's group, and group order and names follow the space order.
  A tab dragged out of the tab strip joins the space of the window it is dropped in; dragged out into a new window, it keeps its own space, and the new window shows that space.
  Firefox and other browsers without group APIs use portable per-tab session ownership while presenting the same Tabs model.
- Opening a bookmark reuses a matching tab only inside the requested space, including a matching tab in another native window.
  The same bookmark can therefore be open in several spaces.
  A non-interactive current-space dot and clickable other-space dots show where it is open; selecting another-space dot switches to and focuses that space's copy, and middle-clicking it closes that space's copy wherever it is open.
- Tabs lists every tab owned by the active space in the current native window, including blank and browser-internal pages.
  Tabs always support user-created folders shared across windows; the Autofolders setting additionally groups top-level tabs into unsaved domain folders, and tabs drag freely between manual folders and autofolders (dropping on an autofolder returns a tab to the top level).
  Any tab folder or autofolder that holds the same page more than once, counting its subfolders, shows a broom button that closes the extra copies, keeping the active copy or else the first; the button is derived from the tabs the folder holds now, so it cannot fall behind them.
  Copies are matched by navigation identity, so the same address with a different query, such as two frames of one Figma file, is not a copy.
  Direct new-tab and folder controls avoid an extra menu.
  Explicit row actions create, remove, update, or revert bookmark state.
  Drag rows to reorder them, drag a row to a space to move only that tab, or drop it on the bin to close it.
  A tab folder dropped on the bin (or removed from its menu) closes the tabs it holds in this window and goes; anything else it held, such as another window's tabs or tabs waiting for the space to reopen, moves up to where it was.
  A slow title double click between 200ms and 800ms renames the exact backing; Hyper also updates the page title where existing script permission allows it.
  Clearing a name returns a tab to its page's title, and a bookmark to the title of a tab showing its page (a bookmark that is not open keeps its name).
  A tab and its bookmark share one name: renaming a bookmarked tab renames the bookmark, bookmarking a renamed tab names the bookmark after it, and a tab opened from a renamed bookmark shows that name (with a trailing `*` once it wanders from the bookmark's exact page) until it leaves the bookmark's site.
  A tab that reaches a bookmark's page by itself links to it with a "Linked to bookmark" notice; its cross button unlinks them.
  Opening a bookmark unlinks any tab that had wandered from its page, since the tab just opened is the better match.
  Favicon loading starts with top-frame navigation, including DNS and redirects, and ends only on top-frame completion or error.
- The footer's `Now playing` source focuses or drags the selected audio tab; its adjacent Mute/Unmute or Play/Pause button remains an independent non-drag control.
  Paused media remains controllable until navigation or eligibility invalidates it.
- In a browser that shows two tabs side by side in one window (Chrome's split view; Hyper checks for `tabs.createSplit`, added in Chrome 155), dropping a tab or a bookmark on the right half of a tab row, clear of its top and bottom edges, shows a dashed drop zone; dropping there splits the two.
  A bookmark opens in a new tab for its half.
  A split shows as one row with a pane per tab, each with its own close button; splits made in the browser's own UI show the same way.
  A split holds only as many tabs as the browser allows (two in Chrome), so a full split offers no drop zone.
  Dragging a pane onto another tab's right half moves it into a split there; dropping it anywhere else takes it out of its split, as does moving it to another space.
  A bookmark row is never a split target.
  Each split is kept in the space's bookmarks as a tab folder named "Side by side" holding its tabs in pane order, so when Hyper reopens them, after a restart or when a parked space opens again, it splits them again; taking the tabs apart removes the folder and leaves them where it was.
  A "Side by side" folder shows as an ordinary folder wherever it cannot show as panes: in a browser without split view (such as Firefox, or Chrome before 155), or when it holds a folder or more tabs than a split shows.
- The favourites bar holds seven favourites, then the global bookmarks button.
  A slot without a favourite shows one of this window's recent tabs and accepts a dropped tab or bookmark, and a displaced favourite moves into the active space's bookmarks instead of being deleted.
  A normal click reuses the current space first, then the first open space from left to right, then creates in the current space.
  Use `Alt`-click to force a new copy and `Alt+Shift+A` to save the current page to favourites.
- Bookmark and folder rows open, expand, rename, reorder, and delete in place.
  Direct controls bookmark the current tab or create a folder; collapsed folders hide subfolder creation and show an indicator when any descendant bookmark is open as a tab.
  Dragging uses a flattened sortable tree with horizontal depth projection.
  Dropping on a space moves the item into that space's bookmarks, while dropping on Tabs opens the bookmark and preserves it.
- Press `Alt+A` to save the current page to the focused visible bookmark folder.
  With no focused folder, it saves to the active space's bookmark root.
  Press `F2`, `Delete`, or `Alt+ArrowUp` / `Alt+ArrowDown` on a focused bookmark to rename, delete, or reorder it.
- A normal bookmark click focuses a matching tab in the active space.
  `Alt`-click opens another copy.
  Navigation identity, which also decides which tabs are copies of each other, ignores fragments and equivalent trailing slashes while retaining queries; broader page identity normally ignores HTTP(S) queries but preserves query-driven Google searches and filtered GitHub search, issues, and pull-request pages.
- Discarded tabs remain visible without opacity dimming.
  Live favicons retain their transparent background and use the browser favicon service as a fallback.
- Press `/`, `Ctrl+K` / `Cmd+K`, or `Ctrl+P` / `Cmd+P` in Hyper to search favourites, global and local bookmarks, tabs across spaces, spaces, and recent history.
  On an HTTP(S) page, `Ctrl+P` / `Cmd+P` releases the page's focused control and opens a focused in-page Hyper Search overlay instead of Print, with its field a third of the way down the page.
  On Hyper's new-tab page, the same shortcut focuses its local search and closes sidebar Search for that window.
  Chromium keeps `Ctrl+Shift+P` / `Cmd+Shift+P` as the browser-focus fallback to open Hyper on Tabs; Firefox keeps `Alt+Shift+H`.
  Optional open-page text enriches matching in memory only.
  Pressing `Enter` before the results for what you typed have arrived acts on them as soon as they do, and a page that never stops changing, such as one retitling itself, cannot hold Search, a search from the new tab, or the rest of Hyper up.
  If the browser has no default search engine, a search from the new tab or page Search says so and links to the browser's search engine setting.
- When you deliberately open a page that is already open in the same space and window (Duplicate, a ctrl/cmd or middle click, Open link in new tab, a link from another app, a forced-new open, or a ctrl/cmd click on a Search result), Hyper keeps the copy.
  For a few seconds (seven by default, set by Message timing in Settings), the header says "Deduplicate?" in place of the space title, Settings and Search, beside a shrinking ring whose tick button closes the copy and returns to the original.
  Messages with a countdown, such as this and "Linked to bookmark", take over the header this way, toned blue for information, yellow for a warning, and red for an error.
  The button shows what it does: a tick accepts an offer, a cross reverses something Hyper did by itself, an undo arrow reverses your own action, and a copy button copies an error.
  Being permitted only spares a copy from automatic dedupe: a folder's broom button still counts it, as an easy way to consolidate.
  Links a page opens for itself, and navigating a tab onto a page already open, still switch to the existing tab.
- Dragging supports mouse, touch, and keyboard input.
  Focus a draggable item, press `Space`, move with the arrow keys, then press `Space` to drop or `Escape` to cancel.
  Dragging one of several selected rows carries them all, and every row it carries closes up while it does.
- The Tabs and Bookmarks trees, in the sidebar and in the in-page sidebar, follow the standard tree keys: `ArrowUp` / `ArrowDown` move between the rows on show, `Home` / `End` go to the first or last, `ArrowRight` opens a folder and then enters it, `ArrowLeft` closes it or goes up to its folder, `Enter` opens a row as a click would (`Alt+Enter` as an `Alt`-click), and typing a row's first letters jumps to it.
  `Space` still starts a keyboard drag.
  In Search, `Home` / `End` go to the first or last result once the arrows have moved into the results, and a result reached with `Tab` takes the arrows too, while typing there goes back to the field.
- Right-click a tab, tab folder, bookmark, bookmark folder, or Search result, or press the menu key or `Shift+F10` on one, for a menu of what its row can do: Rename, Duplicate, Bookmark or Remove bookmark, Split with the current tab (or Open beside it, for a bookmark), Cut, Copy, Paste into a folder, Close duplicates, Close, Remove, and Move to another space.
  An action on a selected row covers the whole selection.
  Search results the sidebar shows get their row's menu; any other result can be opened in a new tab, copied, or deleted from history.
  A menu opened from the keyboard opens below its row, or above it when there is no room below, so it never covers the row.
- Cut and Copy (also `Ctrl+X` / `Cmd+X` and `Ctrl+C` / `Cmd+C` on a focused row) put each row's title, address, and Hyper's metadata, with folders' contents, on the clipboard.
  Pasted into a plain text field, they give just the addresses, one per line; a rich editor gets titled links.
  Paste on a folder (or `Ctrl+V` / `Cmd+V` on it) does what dropping the items on that folder would: cut rows move into it, and copied bookmarks are copied into it.
  Copied tabs open again as new tabs in the space, and plain addresses become bookmarks when pasted on a bookmark folder, or new tabs when pasted on a tab folder.
  A cut is only a mark: nothing leaves its place until the paste.
  Folders can be cut but not copied, and a copy only names rows by ID for the same installation, so anything else pastes as plain pages.
- Hovering a tab or bookmark shows its title above its address, since a long title is cut short in its row.
- Switching tabs brings the new tab into view: Tabs opens any folder it is in and scrolls to its row, and Bookmarks does the same for the bookmark it matches (the one it was opened from, else the first for its page), in whichever of the two is showing.
  A folder you close over it stays closed until you switch tabs again.
- Tabs, bookmarks, and favourites drag between windows: drag one out of one window's sidebar and drop it on another window's sidebar.
  Tabs dropped in that window's tab list move to that window and join its space where you drop them, or join a space whose dot you drop them on; elsewhere in that sidebar they are refused.
  Bookmarks and favourites do there whatever they would in their own window, such as opening in the tab list or moving in the bookmarks.
  Tab folders stay in their own window.
- Each installation of Hyper is a session, and Hyper only ever reopens its own session's tabs.
  To see the rest, turn on Show tabs from other sessions at the top of the Recent tabs (history) menu.
  Below this window's tabs, each other session then gets a section for the tabs it keeps in the current space: another device's, or those of an installation this browser replaced.
  Its label says when it last kept a new tab: a time today, else a date.
  Drag a tab between sessions to move it, or hold `Ctrl` or `Cmd` (or `Alt`, as everywhere in Hyper) to copy it.
  A tab moved or copied into this window's tabs opens here where you drop it.
  One moved to another session closes here, and that session opens it the next time it opens the space.
  Clicking another session's tab opens the page here and leaves that session's tab where it is.
  Tabs kept before installations had IDs can be moved out of their section, but nothing can be added to it.
  With Autofolders on, each session's tabs gather into a folder per site, as this window's do: click a folder to fold or unfold it, and drag the tabs inside it as usual.
- With Settings > System > Show in pages, HTTP(S) pages show a Hyper mark in their bottom-left corner while the browser's own sidebar is closed in that window.
  Hovering it frosts a soft oval set against the page's left edge around the mark and quietly loads the sidebar, so clicking it slides the full sidebar in over the page at once, its edge frosting the page beside it the same way; a click elsewhere on the page hides it again half a second later.
  Drag the sidebar's right edge to resize it, or focus the edge and use the arrow keys, `Home`, and `End`; every page uses the width you leave it at.
  If the mark covers one of the page's own controls, right-click it to slide it a quarter of the way up the page; right-click it again to slide it back.
  It stays where you put it until the page reloads.
- Use the pagination `+` to create a space; the window moves to it and its name opens for editing.
  If the focused tab is a new tab page, it moves to the new space; otherwise the space opens on a new tab.
  The bottom-right bin removes the active space.
  Hyper keeps at least one space shown: deleting one closes its tabs, including any that join it while the deletion runs, and moves every window showing it to a neighbouring space.
  A space holding bookmarks first asks whether to move them to the first other space in the pagination: Move puts them in a folder named for the deleted space at the end of that space's bookmarks (numbered if it already has a folder of that name), Skip deletes them with the space, and Cancel keeps the space and opens it on its bookmarks.
  Cancelling an unchanged empty provisional space or folder removes it conditionally; non-recursive revalidation prevents content added meanwhile from being deleted.
- Right-click a space in the pagination, or press the menu key or `Shift+F10` on it, for its menu.
  Rename names it without leaving the space you are in.
  Duplicate copies its bookmarks into a new space beside it, and Duplicate with tabs also copies the tabs this window has open in it, in their folders and splits.
  Either way the window moves to the copy and asks for its name; Cancel keeps the numbered name, such as Space 2 for a copy of Space 1.
  Reload n tabs reloads the space's tabs in this window, except those the browser has unloaded, which load afresh when you show them.
  Close n tabs shuts them all, and a window showing the space stays on it with a new tab page.
  Undo at the top of the sidebar then reopens them as they were, in their folders and splits.
  Archive hides the space from the pagination and parks its tabs until it returns; the Archive button left of the dots lists archived spaces, whose menu offers Unarchive.
  Delete space does what dropping the space on the bin does.

Hyper stores hidden synced metadata as a valid JSON object after whitespace at the end of bookmark titles.
The UI hides and preserves this suffix.
Tab records include a stable token, tab index, and space ID.
Settings (Autofolders, the combined Tabs and Bookmarks layout and its divider position, Show in pages, the in-page sidebar's width, and whether other sessions' tabs show) are saved on the `hyper` folder itself, so they sync with the spaces they shape; values an earlier version kept in local storage move there on the next start.
Only machine-specific state stays local: the installation ID and when it started, journals of this installation's unfinished operations, and Search's ranking of picked results.
Native group IDs, per-tab ownership, and each window's active space are session-local caches that Hyper rebuilds from the bookmarks.

## Architecture

The background service worker holds the one application model.
It reads the browser and the `hyper` bookmark tree, and `entrypoints/background.ts` wires the listeners and intent handlers.
The sidebar (`entrypoints/sidepanel`), new tab page and page Search (`entrypoints/newtab`), and in-page sidebar (`entrypoints/inpage`) are views: each receives a projection of the model over a port and sends typed intents back.
A view keeps only render state, such as which folders are open, and expresses each user choice as one intent; the background carries out every step of it.
Shared logic lives in `entrypoints/lib`, one module per concern; [its guide](entrypoints/lib/AGENTS.md) maps each concern to its modules.

[docs/decisions](docs/decisions/README.md) explains why it is arranged this way.

## Development

```sh
npm install
npm run dev
```

WXT launches a Chromium profile with the extension installed.
Click the Hyper toolbar icon to toggle the side panel.

Development and production builds are separate.
`npm run dev` writes `output/chrome-mv3-dev`, labels the extension **Hyper (Dev)**, and reloads it only while the WXT server is running.
Use the WXT-launched profile for this build rather than loading that directory into a regular browser profile.

Useful checks:

```sh
npm run check     # TypeScript plus the unit suite, printing only failures
npm run compile   # TypeScript only
npm test          # Vitest unit suite, including the architecture ratchets in tests/architecture.test.ts
npm run verify    # compile, unit tests, Chrome build, Firefox build
npm run build:e2e # builds output/chrome-mv3-e2e only
npm run test:e2e  # build:e2e, then Playwright against real Chromium (four workers)
```

End-to-end runs never rewrite `output/chrome-mv3`, so a browser that has loaded that folder keeps running its own build.
A few end-to-end tests depend on native browser timing or on live google.com and can fail occasionally on an unchanged build; [AGENTS.md](AGENTS.md) says how to confirm a failure against a control build.

To load a production build manually:

1. Run `npm run build`.
2. Open `chrome://extensions` or `edge://extensions`.
3. Enable Developer mode and choose **Load unpacked**.
4. Select `output/chrome-mv3`.
5. After each later `npm run build`, click **Reload** for Hyper on the extensions page; rebuilding files does not reload an unpacked extension's running service worker.
6. When a build changes content scripts or their manifest declaration, reload existing target tabs too.
   Static content scripts attach during page navigation and are not retroactively added to documents that were already open.

If generated artifacts become inconsistent, run `npm run clean` before starting the desired build again.

## Permissions

Hyper requests `bookmarks`, `clipboardRead`, `clipboardWrite`, `history`, `search`, `sessions`, `storage`, `tabs`, and `webNavigation` to maintain the synced hierarchy, copy user-requested values and paste them into folders, use the browser search provider, search local history, track top-frame navigation, match bookmarks to open tabs, and retain session-scoped tab ownership.
Chrome and Edge additionally use `sidePanel`, `tabGroups`, and `favicon` for the native panel, space groups, and local favicons.
An HTTP(S) content script listens from document start for page-focused `Ctrl+P` / `Cmd+P`, suppresses Print, and hosts or refocuses Hyper's in-page Search overlay; with Show in pages on, it also hosts the in-page sidebar's mark and frame.
Media inspection of pages whose own script is unreachable remains gated by optional page access.

Rendered page-text search is opt-in from Settings, and off by default.
While it is on, the same content script reads each eligible open tab's text on request and the background worker keeps up to 30,000 characters per page in memory, tied to the tab's URL and navigation.
It needs no extra permission, because the content script already runs on HTTP(S) pages; a tab opened before Hyper was loaded has no content script, so its text is read only after it reloads.
The switch is a preference saved with the others, so it survives restarts; the captured text never does, and is read again after the worker restarts.
Navigating, reloading, or closing a tab invalidates its text; turning the switch off clears all captured text.
No bookmark, tab, history, or page-content data leaves the browser.
