# 6. Serialization, Causation, and Failures

`createIntentSubmitter` rejects unsupported kinds, future base revisions and malformed target payloads before admission.
It reads and writes the command table without suspension, calls `handler.admit` immediately, and runs effect plus terminal reconciliation on one promise `effectLane`.
`admit` runs while the view's port message is still being dispatched, the only moment the browser counts the user's click as a gesture, so a call that needs one, such as a permission request, starts there ([decision 37](../decisions/37-a-permission-is-asked-for-as-the-click-is-admitted.md)).
What `admit` returns is handed to `run`; a promise joins the lane only once it settles, so a prompt waiting on the user holds up no other command.
A failure does not poison later commands.
Many handlers also use `queueGroupMutation` (the background's `pendingGroupMutation` chain); group routing uses `withHyperGroupLock` per window.
Preference, Search/history and controller runners have separate serialization/coalescing.
Browser listeners and maintenance can use the mutation queue outside port intents.
The intent lane orders commands and proof, not every browser callback globally: browser APIs are not transactions.
The named `hyper:space-mutation:<spaceId>` lock is taken by `deleteSpace` (`entrypoints/lib/spaceDeletionController.ts`), `setSpaceArchived` (`entrypoints/lib/spaceArchive.ts`) and space tab restore (`createSpaceTabRestore` in `entrypoints/lib/spaceTabRestore.ts`).
Per-window group locks, the named space lock and serialised preference writes keep unrelated command paths off the same structure.

Browser events caused by Hyper are expected evidence, not loops to ignore.
Correlation IDs do not occur in browser event payloads.
`TargetKey` has `bookmark:`, `group:`, `space:`, `tab:` or `window:` plus ID.
The ledger stores up to `MAX_PENDING_EXPECTATIONS = 256` exact expected `(target, change, commandId)` entries and generation counts.
An observation that matches a declared expectation consumes it and does not advance that target's generation; every other observation does.
This is what lets a plan distinguish its own evidence from a conflicting external change without inventing a writer identity the browser does not provide.

`createIntentSubmitter` (`entrypoints/lib/modelIntents.ts`) gives each command one `EffectFence` (`entrypoints/lib/modelGuards.ts`) over its declared targets and calls `check` before `handler.run`.
`check` throws `SupersededTargetError` if any fenced target's generation has changed since admission.
`extend` checks, then adds targets discovered after admission at their current generation.
`step` checks, declares the effect's expected evidence, runs the effect, then checks again.
Only some effects use the fence beyond the admission check:
- `activateRemoteTab` and `moveRemoteTabToWindow` (`entrypoints/lib/remoteTabOperations.ts`) extend with the tab they resolve and step their browser calls;
- `moveTabsPreservingActive` (`entrypoints/lib/tabs.ts`) steps its move when given a fence, which only the `moveTabs` handler passes;
- the `page-in-space` form of `closeTabs` extends with the tabs it closes (`entrypoints/lib/remoteTabBackground.ts`), then closes them without steps.
  Ordinary `closeTabs` and every other handler run unfenced after the admission check.
  `runGuardedEffectPlan` in `entrypoints/lib/modelGuards.ts` has no production caller.
  The submitter forgets a command's unmatched expectations once it settles, so an old effect cannot mask a later external event.
  `windowSpaceChoice` uses `spaceSwitch.admit` and `runIfLatest` to make newer window choices win.

Admission can reject `unsupported`, `precondition-failed`, `not-permitted`, `too-many-pending` or a duplicate command ID (mapped to precondition failure at the submitter); local transport can reject `disconnected`.
Terminal `CommandFailureReason` permits `browser-error`, `not-permitted`, `postcondition-failed`, `precondition-failed`, `superseded`, `unsupported`.
Ordinary handler throws currently settle as `browser-error`; fence throws settle as `superseded`; a handler that throws `CommandFailureError` settles with the reason it names, as a search in a browser without a default engine does (`unsupported`).
`submitSettledIntent` returns that reason as the outcome's `failure`.
Command bounds and retention are in [§3](03-model-contents-and-authority.md).

## Destructive postconditions

`destructiveOutcomePolicies` (`entrypoints/lib/modelActions.ts`) distinguishes bookmarks deliberately inside a deleted space from bookmarks retained when tabs close.
`deleteSpace` verifies its postcondition with `deleteSpacePostconditionViolations` (`entrypoints/lib/spaceDeletion.ts`).
`closeTabsViolations` (`entrypoints/lib/modelActions.ts`) has no production caller, so nothing verifies the `closeTabs` postcondition below.

| Action | Live tabs | Backings | Native groups | Authored bookmarks |
| --- | --- | --- | --- | --- |
| `deleteSpace` | Close the tabs the space demonstrably owns | Delete | Release (ungroup, never close) | Delete, or move to the first other shown space when asked |
| `closeTabs` | Close the named tabs | Delete only backings left unclaimed | Retain | Retain |

- `deleteSpace` postcondition: the space root is absent, every recorded owned tab is closed, every released group mapping is gone, and the space's authored bookmarks are gone with its root, or were moved before anything closed when `moveBookmarks` asked.
- `closeTabs` postcondition: every named tab is closed, every removed backing is absent, and every retained backing is still claimed by a live tab.
  Retaining a backing that nothing claims is a violation.
- A backing moved out of the hidden `tabs` folder stops being a backing.
  The move is respected: the node stays where the user put it and its tab becomes loose.
  Moving it into another space's hidden folder reassigns it.
- Structure repair has no intent kind; [§7](07-critical-event-policies.md) owns when it runs.

For each journalled multi-step operation below, record the operation before its first effect, use compensating effects only when provably safe, and retain unresolved work rather than guess.
Stable tab snapshots use bounded quiet periods and timeouts, not an unbounded wait for an event.

The journal at `hyperOperationJournal:v1` keeps at most `MAX_LIVE_OPERATIONS = 64` and `MAX_ABANDONED_OPERATIONS = 32` separately.
Each `DurableOperation` has `id`, `idempotencyKey`, `kind`, `phase` (`prepared`, `effect-applied`, `verifying`), `recovery` (`rollback` or `abandon`), `payload`, `completionProof`, `startedAt`, `updatedAt`.
Write `prepared` before the first browser or bookmark effect; record exact returned IDs immediately after each effect.
Remove the record only after a fresh read proves the terminal condition.
On worker start the resolver may complete a fully proved operation or roll back only exact Hyper-created entities named in the entry.
It must otherwise retain an `abandoned` record for explicit user repair; it must never retry or undo an unprovable browser effect.

- `import-bookmark-folder` key: source folder plus destination parent.
  Proof: exact imported root ID and parent.
  Before descendant copy, record the created root.
  Recovery removes that exact root only while it remains at the recorded parent; an unrecorded or moved root is abandoned.
- `delete-space` key: source space ID.
  Payload: target space, recorded source tab/backing identities, group mapping keys, prior active-space values, and later closed tab/released group IDs.
  Proof: source root absent, recorded tabs no longer owned by source, and source group mappings removed.
  If this cannot all be proved, abandon; after a restart never reopen closed tabs or reassign windows over possible user changes.
- `duplicate-space` key: source space ID.
  Payload: source space, asking window, and whether that window's tabs are copied.
  Proof: the exact copy folder ID (`pending` until it exists), the spaces folder, the window, and with tabs the token of the copy of the tab the source last showed.
  Until finished, the copy's title carries the operation ID, so recovery also finds a copy created before its ID was recorded.
  Recovery removes a recorded or marked copy that never reached `verifying`, only unmarks one that did, and abandons a copy moved out of the spaces folder.
- `restore-space-tabs` key: space ID plus live window-session identity.
  Payload: requested backing IDs/tokens and every exact created tab ID.
  Proof: each created tab has the recorded ownership and backing claim.
  If suspension occurs between tab creation and recording its ID, abandon; do not delete or claim a same-URL tab by inference.
- `move-tab-to-window` key: exact tab ID, source/destination windows, and backing token.
  Payload: source index plus source and destination ownership.
  The move re-reads the tab, updates the same backing's window metadata, and persists the exact destination ownership before completion.
  Its expected `tabs.onAttached` event is consumed once so ordinary attachment routing cannot reassign preserved ownership.
  Proof: the recorded tab remains live in the destination with matching ownership.
  All-source/no-effect is a no-op rollback; mixed, closed, private-context, or externally moved results are abandoned rather than moved back automatically.

Failed backing removals go to a separate cleanup journal, `hyperPendingBackingCleanup:v1`, specified in [build-spec §10](../build-spec/10-exact-tab-backing-lifecycle.md).

Startup `recoverDurableOperations` delegates by kind; recovery stays with the module that writes the operation and knows its proof, rather than a generic URL matcher ([decision 13](../decisions/13-the-background-entrypoint-only-wires.md)):

| Kind | Written by | Recovery owner |
| --- | --- | --- |
| `move-tab-to-window` | `remoteTabBackground.ts` | `remoteTabController.recover` |
| `restore-space-tabs` | `spaceTabRestore.ts` | `recoverSpaceTabRestore` |
| `import-bookmark-folder` | `bookmarkImport.ts` | `bookmarkFolderImport.recover` |
| `delete-space` | `spaceDeletionController.ts` | `recoverDeletedSpaceOperation` in `spaceDeletion.ts` |
| `duplicate-space` | `spaceDuplication.ts` | `recoverSpaceDuplication` |
