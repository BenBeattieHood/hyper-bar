# 7. Local, Session, and In-Memory State

Use these durable local keys, each of which must not sync:

- `storage.local.hyperInstallationId`
- `storage.local.hyperInstallationStartedAt`
- `storage.local["hyperPendingBackingCleanup:v1"]`
- `storage.local["hyperOperationJournal:v1"]`
- `storage.local.hyperSearchSelectionHistory`

Preferences are not local keys; they live on the `hyper` root folder's title ([§5](05-durable-bookmark-model.md)), so they sync with the bookmarks.
Startup moves the legacy `hyperTabFolderMode`, `hyperCombineTabsAndBookmarks`, and `hyperInPageSidebar` local keys there once.

Use these session values:

- active space `storage.session["hyperActiveSpaceId:v1:<windowId>"]`; the selected space is window-session state and must never be written durably.
  Chromium has no `sessions.setWindowValue`, so session storage is the only tier
- mirrored fallback `storage.session["tabSpaceId:<tabId>"]`
- Chromium group mapping `storage.session["spaceGroupId:<windowId>:<spaceId>"]`
- in-page sidebar issued tokens `storage.session.hyperInPageSidebarTokens`
- tabs seen split this browser session `storage.session.hyperSplitViewTabIds`, pruned to open tabs
- colour Hyper last gave or saw on each group it owns, by group ID, `storage.session.spaceGroupColours` (`SYNCED_GROUP_COLOURS_KEY` in `spaceGroupColours.ts`); a group no longer wearing it was recoloured by the user
- when each site was last offered media access, by origin, `storage.session.hyperMediaAccessOffers` (`mediaAccessOffers.ts`)
- Firefox tab session value `hyperSpaceId` and window session value `hyperActiveSpaceId`; Chromium uses the storage.session fallbacks above

Legacy local keys `activeSpaceId` and `activeSpaceId:<windowId>` are removed during active-space reconciliation; stale session window keys are pruned.

Per-tab ownership:

```ts
interface TabOwnership {
  spaceId: string;
  windowId?: number;
  backingId?: string;
  backingToken?: string;
  url?: string;
}
```

Read browser tab session values first and fall back to session storage.
Mirror tab writes best-effort; window writes use native window session values where available and the session-storage fallback otherwise.
Cleanup attempts both tab stores independently.

Generate `hyperInstallationId` once, serialized across extension contexts with Web Locks when available plus a module-local promise.
Native window IDs can collide across synced installations; mutate, restore, or remove only backings whose `installationId` belongs to this installation.

Removing and re-adding the extension clears `storage.local`, but not the bookmarks.
So before generating an ID, take the installation whose backings name the most currently open windows: only this browser can have opened them, so it is the same installation, reinstalled.
Otherwise record when this installation started in `hyperInstallationStartedAt`.
An installation from before that key existed records the date of its oldest backing instead.
The installation it replaced is the most recent other one whose newest backing predates that start; another device still in use keeps adding backings after it.
When a space opens, that installation's backings with no window, which were parked for the space, are adopted with its own parked backings, except pages the space already has.
The adopted backings take this installation's ID and the window they reopen in.

Page snapshots and media targets stay in background memory and are reconstructible; view-local state is listed in [model §2](../model/02-the-one-way-flow.md).
