# 21. Search, New Tab, and Page Overlay

Use one shared `CommandBar` component.

The background owns the Search pipeline: records derived from the committed snapshot, the history cache, the warm index, the query port and selection history ([model §8](../model/08-search.md)).
Views contribute only serializable command descriptors and render results.

Hidden backings and structural roots never appear as Search results.
Bookmark items carry their owning `spaceId`; active-space bookmarks receive current-space priority and rank above other-space bookmarks.
What activating a result does on each surface is in [§13.1](13-opening-reuse-and-deduplication.md).

Search sources:

- commands;
- favourites;
- bookmarks/folders from all spaces;
- spaces;
- live tabs across spaces in the authenticated window; cross-window indicators receive only the IDs of spaces with a matching page, not remote tab records;
- recent history;
- optional in-memory page text.

Selection history is the only local Search preference and is used to rerank results; it is not a page index.

Ranking sums the tiers a result matches, each worth 1.5 times the next: recent pick, command, title (favourite, current-space tab, other-space tab, current or global bookmark or folder, other-space bookmark or folder), history by match and recency, URL, containing folder.
A bookmark or folder is contained by its folder path within its space and a tab by the named tab folders around it.
The folder tier takes the whole query at a word start of one folder, or several words that each begin a word of the title, a folder or the space (never the space alone), so a bookmark "Dashboard" in "Work / Metrics" matches "work" and "metrics dashboard" below any title that holds the query.
The URL tier takes the query's letters unbroken in the URL's letters, or each word of a query of several at a word start in the URL; letters scattered over separate parts of a URL never match.
A query of several words matches only records holding every word, never some of them.
A tolerant candidate must consume every normalized query character in order within one field.
Return at most 18 actionable UI results.

With nothing typed, sidebar Search shows the last 10 picks, then the commands.
In new-tab and page Search the list shows only while the page and the input have focus and the input holds a query; leaving the page, for another window or the address bar, hides it.
Each recent row has an `x` button, and `Shift+Delete` on a selected recent row, that forgets the pick everywhere.

Music commands act on the tab Now Playing shows in the window ([§17.3](17-tabs-tab-folders-and-media.md)), with that tab's title as their detail:

- "Pause music" or "Play music" where Now Playing offers play and pause;
- "Mute music" or "Unmute music" where it can only mute, while the tab is audible or holds paused media;
- "Switch to music" while that tab is not the one in front; picked on a new tab page, it closes that page as a tab result does.

Every Search surface offers them: the sidebar and new tab page build them from their projection, and the background contributes them to page Search with the tab they act on.
Their ids name the choice, such as `media:pause`, not the tab, so a pick lifts the same command for the next tab that plays ([decision 38](../decisions/38-music-commands-follow-now-playing.md)).
A command that fails says why, and one for a tab that left the window is refused.

Aggregate duplicate live tabs in the same window by `pageIdentity()` and retain ordered exact destinations:

```ts
openSpaces?: Array<{
  id: string;
  title: string;
  tabId?: number;
  windowId?: number;
}>;
```

Current space comes first; remaining destinations retain space order.
Space indicators are sibling actions, not nested buttons.
Middle-clicking an indicator closes the result's page wherever that space has it open, in any window, without switching space; Search stays open on its query and focus returns to the field ([decision 25](../decisions/25-middle-clicking-a-space-dot-closes-the-page-there.md)).
History rows expose a hover/focus Trash action that deletes exactly one URL without navigation and restores input focus.
History rows show the history glyph until the page's icon loads, then fade that icon in over it.
The icon is the favicon of an open tab showing the same page when one exists, otherwise the browser's `_favicon` cache for the URL.

Keyboard:

- Up/Down selects results.
- Enter activates selected result.
- Escape closes the current Search surface.
- `Alt+Enter`, `Ctrl+Enter`, and `Command+Enter` execute the direct web-search target when the parsed input is a search query.
- When the browser has no default search engine, new-tab and page Search say so above the brand mark and link to the browser's search engine setting (`edge://settings/search` in Edge, `chrome://settings/search` otherwise).
- Hyper's own keys are listed in `SHORTCUTS` ([Keyboard shortcuts](#keyboard-shortcuts)).

### Keyboard shortcuts

Every key comes from the registry in `entrypoints/lib/shortcuts.ts`; who reads it, and the tests that keep them in step, are in [decision 49](../decisions/49-shortcuts-come-from-one-registry.md).
Cmd and Ctrl both count as the primary modifier on every platform; labels show `⌘`/`⌥`/`⇧` on macOS and `Ctrl`/`Alt`/`Shift` elsewhere.
Alt and unmodified keys do nothing while a text field has focus, so they never eat typing; Cmd/Ctrl keys work everywhere in the sidebar.
Letters, digits and punctuation match by key position when Option or the keyboard layout types another character, and AltGr (Ctrl+Alt) never counts as Alt.

`SHORTCUTS` in `entrypoints/lib/shortcuts.ts` lists every action with its key, Firefox variant, owner (Hyper, the manifest or the browser) and scope (browser, page, sidebar or focused row).

