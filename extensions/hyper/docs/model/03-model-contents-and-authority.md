# 3. Model Contents and Authority

`HyperModelSnapshot` in `entrypoints/lib/model.ts` holds a `revision`, two input domains (`browser`, `runtime`), the Hyper model parsed from bookmarks (`hyper`), ephemeral command state (`commands`) and derived interpretations (`derived`).
Each field's type is declared in the same file; this section gives the rules the types cannot.

## Browser observation

`BrowserObservation` (`entrypoints/lib/model.ts`) is what the browser reports.
Its `tabs` carry native tab status merged with background navigation signals (`mergeNativeTabStatuses` in `entrypoints/lib/tabStatus.ts`, called by `entrypoints/lib/modelSources.ts`).
Session ownership is in `RuntimeMetadata`, not `BrowserObservation`.
Late browser and sync changes must be reread before they become authority.

## Durable Hyper bookmark model

The parsed bookmark-bar hierarchy under `hyper` is the durable Hyper model.
Its layout and identities are specified in [build-spec §5](../build-spec/05-durable-bookmark-model.md), and its title metadata in [build-spec §6](../build-spec/06-metadata-codec-and-schemas.md).
`HyperBookmarkModel` (`entrypoints/lib/model.ts`) is the parsed tree; `backings` maps each backing ID to its `BackingLocation` (`entrypoints/lib/tabDisposition.ts`).
`parseBookmarkTitle` reads trailing JSON and writers retain unknown metadata.
An archived space stays in the parsed tree, but every choice of a space a window can show goes through `shownSpaces` ([decision 50](../decisions/50-an-archived-space-stays-a-space.md)).

Native window IDs are transient and may be reused after restart.
A backing's `windowId` is a local installation-scoped recovery hint only.
It must be paired with `installationId` and must not become synced global identity.
It is remapped only after a browser start ([build-spec §11](../build-spec/11-startup-restoration-and-race-control.md)).

Active state is window-scoped.
Do not write `isActive` or `wasActive` onto every backing during a browser tab switch.
The browser determines the active tab.
Each space's folder title remembers its last active tab per window for restore ([build-spec §6.2](../build-spec/06-metadata-codec-and-schemas.md)).

## Runtime metadata

`RuntimeMetadata` (`entrypoints/lib/model.ts`) holds the facts the browser does not report directly: session ownership, active spaces, group mappings, preferences, installation identity and background controller signals.
Runtime signals are filtered against live tabs and navigation versions on reconciliation, so stale page text or media cannot describe a replacement page.
It never holds command status: an outcome belongs to the revision that proves it, and persisting it would let a restart replay a result whose effect no longer exists.

Storage keys are listed in [build-spec §5](../build-spec/05-durable-bookmark-model.md) (bookmark structure), [§6](../build-spec/06-metadata-codec-and-schemas.md) (title metadata) and [§7](../build-spec/07-local-session-and-in-memory-state.md) (`storage.local`, `storage.session` and browser session values).
Reconciliation reads them under these rules:

- Ordinary reconciliation reads only the installation ID and Search selection history keys from `storage.local`; journal and cleanup data are for their own recovery paths.
- A failed required local read retries reconciliation instead of committing a snapshot that has lost this installation's identity.

Preferences (`HyperPreferences`, specified in [build-spec §5](../build-spec/05-durable-bookmark-model.md)) are parsed from the `hyper` root folder's title in the same bookmark read as the rest of the model.

## Command status

`commands` is ephemeral root state carried by the same revision as the tree that proves it, and it is never written to durable storage.
Each entry is a `CommandStatus` (`entrypoints/lib/modelActions.ts`).
Admission also increments root revision without rereading the browser.
Result-bearing callers validate the returned shape; the result and entity become visible in the same settled revision.

- Correlation: a client only ever receives statuses whose `clientId` is its own.
  Client identity is issued by the background at `hello`, never claimed by the client, so one view cannot read or forge another's outcomes.
- Backpressure: a client may hold at most `MAX_PENDING_COMMANDS_PER_CLIENT` pending commands (`16`); a further intent is rejected rather than queued.
- Retention: every pending status is kept.
  Settled statuses are bounded to `MAX_SETTLED_COMMANDS` (`32`), evicted oldest-settled-first, and a client's settled statuses are dropped as soon as it disconnects.
  Its running effects keep their slot until they finish.
- Atomicity: a terminal status is applied inside the same commit as the snapshot that demonstrates its effect, so a view can never read `succeeded` against a tree that does not yet contain the change.

## Tab disposition

Every observed tab resolves to exactly one disposition.
Classification itself does not adopt a tab; subsequent background routing *can* place an unowned tab in the active space ([§7](07-critical-event-policies.md)).
Keep the read and the policy separate.

| Disposition | Condition |
| --- | --- |
| `ignored` / `unidentified` | The tab has no ID. |
| `ignored` / `private-context` | The tab is incognito. |
| `ignored` / `unsupported-window` | Its window is not a normal, non-private window. |
| `owned` | Its ownership names a backing that exists, whose tokens do not disagree when both present, and this tab holds the claim. |
| `loose` / `backing-claimed` | Its ownership names a backing already claimed by a lower-numbered live tab. |
| `pending-recovery` | Its ownership names a surviving space but no resolvable backing. |
| `in-transit` | It would be `owned` or `pending-recovery`, but its ownership names another window: the tab was dragged between windows and its placement has not settled. |
| `loose` / `space-removed` | Its ownership names a space that no longer exists. |
| `loose` / `unbackable-url` | It has no ownership and cannot be represented by a bookmark. |
| `loose` / `unowned` | It has no ownership. |

