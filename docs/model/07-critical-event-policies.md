# 7. Critical Event Policies

## Groups

Only a group mapped to a `(windowId, spaceId)` pair is projected as owned.
Do not turn every arbitrary native group into a Hyper space.
`resolveTargetGroup` (`entrypoints/lib/tabRouter.ts`) can adopt an unmapped group that `resolveHyperGroupForSpace` (`entrypoints/lib/tabGroups.ts`) recognises by its Hyper ordinal, title and candidate IDs, or create and map a group.
Owned groups follow durable space order; expanding one can collapse other owned groups in its window, never arbitrary user groups.

Ownership is bidirectional and both directions are enforced, so a session value outliving its group and a group reissued a new ID when it moves windows are both detected.

- A `(windowId, spaceId)` pair owns at most one group, and a group belongs to at most one pair.
- A mapping whose group no longer exists expires quietly.
  Its space simply has no group until one is adopted.
- A mapping whose group is observed in a different window migrates to that window, keeping its space.
  If the destination window already has a group for that space, the stale mapping is dropped rather than displacing a mapping that matches a real group.
- If two spaces claim one group, or one space claims two groups in one window, every claim involved is dropped and the conflict is reported.
  Routing can subsequently map a recognized or newly created group.
- Mapping a group to a space displaces both the previous group for that space and the previous space for that group (`adoptGroup` in `entrypoints/lib/groupOwnership.ts`).
  Clearing a mapping (`unadoptGroup`) removes both directions.
  These are reconciliation operations on the registry, not intent kinds.

## Tabs and native duplicates

Every observed tab resolves through the disposition table in [§3](03-model-contents-and-authority.md).
`tabRouter.route` subsequently assigns unmatched backable tabs to the active space when its caller enables that fallback (including tab creation and bootstrap); it can also match an existing space by page/ownership/group.
Pinned tabs are not routed.
Classification cannot silently claim a backing; routing and ownership writes must establish that claim separately.

Duplicate URLs are valid browser state, and every duplicate keeps its own backing ID and token.
If copied session ownership points two live tabs at one backing, the second tab gets a fresh backing.
When Hyper dedupes, and which copies it keeps, is owned by [build-spec §13](../build-spec/13-opening-reuse-and-deduplication.md).

## Split views

Split membership is browser state, read through the projected tabs like any other tab field (`splitViewId`), and `commandCapabilities.splitViewTabs` says how many tabs a split can hold.
Hyper also keeps each split in bookmarks as a split view folder, and a controller keeps the two in step from committed snapshots.
The behaviour is owned by [build-spec §17.1](../build-spec/17-tabs-tab-folders-and-media.md).

## Close and replace

On tab URL, title, pin, group or window changes, reconcile the exact tab ID and backing.
`tabs.onReplaced` (`entrypoints/background.ts`) only schedules reconciliation; nothing moves ownership or a backing claim to the replacement tab ID.
On close, `tabRemoved` (`entrypoints/lib/tabBackingSync.ts`) applies the close and cleanup rules of [build-spec §10](../build-spec/10-exact-tab-backing-lifecycle.md); a tab closed with its window, including at browser shutdown, keeps its backing so the tab can be restored.

## Other sessions

Every installation is a session, named by the `installationId` on its backings, and only this installation's backings are ever restored, reconciled or adopted (the reinstall adoption of [decision 20](../decisions/20-a-reinstall-keeps-the-tabs-it-backed.md) aside).
With the `showOtherSessions` preference on, the sidebar derives a section for each other installation from `bookmarkTree` and the projected `installationId`; what it shows and how it drops is owned by [build-spec §20.2](../build-spec/20-drag-and-drop-contract.md).
A drop between sessions sends one `moveSessionTab` with an item per tab.
Moving another session's tab into the window hands its backing to this installation and window (`moveBackingToSession`), moves it to the drop position and opens a tab whose ownership names it, so routing takes it over with its name and links.
A copy for another session (`copyBackingToSession`) gets its own token and no window.
Both are in `entrypoints/lib/bookmarkStorage.ts`.
No extension API closes another device's tab, so a session still running there lists it again.

## Bookmarks, imports, and metadata

A browser bookmark created outside `/hyper` is never moved into a space automatically.
An explicit import (`importBookmarkFolder`) chooses a destination, is journalled ([§6](06-serialization-causation-and-failures.md)) and reconciles the completed subtree.
A manual move into a visible Hyper root is respected; external nodes stay external.

Metadata-only title changes are not ignored: they are parsed, preserved and reconciled.
Unknown metadata and future schema values are preserved.
Custom bookmark titles do not follow page-title changes; structural roots and hidden tab backings do not become Search records.

`assessStructureHealth` (`entrypoints/lib/modelIntegrity.ts`) distinguishes `unreadable` (no bookmark bar), `absent`, `incomplete`, `ambiguous` (duplicate role) and `healthy`.
`watchStructureRepair` and `decideStructureRepair` (`entrypoints/lib/structureRepair.ts`) decide only when the model asks for repair: for an absent or incomplete tree, once per gap signature until it is healthy again, and never for an unreadable or ambiguous one.
The repair itself is `ensureHyperBookmarkStructure` (`entrypoints/lib/bookmarkStorage.ts`), which every bootstrap, space deletion, space activation, archive, startup tab recovery, favourite write and preference write also calls.
Each call merges duplicate folders through `ensureUniqueMatchingFolder` and `mergeDuplicateFolders`: children move into the first match and the emptied duplicates are removed.
So an ambiguous tree the watcher skips is still merged by the next effect that ensures structure.

## Startup, privacy, and unsupported APIs

The startup chain is owned by [build-spec §11](../build-spec/11-startup-restoration-and-race-control.md).
Private tabs are ignored for normal ownership; private windows receive no regular projection or Search records.
Optional groups, session, scripting, permissions and browser-command capabilities are checked.
Some unsupported handler APIs throw and settle as `browser-error` ([§6](06-serialization-causation-and-failures.md)) rather than `unsupported`.