Bindings Hyper takes from the browser on purpose: `Cmd/Ctrl+P` (Print) and `Cmd/Ctrl+K` (Chrome's search-in-address-bar) open Search; `Cmd/Ctrl+X/C/V` act on a focused row, which has no text selection; `Alt+Shift+A` is Chrome's "focus inactive dialog" on Windows; and on Firefox for Windows and Linux `Alt+T` and `Alt+B` are the Tools and Bookmarks menu access keys, which the sidebar suppresses while it has focus.
They were chosen to avoid `Alt+D/E/F` (address bar and app menu), `Alt+Left/Right/Home`, `Alt+Shift+B/I/T` (Chrome on Windows), `Cmd+,` (browser settings on macOS) and the browsers' `Cmd/Ctrl` letter keys.

## 21.1 In-page Search overlay

The document-start HTTP(S) content script intercepts unshifted page-focused `Ctrl+P` / `Command+P`, suppresses Print, releases the page's active control, and requests Hyper Search for that source tab/window.

Render Search in a reusable top-frame Shadow DOM host containing the extension new-tab/CommandBar page in an iframe.
It is an in-page modal overlay, not a browser popup and not an attempt to steal focus into the native side panel.
Requirements:

- one overlay per page, reused and refocused;
- its Hyper mark and search field drawn at the same size and position as the new tab page's in the same viewport, with host layout declared `!important` so page CSS cannot move them;
- source tab/window encoded in the extension URL;
- navigation applies to the source context;
- backdrop/Escape close and restore previous page focus; a click on the iframe's transparent area around the mark, field, results and notice counts as backdrop, but an open item menu is dismissed first;
- light/dark page background awareness;
- focus sent into the iframe and command input;
- result-dependent compact/expanded height;
- pointer-safe, highest practical page z-index;
- reduced-motion support.

The same content script may inspect/control media only after the optional permission path authorizes the request.
Shortcut interception itself does not read page text.

## 21.2 In-page sidebar

The `inPageSidebar` preference (Settings > System, off by default) lets the same top-frame content script offer the sidebar inside HTTP(S) pages while the browser's own sidebar is closed in that window.
The background knows the latter from its model port: a `sidepanel.html` client holds a sidebar port for its window.
A closing sidebar is announced only after a one-second settle, so a sidebar reload does not flash the mark; an opening one is announced at once.

- A Shadow DOM host shows the Hyper mark at the bottom-left on a transparent background.
  Hovering it frosts an oval behind it.
  The oval is centred on the page's left edge and level with the glyph.
  It is twice as wide as the mark plus its 14px inset and a 16px margin, and as tall as a fifth of the viewport or the mark plus 50px, whichever is taller.
  It holds its strength around the mark and fades gently to nothing at its edge.
  Only its right half shows: a quarter of it at the foot of the page, a half when the mark is raised.
- Right-clicking the mark, or opening its context menu from the keyboard, suppresses the browser's menu and slides the mark a quarter of the viewport height up the page over 300 ms with an ease-in-out curve, out of the way of a control the page keeps in that corner.
  The hover frost moves with it.
  Doing it again slides the mark back.
  The host keeps the position until the page reloads; reduced motion moves it at once.
- Hovering or focusing the mark also asks the background for the frame URL, `inpage.html?token=…`, and loads the sidebar out of sight, so a click only slides the full-height sidebar in from the left at the saved width (360px by default).
  Instead of a drop shadow, the page beside the sidebar's right edge is frosted like the mark's oval and fades over the same distance as the oval's visible half.
  `inpage.html` renders the sidebar app unchanged, placed on the left; it does not answer the toolbar button's destination messages, which belong to the browser's sidebar.
- The sidebar's right edge is a focusable vertical separator.
  Dragging it, or pressing the arrow keys (16px a press), `Home`, or `End`, resizes the sidebar between 38px and 1200px (`clampInPageSidebarWidth()` in `inPageSidebarProtocol.ts`, default 360px) while leaving at least 48px of page to click.
  The frame ignores the pointer during a drag.
  When the drag or key press ends, the content script sends the width to the background, which saves it as the `inPageSidebarWidth` preference; every page's answer from the background carries the saved width, and a change is pushed to every page.
- A pointer press anywhere on the page outside the host hides it after 500 ms; entering the sidebar cancels a pending hide.
  A loaded frame is kept for 60 seconds after it closes, or after a preload that was never opened, so reopening is as quick; then it is dropped.
  Hiding the page hides the sidebar and drops the frame at once.
- A page's request can wake a stopped worker, which starts on the seed model and so reads the setting as off.
  The background therefore answers only after the model's first read.
- `inpage.html` is web-accessible, so any website could frame it.
  The port admits it only with the token the background issued to Hyper's content script in that tab ([model §4](../model/04-store-and-transport.md)); the random token is kept in session storage so a frame can reconnect after a worker restart, and forgotten when the tab closes.
  An in-page sidebar never evicts or counts as the browser's sidebar.

## 21.3 New-tab host

Reuse CommandBar with the Hyper mark, one local inspiration line, and a live notice region.
Focus unless the user already interacted.
Exclude folders and extension-owned tabs where appropriate, but retain shared history.
`Ctrl+P` / `Command+P` focuses local Search and suppresses Print.
Explicit space selection uses `selectSpace`; activating a local tab is in [§13.1](13-opening-reuse-and-deduplication.md).
While the page's own tab is leaving for a search or address, whether started from Search or the address bar, the field becomes plain text in the same place: the search words, or else the address.
A line with rounded ends where the field's bottom border was fills gradually with the Hyper mark's turning gradient.
The magnifier morphs into a spinner: its handle draws back into the lens, which opens into a turning arc.
Results stay hidden, and the field returns focused if the tab stops loading without leaving.
