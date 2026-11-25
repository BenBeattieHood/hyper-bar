# Debugging guide

Read this when restored tabs, space activation or bookmark visibility regress.
The rules themselves live in the [model spec](model/README.md) and the [decisions](decisions/README.md).

## Which start ran

First establish whether the failing run followed a browser start or an extension-only restart (reload, update or re-enable).
Only `runtime.onStartup` sets `startupGroupRecoveryInProgress` in `background.ts`, and only then does `bootstrapTabBackings` in `startupTabRecovery.ts` map old window IDs to new ones and reopen each window's missing space tabs ([decision 8](decisions/08-only-a-browser-start-restores-a-window-s-tabs.md)).
Every start then pairs tabs that hold no backing with backings no tab holds, in `reclaimRestoredTabBackings` ([decision 32](decisions/32-a-restored-tab-takes-back-its-own-backing.md)), and ends by reopening backings parked by a closed window in a window already showing their space (`reopenParkedTabs` in `spaceSwitch.ts`).

## Known gap: window mapping can guess

`mapRestoredWindowIds` in `windowState.ts` maps each previous window by tab ownership first, then by the most pages it shares with a current window.
It does not reject equal overlaps, so two windows showing the same pages can be swapped before backing reconciliation acts on them.
Fix it with tie tests and by failing closed before deleting an uncertain backing, never by remapping windows on an extension-only restart.

## Activation regressions

Check how these interact:

- `createLatestSpaceSelector` in `entrypoints/sidepanel/lib/spaceActivation.ts` coalesces a burst of space choices into the latest.
- The per-window token in `entrypoints/lib/spaceActivation.ts` lets the latest activation win; an older one stops at its next check.
- The ledger in `selfActivation.ts` tells activations and group events Hyper caused from the user's.
- `spaceLastActiveTabToken` in `bookmarks.ts` names each space's last active tab per window.
- `resolveSpaceRestoreGroup` in `tabs.ts` waits for the group of a tab the browser is still restoring.
- The browser's own active tab.

## Bookmark visibility and duplicate regressions

Check:

- That repair adopted the space's marked bookmarks root (`hyper.spaceBookmarks`, in `bookmarkStorage.ts`).
- `Space.id`, the durable identity, against `Space.rootId`, the ID of that root.
- The active space's projection from `localBookmarksBySpaceId`.
- That tab backings stay out of duplicate checks and Search (`isTabBackingBookmark`).
- The visible scope passed to duplicate checks.
- `normaliseUrl` against `pageIdentity` in `urlIdentity.ts`: the first for reuse and dedupe, the second only for bookmark matching, indicators and Search aggregation.

## Limits no test covers

- Firefox has no real-browser e2e suite, so check it by hand.
- Localhost mocks do not prove focus transfer, worker lifecycle, group timing, favicon behaviour or native shortcut dispatch.
- An accelerator pressed in browser chrome needs a manual check.
- Removing an optional permission outside Hyper may not update an open view at once.
- Chromium groups carry no durable Hyper marker, so startup falls back to session mapping, live ownership and the ordinal group titles (`𝒉¹`, `𝒉²`).
- Page-content Search cannot read restricted or internal pages, and WebExtensions do not expose the omnibox's ranked suggestions.