The backing claim is resolved deterministically by lowest tab ID, so copied session ownership leaves one claimant owning and every copy loose.
A recycled backing ID whose token disagrees is not a match; routing gives a copy its own backing instead of treating URL equality as ownership.

An `in-transit` tab is placed only by the move that carried it, as [build-spec §12.3](../build-spec/12-spaces-windows-and-activation.md) describes.
That placement is queued in event order, so activation and incidental routing (such as the ungroup the drag causes) see the tab as in transit rather than reassigning it from its stale ownership.
A route already under way when the tab leaves its window stops there, since joining a group it found in the old window would carry the tab back.
While the browser refuses group edits during the drag, the placement (`placeAttached` in `tabRouter.ts`) retries and holds the queue, so window maintenance finds a new window already showing the tab's space instead of giving it the first space.

The tab strip's order is a projection of the model, like a view, and a native move Hyper did not declare is an input taken into the tab tree, so the strip never overrules the tree ([build-spec §17.2](../build-spec/17-tabs-tab-folders-and-media.md)).
With `syncTabStripOrder` off, the strip is neither rendered from the model nor read into it.

## Tab bookmark links and names

The model derives which bookmark each owned tab is linked to, whether that link has `drifted`, and each tab's name, by the rules in [build-spec §14](../build-spec/14-tab-naming.md).
Views render these projections; the tab-bookmark sync buttons, tab rows, and Search all read them, so no view keeps its own matching memory.
The background records links, ends them with their domain, and keeps the browser's tab strip showing the same names.

It also derives two title projections.
`tabTitles` is the tab's name, else the page title its backing keeps, else what the browser reports.
`tabPageTitles` is the page title each tab's backing keeps for the page the tab shows, computed once by `tabPageTitle` ([decision 33](../decisions/33-a-tab-keeps-the-last-title-its-page-gave-it.md)).
Tab rows, Favourites and Search show `tabTitles`.
The tab strip's restored title and a bookmark made from a tab take `tabPageTitles`.

## Projections

`HyperProjection` (`entrypoints/lib/model.ts`) holds the derived interpretations, and read atoms expose slices of the same root.
`projectHyperModelForClient` (`entrypoints/lib/modelPort.ts`) sends a `HyperSidebarProjection` to the sidebar and normal newtab, declared in the same file.
It is scoped to the client's non-private window: tabs, ownerships, dispositions, links, names and titles are those of that window only, `commands` are the client's own, and `sharedDrag` is sent only to a sidebar.
`installationId?` names this installation's backings apart from other sessions'.
`window.timedMessage?` is specified in [build-spec §27](../build-spec/27-timed-messages.md).
Search derives records from committed snapshots, never from a view-owned index.

`HyperRemoteSpacePresence` maps local tab and visible active-space bookmark IDs to remote space IDs for matching pages; remote presence is projected only for `owned` tabs in another normal, non-private window, keyed by a tab or bookmark the client already received; it never contains a remote tab ID, URL, window ID, or ownership record.
Its `otherWindowTabCounts` counts, per space, the non-pinned tabs other normal, non-private windows hold as `owned` or `pending-recovery`, so a blank page counts and a tab in transit does not; it is read from live tabs, never from backings, which a closed window leaves parked ([build-spec §15.1](../build-spec/15-side-panel-layout.md#151-list-ends)).
`pending-recovery` tabs are not actionable remote targets.
Normal activation sends an opaque local reference and focuses the one exact remote target the worker resolves from its committed snapshot.
Command/Ctrl activation sends `moveTabToWindow`, which moves that exact tab and preserves its backing ownership in the current window.
Dragging an indicator dispatches the same move/reorder intent used by dragging that tab row.
A local same-page match always wins over remote presence.
Middle-clicking an indicator sends `closeTabs {condition:'page-in-space',source,spaceId}` with the same opaque reference; the worker closes every tab of that page the space holds, matched as the indicators match them: in the client window by ownership, elsewhere by an `owned` disposition (`spacePageTabIds` in `remoteTab.ts`).
A Search result's indicator sends the same intent, naming the result's tab in that space as its source; any client may send it, page Search included, because the source must be in the client's window.

A drag between windows also goes through the model ([decision 19](../decisions/19-a-drag-between-windows-goes-through-the-model.md)); the sidebar side is [build-spec §20.1](../build-spec/20-drag-and-drop-contract.md).
A sidebar that a drag leaves offers what it holds: `shareDrag {operation:'offer',token,items}` names tabs by ID and bookmarks by node ID.
The worker accepts only tabs that are in that sidebar's window and not private, and bookmarks that exist, and holds one drag in `RuntimeMetadata.sharedDrag`.
Every other window's sidebar receives it as `sharedDrag`, with bookmarks by ID and tabs only as `{kind:'tab'}`, so no remote tab ID reaches a view.
A sidebar taking the drag's tabs sends `moveTabs {sharedDrag:token,windowId,index,tree}`, which names the drag instead of the tabs.
The worker resolves the tabs from the drag, moves them only into the client's own window, routes them into `tree.spaceId`, and moves their backings to `tree.parentId` at `tree.index`.
The source withdraws its offer when its drag ends.
The drop and that end race to the worker, so a withdrawn drag is no longer projected but can still be taken until another drag replaces it or its sidebar disconnects.
