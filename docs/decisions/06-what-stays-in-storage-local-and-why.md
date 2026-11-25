# 6. What stays in `storage.local`, and why

**Decision.** Hyper keeps only the five machine-local values below in `storage.local`; everything else that must outlast the browser session is in the bookmarks (decision 4).
The installation keys are read and written in `bookmarkStorage.ts`, the journals in `operationJournal.ts` and `backingCleanupJournal.ts`, and the search picks by `searchController.ts`.
How each key is shaped is in [build-spec §7](../build-spec/07-local-session-and-in-memory-state.md).

**Why.** Each key would be wrong, or too costly, on another device:

| Key | Why it is not in the bookmarks |
| --- | --- |
| `hyperInstallationId` | It must differ on every installation. Synced, two installations would claim the same backings. |
| `hyperInstallationStartedAt` | When this installation began, so it can tell the installation it replaced from a device still in use (decision 20). |
| `hyperOperationJournal:v1` | Describes this worker's half-finished multi-step effects. Replayed on another device, it would act on tabs that are not there. |
| `hyperPendingBackingCleanup:v1` | Exact backings this installation still has to remove. Machine-local for the same reason. |
| `hyperSearchSelectionHistory` | A personal, high-churn ranking signal. Syncing it would write a bookmark every time the user picks a search result. |

**Cost.** Removing the extension deletes `storage.local`, so a reinstall starts with no search picks and no unfinished journal entries.
It must also find its installation ID again from the bookmarks it left behind (decision 20).
