# 5. Controller Inputs

Every input the background accepts is declared in `ingressInventory` (`entrypoints/lib/modelIngress.ts`), which gives each `IngressName` one route: `reconcile`, `intent` or `lifecycle`.
The inventory is a declaration, not a dispatcher: listeners in `entrypoints/background.ts` also perform routing, cleanup and cache policy.
An ingress whose optional API is missing never fires; its `capability` names the API.
`storage.onChanged` reaches the model only for the areas `isModelStorageArea` admits (`local` and `session`).
The runtime-message path serves content-script UI and media messages; view domain mutations use typed port intents.

Sidebar, Search and shared browser command actions send typed intents, whose kinds are closed by `hyperActionKinds` (`entrypoints/lib/modelActions.ts`).
Every kind needs both a handler and a view caller: a handler without a caller is parallel authority waiting to rot, and a caller without a handler is a dead path.
`tests/architecture.test.ts` (`intent inventory`) enforces both and counts kinds, handlers and callers, so this document keeps no count.

Handler files: `BK` `bookmarkIntentHandlers.ts`, `C` `browserCommandIntentHandlers.ts`, `M` `mediaController.ts`, `SD` `sharedDrag.ts`, `SP` `spaceIntentHandlers.ts`, `SV` `splitViewController.ts`, `T` `tabIntentHandlers.ts`, `TM` `timedMessages.ts`, `W` `workspaceIntentHandlers.ts`, all in `entrypoints/lib/`.
Callers: `S` sidebar, `N` normal newtab, `PS` page-search newtab, `SC` shared `browserCommandActions` in S and N.
Targets: `b` bookmark, `s` space, `t` tab, `w` client/destination window, `-` none; parenthesized targets are conditional.
Targets feed the ledger; they do not mean all browser calls are individually fenced ([§6](06-serialization-causation-and-failures.md)).

