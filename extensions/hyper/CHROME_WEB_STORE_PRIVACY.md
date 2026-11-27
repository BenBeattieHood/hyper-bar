## bookmarks

Hyper is a sidebar for managing bookmarks, and uses bookmarks as its durable store for spaces, bookmark folders, favourites, tab backing records, and preferences. It needs this permission to read bookmark trees, create and organize Hyper's folders, move/rename/update/delete bookmarks in response to user actions, detect external bookmark changes, and restore the user's tab workspace after browser restarts. Hyper does not upload or share your bookmark data - it is held within your browser only.

## clipboardRead

Hyper needs to read the clipboard only when the user invokes Paste from a Hyper menu or keyboard shortcut. This lets the user paste copied tabs/bookmark folders into the sidebar and open or save pasted URLs. Hyper's structured clipboard format is ignored unless it is valid; no clipboard data is read in the background and no clipboard data is transmitted off the device.

## clipboardWrite

Hyper needs to write to the clipboard only when the user chooses a Copy/Cut command or copies a page link from Search. It writes the selected tab/bookmark URLs and titles in standard text, HTML, and Hyper-specific formats so they can be pasted back into Hyper or into another application. Hyper does not modify the clipboard without a user action and does not transmit its contents.

## favicon

Hyper displays favicons to identify open tabs, bookmarks, history results, recently closed tabs, and favourites in its sidebar and Search. This permission allows Chrome's cached favicon resource to be loaded when a tab or bookmark does not already provide a usable favicon URL. Favicon data is displayed locally and is not collected or transmitted.

## history

Hyper's Search includes the user's Chrome history entries alongside open tabs and bookmarks. It reads recent history to build a local, in-memory search index and listens for history changes to keep that index current. When the user explicitly chooses the Search command to remove a history result, Hyper deletes that URL from history. Hyper does not upload or share history data; the index is discarded when the extension worker stops and is rebuilt locally.

## Host permission use (`http://*/*`, `https://*/*`)

Hyper injects a content script on HTTP(S) pages in order to allow a global in-page Search shortcut, the optional in-page sidebar, media playback controls, and page-text Search when that setting is enabled. The script does not alter page content, read data, or share page data off the device. Page URLs, titles, headings, and body text are processed locally only for Hyper's own local features. Incognito pages are excluded from Hyper's captured search content.

The same host patterns are declared as optional host access because Chrome also offers users a per-site opt-in when scripting access is needed for the selected site. The extension requests only the origin shown in that opt-in prompt, and only after the user activates “Fix play/pause?” for an inaccessible media page.

## scripting

The `scripting` permission is optional and is requested only after an explicit user action for a specific site. Hyper uses it to inspect or control audio/video elements on a page when its already-loaded content script is unavailable (for example, for a page that was open before the extension was reloaded), and to apply a user-requested tab title. A user may decline the request; the rest of Hyper continues to work. Script results are used locally to control or identify media and are not transmitted.

## search

Hyper's command bar allows the user to submit a query to Chrome's configured default search provider from a Search command. The `search` permission is used only for that explicit user action. Hyper does not perform background searches and does not receive or collect searches made elsewhere in Chrome.

## sessions

Hyper displays recently closed tabs and lets the user restore a selected recently closed tab or run the Restore Closed Tab command. It uses the sessions API locally to read the recent-session list and restore the specific user-selected session. It does not read, export, or transmit session data.

## sidePanel

Hyper's primary interface is Chrome's side panel. The permission is required to register the panel, configure its action-click behavior, and open the sidebar in the current window from the toolbar or command UI.

## storage

Hyper uses extension storage for machine-local runtime state that cannot live in bookmarks: an installation identifier, session-to-tab/window association caches, search-selection history, operation recovery journals, and temporary media-access prompt state. Durable user workspace data and preferences are stored in the bookmark tree, while session storage is used for browser-session caches. Hyper does not transmit stored values.

## tabGroups

Hyper represents spaces with native Chrome tab groups and preserves the user's tab-group order, colour, and collapsed state. It reads tab-group state to build the sidebar, responds to group changes, and creates/updates/expands groups when the user switches or reorganizes spaces, opens saved workspace tabs, or moves tabs. Group data remains local to Chrome.

## tabs

Hyper is a tab and workspace manager. It needs the tabs permission to read tab identity, URL, title, favicon, loading/audio/pinned/discarded state and window membership; display tabs in the sidebar; switch, open, duplicate, move, pin, reload, close, restore, and rename tabs; communicate with Hyper's content script; and keep bookmarks synchronized with live tab changes. Sensitive tab data is not sent to a server; incognito tabs are not persisted as workspace data.

## webNavigation

Hyper uses top-level navigation events to reliably track when tabs start, commit, complete, or fail navigation, including single-page-app history and fragment updates. This keeps tab backing records, loading indicators, duplicate detection, routing, and tab/page synchronization accurate during races. `getAllFrames` is also used to reach Hyper's media controller in each frame. Navigation data is processed locally and is not collected or transmitted.
