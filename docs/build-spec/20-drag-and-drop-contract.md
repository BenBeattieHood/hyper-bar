# 20. Drag and Drop Contract

Every drag runs through the one dnd-kit `DndContext` in `sidepanel/App.tsx`, with the sensors `useDragSession.ts` sets up:

- `NativeDragSensor` (`sidepanel/lib/nativeDrag.ts`) drives the `draggable="true"` rows: tabs, tab folders, session tabs, bookmarks and pinned favourites.
  It feeds the browser's native drag and drop into dnd-kit with a blank drag image, starting one task after `dragstart`, so the drag can leave the sidebar (§20.1).
- `PointerOnlyMouseSensor`, with an 8px activation distance, drives the rest: space dots, archive rows, recent tiles and Now Playing.
- `TouchSensor` starts after a 180ms delay with 8px tolerance.
- `KeyboardSensor` picks up with Space, drops with Space or Enter, moves with the arrows (`sortableKeyboardCoordinates`) and cancels with Escape.

Whole-row click classification remains separate: primary pointer, under 800ms, and at most 3px pointer travel.
It judges the pointer, not the row: a row that slides under a still pointer, as the list scrolls or a row above it tweens in or out, still takes the click, which the browser delivers only when press and release land on the same row ([decision 51](../decisions/51-a-row-that-moves-under-a-still-pointer-still-takes-the-click.md)).
Capture modifier intent for the full gesture.

`DragItemData` in `entrypoints/sidepanel/types.ts` lists every drag source and target kind.
Archive drops are handled by `performSpaceDrop()` in `sidepanel/lib/spaceDrops.ts` (target `space-archive`), and global bookmarks drops by the `global-bookmarks` branch in `sidepanel/lib/dropActions.ts`.

Alt, Ctrl, and Cmd are each the copy modifier, tracked through the whole drag from key events and every native `dragover`.

Operation matrix:

| Source | Target | Default | With Alt, Ctrl, or Cmd |
| --- | --- | --- | --- |
| Tree bookmark/folder | Tree | Move/project hierarchy | Bookmark copies; folder still moves |
| Tree bookmark/folder | Space pagination destination | Move to that space's `rootId` | Same |
| Tree bookmark | Favourite | Copy | Copy |
| Favourite | Tree | Copy unless equivalent direct child exists | Force copy |
| Tab | Tree | Create visible bookmark at destination | Same |
| Tree bookmark/folder | Tabs target | Open bookmark URL(s), retain source | Same |
| Favourite | Space/Tabs | Reuse destination match or create, retain source | Force new |
| Tab | Space | Move exact tab/backing ownership | Same |
| Tab | Tabs | Reorder exact tab/backing | Same |
| Tab | Right half of a tab row | Split the two tabs (17.1) | Same |
| Tree bookmark/favourite | Right half of a tab row | Open the page split beside that tab (17.1) | Same |
| Tab folder | Tabs in folder mode | Move marked folder subtree | Same |
| Autofolder | Tabs with Autofolders on | Move member backings to the corresponding top-level position | Same |
| Space | Space | Reorder durable `Space.id` folder | Same |
| Space | Trash | Delete if another space remains, first asking about its bookmarks if it holds any | Same |
| Tab | Trash | Close exact tab | Same |
| Marked tab folder | Trash | Close its tabs in this window and delete the folder; move anything else it held to where it was | Same |
| Tree/Favourite | Trash | Delete bookmark source | Same |
| Other session's tab | Tabs row, folder, or root | Hand its backing to this session and window at the drop position, opening it | Open a copy with its own backing, retain source |
| Other session's tab | Another session | Hand its backing over, parked | Add a parked copy, retain source |
| Backed tab(s) | Other session | Parked copy for that session, close the tab(s) | Parked copy, keep the tab(s) |
| Links or shortcut files from outside Hyper | Tree, favourites, Tabs, or space | Bookmark or open each page (§20.3) | Same |

Important distinctions:

