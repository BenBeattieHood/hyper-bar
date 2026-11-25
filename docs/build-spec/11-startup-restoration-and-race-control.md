# 11. Startup, Restoration, and Race Control

At worker startup, `background.ts` queues `migrateLegacyPreferences` before marking the model ready and requesting its first reconcile.
The maintenance chain is `retryPendingBackingCleanup` -> `recoverJournalledOperations` -> `bootstrapTabBackings` -> `spaceWindows.start()` -> `splitViews.start()` -> `tabStripOrder.start()`.
Journal recovery dispatches by kind to the modules listed in [model §6](../model/06-serialization-causation-and-failures.md).
`runtime.onStartup` separately enables browser-start group recovery; an extension-only restart (reload, update, or re-enable) neither remaps windows nor reopens a window's own unclaimed backings, since each open window is still its own and its tabs re-attach to their backings ([decision 8](../decisions/08-only-a-browser-start-restores-a-window-s-tabs.md)).

The browser restores first.
A reopened window or a restarted browser brings its tabs back in a burst, and those tabs claim their parked backings as they are routed.
`bootstrapTabBackings` (`startupTabRecovery.ts`) waits for 750 ms of stable tab observations, at most five seconds.
`createBrowserRestoreBarrier()` (`browserRestore.ts`) holds browser-start restoration until startup has matched restored windows and completed the bootstrap, so no parked backing is adopted prematurely.
A space selected meanwhile opens without adopting; after settlement, reopen only backings no restored tab claimed.

Before `bootstrapTabBackings` routes any tab, it pairs tabs that hold no backing with backings no tab holds, one to one: same page first, then same site, then same tab position in the same window.
A backing pairs within its own window, or with any window's tab once its window is closed; within each tier its own window and then the nearest position win.
A browser start loses Chromium's tab ownership, and a restored tab can come back at an earlier address than its backing recorded, so routing tab by tab would give it a new backing and reopen its old one as a duplicate.
See [decision 32](../decisions/32-a-restored-tab-takes-back-its-own-backing.md).

Restoration fails closed when native group/ownership certainty is unavailable.
It must not create speculative duplicates merely to maximize restoration.

Use:

- a serial mutation runner that survives rejected tasks (`createSerialAsyncRunner` in `async.ts`);
- a coalesced refresh runner (`createCoalescedAsyncRunner` in `async.ts`), and a per-key coalescer that rate-limits a constantly firing source (`createKeyedCoalescer` with `minIntervalMs`, also in `async.ts`);
- parallel branches that report failures only after all of them run (`runConcurrentOperations` in `async.ts`);
- nested pending-operation counters (`createPendingOperationGauge` in `sidepanel/lib/pendingOperations.ts`);
- per-window group locks (`withHyperGroupLock` in `tabGroups.ts`);
- Web Locks for cross-context operations where available (`withNamedAsyncLock` in `async.ts`);
- tab lifecycle generations (`advanceTabGeneration` and `tabGenerationsAreCurrent` in `tabs.ts`);
- monotonically increasing space-activation versions (`spaceActivationVersion` in `sidepanel/lib/spaceActivation.ts`);
- per-window activation tokens shared by UI intent and native events (`spaceActivationTokens` in `background.ts`);
- stable-snapshot waits with bounded retry (`waitForStableTabSnapshot` and `waitForRestoredTabGroup` in `tabs.ts`);
- final `tabs.get`, URL, ownership, group, and generation revalidation before commits.

Never solve races with arbitrary sleeps.
The one exception is the one-second wait after a window closes before parked tabs reopen ([§10](10-exact-tab-backing-lifecycle.md)), which keeps a quitting browser from reopening tabs on its way out.