| Kind | Payload and effect | Targets | Handler | Caller |
| --- | --- | --- | --- | --- |
| `actOnTimedMessage` | `{messageId}` runs the window's current timed message's button (opt in, opt out or undo) once and dismisses it; a stale id is refused and runs nothing. A permission button runs at admission ([§6](06-serialization-causation-and-failures.md)). | w | TM | S |
| `activateTab` | `{tabId}` focuses local tab, switches space, and N closes handed-off newtab; `{operation:'remote',source:{kind:'tab',tabId} or {kind:'bookmark',bookmarkId},spaceId}` resolves remote focus. | local t,w,(replaced t); remote source b/t,s,w | T | S,N,PS,SC |
| `closeSpaceTabs` | `{spaceId}` closes the space's unpinned tabs in the client's window, undoably ([build-spec §12.5](../build-spec/12-spaces-windows-and-activation.md)). | s,w | SP | S |
| `closeTabs` | `{tabIds:number[],folderTitle?,condition?:'other-unpinned',keepTabId?,windowId?}` closes named tabs, undoably, naming the folder when `folderTitle` says the user closed one ([build-spec §27](../build-spec/27-timed-messages.md)); conditional form rechecks safe others; sidebar-only `{condition:'page-in-space',source,spaceId}` closes the source's page wherever that space has it open. | all t,(keep t,w); in-space source b/t,s,w, extended by the closed t | T | S,SC |
| `copyBookmark` | `{bookmarkId,parentId,index?,skipExisting?,favouriteSlot?}` copies and optionally slots or rolls copy back. | b source,parent | BK | S |
| `createBookmark` | `{parentId,tabId?,index?,favouriteSlot?}` bookmarks tab/current page and optionally slots. | b parent,t or w | BK | S |
| `createBookmarkFolder` | `{parentId}` creates visible folder. | b parent | BK | S |
| `createSpace` | `{spacesFolderId}` creates marked space roots and switches creating window, taking its focused new tab page. | b spaces,w | BK | S |
| `createTab` | `{}` creates and routes active tab. | w | T | S,SC |
| `createWindow` | `{incognito?}` opens native window (default false). | w | C | SC |
| `deleteBookmark` | `{bookmarkId,expectedProvisionalTitle?}` removes URL/tree; provisional removal checks title. | b | BK | S |
| `deleteHistory` | `{url}` deletes history URL and refreshes Search cache. | - | T | S,N,PS |
| `deleteSpace` | `{spaceId,expectedProvisionalTitle?,moveBookmarks?}` journalled deletion with tab/group release and proof ([build-spec §12.5](../build-spec/12-spaces-windows-and-activation.md)). | s,w | W | S |
| `detachTab` | `{tabId}` opens a new window holding the tab. | t,w | C | SC |
| `dismissTimedMessage` | `{messageId}` closes the window's current timed message without running its button, as if it had expired; a stale id does nothing ([build-spec §27](../build-spec/27-timed-messages.md)). | w | TM | S |
| `duplicateSpace` | `{spaceId,withTabs}` journalled copy of the space into a new space, returning its node ([build-spec §12.5](../build-spec/12-spaces-windows-and-activation.md)). | s,w | SP | S |
| `duplicateTab` | `{tabId}` duplicates, routes and keeps the copy with a cooldown. | t,w | W | S,SC |
| `importBookmarkFolder` | `{sourceFolderId,destinationParentId}` journalled subtree import. | b source,destination | W | S |
| `moveBookmark` | `{bookmarkId,parentId?,index?}` moves/reorders bookmark or space; `{bookmarkId,offset:-1 or 1}` steps it past one sibling, resolved against the siblings when the queued move runs, and does nothing at that end. | b source,(parent) | W | S |
| `moveSessionTab` | `{source:{backingId}\|{tabId},destination:{installationId}\|{index,tree:{spaceId,parentId?,index?}}\|{bookmarks:{parentId,index?}},copy}` moves, or copies, a tab between sessions: another session's backing into the client's window at that place (moving hands the backing to this installation and opens a tab on it; copying opens a tab with its own), or to another session parked; or a client-window tab to another session, as a parked copy of its backing beside it (outside any split view folder), closing the tab when moving; or another session's backing into a bookmark folder as a bookmark of its page (skipping a duplicate), forgetting the backing when moving. | t or b source, destination s,w | T | S |
| `moveTabToWindow` | `{source,spaceId}` resolves remote reference, journalled move to client's window. | source b/t,s,w | T | S |
| `moveTabs` | `{tabIds:number[],windowId,index,tree?}` reorders/moves while preserving active tab, first unsplitting any split it takes only part of. `{sharedDrag:token,...}` instead takes the tabs of another window's shared drag, only into the client's window. `tree:{spaceId,parentId?,index?}` then routes the tabs into that space and moves their backings there in its tab tree; the window attach this causes does not route them again. | all t,w destination,(s) | T | S |
| `navigateTab` | `{kind:'search',query,tabId?,newTab?}` uses default engine, settling `unsupported` when the browser has none; `{kind:'url',url,tabId?,newTab?}` navigates/opens. In place it runs at once, not behind the mutation queue. | new w; existing t,w | T | S,N,PS |
| `navigateTabHistory` | `{direction:'back' or 'forward',tabId}` calls native history navigation. | t | C | SC |
| `openBookmark` | `{url,active?,destinationSpaceId?,forceNew?,reuse?:'browser' or 'window'}` reuses or routes; defaults active true, forceNew false, reuse window. | (s),w | W | S |
| `openFavourite` | `{url,activeSpaceId?,forceNew?}` finds/reuses or opens favourite. | (s),w | BK | S |
| `forgetSearchSelection` | `{resultId}` drops a pick from recents and ranking. | - | T | S,N,PS |
| `recordSearchSelection` | `{query,resultId}` persists bounded ranking choice. | - | T | S,N,PS |
| `reloadSpaceTabs` | `{spaceId}` reloads the space's loaded tabs in the client's window ([build-spec §12.5](../build-spec/12-spaces-windows-and-activation.md)). | s,w | SP | S |
| `reloadTab` | `{tabId}` reloads; a multi-tab reload sends every tab as `items`. | t | C | S,SC |
| `renameBookmark` | `{bookmarkId,title,url?}` renames/updates preserving metadata and links. | b | W | S |
| `renameTab` | `{tabId,backingId,title}` verifies claim, names backing/linked bookmark/tab. | b,t | W | S |
| `restoreClosedTab` | `{sessionId?}` asks sessions API to restore. | w | C | SC |
| `selectSpace` | `{spaceId}` admits latest window choice and activates/restores. | s,w | W | S,N,PS |
| `setFavourite` | `{bookmarkId,slotIndex}` slots favourite. | b | W | S |
| `setPreference` | `{key,value}` validates preference and saves root title. | - | W | S |
| `setSpaceArchived` | `{spaceId,archived,beforeSpaceId?}` archives or unarchives the space and moves its folder before `beforeSpaceId`, else to the end ([build-spec §12.5](../build-spec/12-spaces-windows-and-activation.md)). | s,w | SP | S |
| `setTabFolder` | `{operation:'create',spaceId,parentId?,title?}`; `{operation:'move',spaceId,nodeIds,parentId,index?}`; `{operation:'remove',folderId}`; `{operation:'rename',folderId,title}` changes marked tab tree. A move first unsplits any split it takes only part of. | create s,(b parent); move s,b nodes,parent; remove/rename b folder | W | S |
| `setTabGroup` | `{spaceId,tabIds:number[]}` unsplits splits it takes only part of, then routes eligible unpinned local tabs. | all t,s,w | T | S |
| `setTabMediaPlayback` | `{tabId,state:'playing' or 'paused'}` controls the current media target of a tab in the client's window. | t,w | M | S,N,PS |
| `setTabMuted` | `{tabId,muted}` changes mute of a tab in the client's window. | t | T | S,N,PS,SC |
| `setTabPinned` | `{tabId,pinned}` changes pin state. | t | C | SC |
| `setTabZoom` | `{tabId,mode:'in' or 'out' or 'reset'}` adjusts zoom if available. | t | C | SC |
| `shareDrag` | `{operation:'offer',token,items:({kind:'tab',tabId} or {kind:'tree' or 'favourite',nodeId})[]}` holds a drag that left the sidebar for other windows' sidebars; `{operation:'withdraw',token}` stops projecting it. Sidebar only. | - | SD | S |
| `showMessage` | `{text,tone:'error'or'info'or'warning'}` shows an error or feedback report as the window's timed message, replacing any other. | - | TM | S |
| `splitTab` | `{tabId,withTabId}` takes that tab out of its own split, moves it beside `tabId` in the tab strip and group, and splits the two; `{tabId,url}` opens the page in a new tab split beside `tabId`. Either then stores the pair in a split view folder, `tabId`'s backing first. Rejects a tab already split. | t,(t),w | SV | S |
| `toggleWindowFullscreen` | `{}` toggles client window. | w | C | SC |
| `updateBookmarkUrl` | `{bookmarkId,url}` changes URL. | b | BK | S |