- Dropping a tree item on a **space pagination destination** changes bookmark scope; it does not open a tab.
- Dropping a tree item on a **Tabs row/root/trigger** opens it and preserves the bookmark.
- Use `Space.rootId` for bookmark scope destinations and `Space.id` for tab/space destinations.
- Holding a tree item or tab over a space pagination destination for 500ms plays the view switch fill on it, then opens that space mid-drag ([decision 35](../decisions/35-a-held-drag-over-a-space-opens-it.md)).
  A tree item opens it to Bookmarks and a tab to Tabs (switching view unless both lists show side by side), closing global bookmarks, so the drop can land at an exact position there.
  The hold is skipped when that space and view already show, and for a disabled space button, such as the space a bookmark already belongs to.
  `spaceDragView` maps the drag source to the view, `useSpaceDragArming` owns the timer, and `useWorkspaceDrop` feeds it the current dnd-kit target and records where the drag began.
  This window's tabs from another space dropped in the Tabs list take `moveTabs {tabIds, tree}` into the active space at that position, as paste does.
  Favourites, tab folders, session tabs, outside drags and spaces do not open a space this way.
- A drag cancelled with Escape, or dropped where nothing lands or the drop is forbidden, returns to the space, view and global bookmarks it began in, undoing any a held drag opened along the way.

Overlay badge semantics:

- Plus: source remains and a target item/tab is created or opened.
- Trash: source is destroyed and nothing is retained/created.
- No badge: true move, including bookmark scope moves.
- Forbidden: invalid target.

Normalize multi-selection to top-level sources so selected descendants are not executed twice.
Preserve visible order.
A selected folder contributes recursive count and descendant URLs/tabs where the destination requires flattening.
Reject incompatible grouped drops atomically.

Drop targets are measured as a drag starts and again whenever a tree row finishes opening or closing mid-drag, such as a selected row the drag carries or a folder's rows a hover opens.
Measuring when the row settles, not after a fixed delay, keeps the targets under the rows on screen however late a busy page's frames run.

A tab drag inside the Tabs list moves backings, and how the browser's tab strip follows, or leads, the list is in §17.2.

## 20.1 Dragging between windows

A row drag that leaves its sidebar is offered to the model with `shareDrag` ([model spec §3](../model/03-model-contents-and-authority.md)) under a random token, which is also written into the native drag as `application/x-hyper-drag`; the drag's end withdraws it.
Only tab, bookmark and pinned favourite rows offer it (`sharedDragReferences()` in `sidepanel/lib/sharedDragDrops.ts`); a selection that holds any other kind, such as a tab folder, is not offered.
Every other window's sidebar receives the drag in its projection, tabs only as tabs.
When the native drag enters such a sidebar, it starts its own dnd-kit drag of those items on a hidden stand-in, so its targets, collisions, overlay, and drop dispatch serve the drag unchanged, and it accepts the drop only if the drag carries the projected token.

| Source from another window | Target | Effect |
| --- | --- | --- |
| Tab | Tabs row, folder, root, or trigger | `moveTabs {sharedDrag}` moves it into this window, into the active space at the drop position |
| Tab | Space | `moveTabs {sharedDrag}` moves it into this window and that space |
| Tab | Anything else | Forbidden |
| Bookmark/favourite | Any target | As if dragged in this window |

## 20.2 Dragging between sessions

With `showOtherSessions` on (a switch at the top of the Recent tabs menu), the tab list goes on, below the window's tabs and inside the same scrolling drop zone, with a section for each installation other than this one that keeps a backing in any space.
The most recently active comes first, by newest `dateAdded`, and its label gives that time (a time today, else a date).
Each section lists that installation's backings in the active space in tree order (`otherSessions` in `sidepanel/lib/otherSessions.ts`), or says it has none; with `autofolders` on it gathers them into a folder per site as top-level tabs are gathered (`sessionTabFolders`), which folds open and shut, in view state only, but does not drag.
Backings without an installation ID form one section that takes no drops (`sessionDropRefused`).
A section is a foreground drop target, and collision detection reads its live rect because the row a drag lifts collapses.
Its rows drag (`session-tab`) and, clicked, open the page in the active space as a bookmark does.

Session tabs select, cut, copy, paste, close and drag as this window's tabs do ([decision 48](../decisions/48-other-sessions-tabs-act-like-this-windows-tabs.md)).
Ctrl/Cmd click and Shift click select them in the `sessions` selection scope (`sidepanel/lib/dragSelection.ts`), so they never mix with this window's rows.
Marquee selection does not reach them, and Shift click ranges and arrow keys stay within one section.
Their menu offers Cut, Copy, Paste and Close, with Reload shown disabled and its hint saying no extension API reaches another device's tab; moving to another space and splitting are not offered.
Ctrl/Cmd+C, X and V, the arrow keys, Enter and the menu key work on a focused row through `useTreeKeyboard` with `data-session-tab-id`.
A section's heading has a menu with Paste.

