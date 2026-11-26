# 2. Product and Vocabulary

Hyper is an Arc-inspired spatial browser sidebar for preserving live lines of work and moving between them without losing context.
It combines:

- global ordered spaces;
- a current-window Tabs pane for the active space;
- one bookmark tree per space;
- a favourites bar of seven slots, filled with recent tabs where nothing is pinned, and a global bookmarks button;
- shared side-panel, in-page, and new-tab Search;
- recent-tab and audible-media controls;
- direct drag and drop among tabs, tab folders, bookmarks, favourites, bookmark scopes, spaces, and trash;
- optional in-memory search over text from open pages.

Use these terms consistently:

- **Space**: a folder directly beneath `hyper/spaces`; its bookmark ID is `Space.id`.
- **Space bookmark root**: a marked `bookmarks` child inside one space; its ID is `Space.rootId`.
- **Space bookmarks**: visible content beneath a space's bookmark root.
- **Bookmarks pane**: the active space's bookmarks as a single tree.
- **Tabs pane**: current-window live tabs owned by the active space.
- **Tab backing**: a hidden bookmark record for exactly one eligible live tab.
- **Tab folder**: a marked folder beneath a space's reserved `tabs` root, shared structurally across windows.
- **Space pagination**: the persistent ordered space controls in the footer.
- **Command bar**: the shared Search component used by the side panel, new-tab page, and in-page Search overlay.
- **Attached row control**: a control visually inside the row surface, such as Close.
- **Detached row control**: a control separated from the row surface by a gap, such as a space indicator or bookmark-sync action.

Two rules hold for every feature:

- Keep all user data in browser APIs.
  Add no backend, account, telemetry, analytics, remote index, or persisted page text.
- Capability-detect browser APIs, as `modelSources.ts` does with `browser.tabGroups?.query`.
  Chromium and Firefox may use different mechanisms, but must expose the same product model where the platform permits it.