`IntentItemPayloads` (`entrypoints/lib/modelIntentPayloads.ts`) permits `items` only for `copyBookmark`, `createBookmark`, `deleteBookmark`, `moveBookmark`, `moveSessionTab`, `openBookmark`, `reloadTab` and `setTabFolder`.
`eachItem(parse)` accepts one payload or a nonempty `{items:[...]}` of at most `MAX_INTENT_ITEMS = 1000`.
It parses all items before admission; `runEachItem` (`entrypoints/lib/modelIntents.ts`) executes them in order as one command and returns an array for a batch or the single result otherwise.
This is not a database transaction: a late failure may follow earlier effects.
The `createBookmark` handler reduces following indexes *per parent* when a selected tab was already bookmarked and created no node.
A dropped selection is one choice, sent by the sidebar's `submitSelection`, not a race of view commands.

The background remembers a space's focused tab on its own activation event.
Reordering a space is a `moveBookmark` of its `hyper/spaces` child and moving a backing out of the hidden tabs tree releases it; neither needs a dedicated action.
Group mappings are maintained by background routing and reconciliation.

An intent returns an acknowledgement with its command ID, not a promised view state: acknowledgement means the command was admitted to the lane ([§6](06-serialization-causation-and-failures.md)), not that its effect has happened.
Views observe the resulting revision or terminal command status through the normal model port.
Any caller that must not read browser state until the effect has landed waits for the command to settle in a later snapshot rather than treating acknowledgement as completion.

`windowSpaceChoice` owns space switches for `selectSpace`, `openBookmark` before opening a page in another space, and `activateTab` before focusing a sidebar tab in another space.
It admits a window choice synchronously and uses `runIfLatest` to stop an older choice.
`spaceSwitch.select` and the lighter `activateSpaceFromSearch` are not interchangeable ([decision 9](../decisions/09-two-ways-to-show-a-space.md)).
`createSpace` takes its creating window there; newtab `activateTab` closes the newtab it handed off from.
A favourite slot travels on `createBookmark`/`copyBookmark`, and a new Search tab is `navigateTab {kind:'search',newTab:true}`.
No view sequences a second intent for the same user choice: browser effects must happen in worker order.

Admitting a choice does not change what the model says a window shows.
The model names the space recorded for the window, and `spaceSwitch.select` records the destination only partway through its work (after focusing the destination's tab when one is already open), so until then the model keeps naming the space being left.
A view that wants the destination on screen at once holds it itself (`activeSpaceHold`, [§2](02-the-one-way-flow.md)).

No view reconciles a space.
`selectSpace` carries only a user's choice; the background keeps every window's space from model commits (`entrypoints/lib/spaceWindowMaintenance.ts`), whether or not any view is open.
A window without a space takes its active tab's space, else that of its first owned tab, else the first shown space, and the pages it opened meanwhile join it.
A window whose space is removed shows its replacement, and an archived space counts as removed here (`shownSpaces` in `entrypoints/lib/bookmarks.ts`).
Native group order and titles follow the space order.
A window that a pending command targets is left to that command, so maintenance follows settled choices rather than racing them.
Maintenance never opens a tab, and restoring a space never moves focus off a tab no space owns, such as a pinned one.

Either implementation must focus the destination tab before it collapses any sibling group ([build-spec §12.1](../build-spec/12-spaces-windows-and-activation.md)).

Hyper's own activations are recorded in `entrypoints/lib/selfActivation.ts` before each browser call, and the activation listener claims them.
A claimed activation skips only remembering a last-used tab; the view still follows the tab.
A record names the tab where Hyper chose it.
Where Hyper cannot name the tab in advance it records one unnamed displacement, only around a collapse that holds the active tab, and withdraws the record unless focus is then observed to have moved.
Every record is single-shot and expires (`SELF_ACTIVATION_TTL_MS`, `DISPLACEMENT_GRACE_MS`).
When a displacement is claimed, the switch restores the tab it had focused; an activation it did not claim is the user's and stands.