Each drop or paste between sessions, into the tab list, or into the bookmarks is one `moveSessionTab` intent with an item per tab (`sessionTabMoves`, sent by `submitSelection`; [model §5](../model/05-controller-inputs.md)):

- Copy then paste on a tab folder, or a copy-drop in the tab list, sends it with `copy`, opening the page here with a backing of its own.
- Cut then paste, or a plain drop, in the tab list takes over the backing, placed as a shared drag's tabs are placed (`sharedTabsDestination` in `sidepanel/lib/sharedDragDrops.ts`).
- Paste on a bookmark folder, or a drop in the bookmarks or global bookmarks, sends a `bookmarks: {parentId, index?}` destination.
  It makes a bookmark of the page with `createPageBookmark()`, which skips a duplicate, and a move also forgets the backing.
- Paste on another session's tab or heading is the same drop a session zone takes.
- A favourites bar paste pins the page a session tab shows.

Close, the row's X, middle click, or a drop on the bin send one `deleteBookmark` for the selection's backings; its message says "Closed tab", and Undo recreates the backings ([§27](27-timed-messages.md)).
The clipboard records a session tab as a `session-tab` entry naming its backing, and a paste trusts it only while the backing still exists at the same address and still belongs to another installation; otherwise it pastes the page.
The legacy section, backings from before installation IDs, can give tabs away but takes none: its Paste shows disabled, and a key paste there explains why.
Bookmarks and plain addresses pasted on a session are refused with a notice, as a session keeps only tabs.
Other targets refuse session tabs, and sessions refuse anything but this window's backed tabs and other sessions' tabs.

## 20.3 Dragging in from outside Hyper

A link, address, or file dragged from a web page, another app, the desktop, or the browser's own bookmarks bar or tab strip can be dropped on the sidebar.
`useExternalDrag` notices such a drag entering the sidebar by its types: any of `Files`, `text/uri-list`, `text/x-moz-url`, `text/html` or `text/plain`, and never Hyper's own `application/x-hyper-drag`.
A drag that began in the sidebar itself, such as text dragged from a field, is left alone.
The drag then plays out on a hidden stand-in draggable (`DragStandIns`), as a drag from another window does (§20.1), so every target and indicator behaves as it does for a dragged row.

The browser keeps a drag's contents hidden until it drops, so the overlay shows only a globe for a link, or a file icon with a count for files.
The sensor copies the drop's data during the `drop` event, and `externalDropContents` reads pages from it:

- links come from `text/x-moz-url` and `text/uri-list`, otherwise from addresses in plain text, one per line, as paste reads them;
- dragged HTML only titles those links, by the text they were linked from;
- shortcut files of up to 64KB are read for the page they point at: `.url`, `.webloc` and `.inetloc` (XML or binary property lists), `.desktop` entries of type Link, and `.lnk` shell links to local or network files;
- only `http:`, `https:` and `file:` pages are kept, and each page once.

Browsers never tell a page where a dropped file is kept, so any other file cannot be linked.
When a drop holds only such files, a notice names them and suggests opening the file in a tab and dragging the tab instead.
A dragged image brings its file beside its address, so files are named only when the drop held no link of its own.

| Target | Effect |
| --- | --- |
| Tree row | `createBookmark {page}` for each page at the projected position |
| Tree root or bookmarks trigger | `createBookmark {page}` for each page at that position, or last in the space's bookmarks |
| Global bookmarks button | `createBookmark {page}` for each page in global bookmarks |
| Favourite or slot | Pin each page, from the slot dropped on through the next empty ones; a notice when there are not enough |
| Tabs row, folder, root, or trigger | `openBookmark` for each page as a new tab in the active space, focusing a single one |
| Space | `openBookmark` for each page as a new tab in that space, focusing a single one |
| Anything else | Forbidden |

A drop from outside always copies, so the overlay shows the Plus badge and the copy modifier changes nothing.
Pages already bookmarked in the destination folder are not added twice, and a notice says so when none was added.
