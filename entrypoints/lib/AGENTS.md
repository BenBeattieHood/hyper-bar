# entrypoints/lib

Background and shared logic, one module per concern; add colocated Vitest tests for behavior, not no-op wrappers.
Most of it runs in the service worker; views import only pure helpers and types from here (for example `modelPort.ts`, `modelActions.ts`, `search.ts`, `commandBar.ts`).

## Where things live

| Concern | Modules |
| --- | --- |
| Model and port | `model.ts`, `modelSources.ts`, `modelReconciler.ts`, `modelPort.ts`, `modelProtocol.ts`, `modelClient.ts`, `modelIngress.ts`, `modelOverlay.ts`, `modelIdentity.ts`, `backgroundModelRuntime.ts` |
| Intent inventory and payloads | `modelActions.ts` (kinds), `modelIntents.ts`, `modelIntentPayloads.ts`, `modelGuards.ts` |
| Intent handlers | `workspaceIntentHandlers.ts`, `bookmarkIntentHandlers.ts`, `tabIntentHandlers.ts`, `spaceIntentHandlers.ts` (a space menu's whole-space actions), `browserCommandIntentHandlers.ts`, plus controllers: `mediaController.ts`, `sharedDrag.ts`, `splitViewController.ts`, `timedMessages.ts` (the window's one timed message and its button, joining like undos in a row, build-spec §27) |
| Bookmark persistence | `bookmarks.ts` (titles, metadata codec), `bookmarkStorage.ts` (structure, tab backings), `bookmarkOperations.ts`, `bookmarkTitleSync.ts`, `favouriteStorage.ts`, `preferences.ts`, `bookmarkImport.ts`, `modelIntegrity.ts` (structure health), `structureRepair.ts`, `bookmarkUndo.ts` (move and delete snapshots for undo), `closedTabsUndo.ts` (closed tabs' space tab trees, and reopening them on undo) |
| Spaces | `spaceSwitch.ts`, `spaceActivation.ts`, `spaceActivationPlan.ts`, `windowSpaceChoice.ts`, `spaceTabRestore.ts`, `spaceDeletion*.ts`, `spaceDuplication.ts`, `spaceArchive.ts`, `tabTreeRebuild.ts` (reopens a saved tab tree with its folders and splits), `spaceWindowMaintenance.ts`, `spaceGroupOrder.ts`, `spaceGroupColours.ts`, `spaceGroupExpansion.ts`, `spaceGroupStore.ts`, `tabGroups.ts` (native group calls and colours), `groupOwnership.ts` |
| Tab lifecycle | `tabs.ts` (shared tab types and helpers), `tabRouter.ts`, `tabOwnership.ts`, `tabDisposition.ts`, `tabBackingSync.ts`, `tabNavigationIngress.ts`, `ownedTabActions.ts`, `backingCleanup*.ts`, `newTabDisposal.ts`, `navigationDedupe.ts`, `duplicateController.ts` ("Deduplicate?"), `crossSpaceDuplicates.ts`, `tabBookmarkLink*.ts` ("Linked to bookmark"), `tabStripOrder*.ts`, `autoTabFolders.ts`, `tabTitlePresenter.ts`, `tabDocumentTitle.ts`, `tabStatus.ts`, `selfActivation.ts`, `lastActiveTab.ts`, `recentlyClosed.ts`, `sessionTabs.ts`, `remoteTab*.ts` |
| Restart recovery | `operationJournal.ts`, `browserRestore.ts`, `startupTabRecovery.ts`, `restoredTabBackings.ts`, `windowState.ts` |
| Search and commands | `search.ts`, `searchText.ts`, `searchIndex.ts`, `searchController.ts`, `searchProjection.ts`, `searchSelection.ts`, `browserSearch.ts`, `commandBar.ts`, `browserCommands.ts`, `browserCommandCapabilities.ts`, `mediaCommands.ts` (music commands for every Search surface), `shortcuts.ts` (every keyboard shortcut, its labels and matching) |
| Media and page access | `mediaControl.ts` (finds and drives page players), `mediaState.ts` (Now Playing's tab), `mediaAccessOffers.ts` ("Fix play/pause?", build-spec §17.3), `scriptingAccess.ts` (whether and when `chrome.scripting` can be used), `musicSites.ts`, `tabContent.ts`, `tabContentCapture.ts` (asks Hyper's page script for page text), `tabContentController.ts` (the page-text cache, on while the `pageTextSearch` preference is) |
| In-page sidebar and shortcut | `inPageSidebarController.ts`, `inPageSidebarProtocol.ts`, `pageShortcut.ts`, `sidebarOpener.ts`, `sidebarDestination.ts` |
| URL identity | `urlIdentity.ts`: `normaliseUrl` for reuse and dedupe, `pageIdentity` only for bookmark matching, indicators and search aggregation |
| Shared helpers | `async.ts` (serial, coalesced and keyed runners, named locks), `collections.ts` (`isRecord`, map list and set helpers), `tabs.ts` (`tabById`), `windowState.ts` (`windowById`, `isNormalWindow`, `normalWindowIds`), `urlIdentity.ts` (`tabUrl`, `tabPageIdentity`), `bookmarkStorage.ts` (`bookmarkById`, `existingBookmarks`), `bookmarks.ts` (`bookmarkTitleWithHyper` for every Hyper title edit), `sessionValues.ts` (`sessionStorageArea`) |
| Test fixtures | `testFixtures.ts` (tabs, sources, `fakeStorageArea`, remote tab snapshots), `testBookmarkTree.ts` (in-memory bookmarks, `testBookmark`, `testFolder`, `hyperBookmarkTree`) |

## Conventions

- Modules export a `createX({ ...deps })` factory with dependencies passed explicitly, so `background.ts` only wires them.
  Pass values declared later in `background.ts` lazily (`windowSpaces: () => windowSpaces`) to avoid TDZ errors.
- Reconciliation alone commits browser-derived state.
  Keep effects in background handlers/controllers; a command completes only after its proving read commits.
  Read only the required keys from `storage.local`, not the whole operation journal on each model read.
- An intent handler is a `kind: intentHandler({...})` entry.
  If you add handlers in a new file, add that file to `handlerSources` in `tests/architecture.test.ts`.
- A handler that asks for a browser permission calls `permissions.request` synchronously in its `admit`, before any await; later, the click no longer counts as a gesture and Chromium refuses without a prompt.
- A module that journals a multi-step operation also recovers it on startup.
- Test code that moves, creates or removes bookmarks against `testBookmarkTree.ts`, an in-memory `browser.bookmarks` that answers as Chrome does, rather than a mock that records calls.
- Pass `windowId` explicitly to `tabs.group` for new groups; without it Chrome uses the last focused window.
- Background code must not import from `entrypoints/sidepanel/`.
- Reasons for these rules: [docs/decisions](../../docs/decisions/README.md).
  Model contract: [docs/model](../../docs/model/README.md).
