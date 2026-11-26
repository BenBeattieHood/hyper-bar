# 4. Store and Transport

Only the background model imports `jotai/vanilla` for domain state.
`createBackgroundModelRuntime` creates one store via `createHyperModelStore`:

```ts
const hyperModelAtom = atom<HyperModelSnapshot>(
  materialiseHyperModel(0, emptyHyperModelSources),
);
const hyperRevisionAtom = atom((get) => get(hyperModelAtom).revision);
const commandStatusesAtom = atom((get) => get(hyperModelAtom).commands);
```

There is no second root.
Command status is read from the snapshot, not from a parallel atom, because two roots cannot be committed atomically and a view that reads them separately can observe an outcome and a tree from different reads.

Browser-effect modules own browser calls, reconciliation, locks, and error handling.
`commitHyperModelAtom` replaces reread sources, rederived `hyper` and `derived`, terminal settlements and revision in one root write.
`setCommandStatusesAtom` commits pending/disconnect bookkeeping with a new revision but without rereading the tree.
Neither write atom calls browser APIs.
One root prevents tabs and ownership from different reads mixing.
An intent's effect lane waits for its terminal settlement's proving read to commit, including when an older in-flight read first commits without that settlement.
A failed read leaves the settlement queued for the scheduled retry instead of turning a completed browser effect into a failed command.

A commit reuses every reference from the previous snapshot whose value did not change (`preserveIdentity`).
Each reconciliation re-reads and re-derives, so an untouched bookmark tree would otherwise arrive as new objects on every passing navigation event, and a view rendering from the model cannot tell that apart from a real edit.
Identity therefore means what a reader assumes it means: a changed reference is a changed value.
Only `revision` is guaranteed to differ between commits.

## Port protocol

Views use `runtime.connect({ name: 'hyper-model-v1' })`.
Every message is validated against the wire schema before a handler sees it; an unparsable or unknown message is a `protocol-error`, never a partially applied change.

Client to background:

| Message | Fields | Meaning |
| --- | --- | --- |
| `hello` | `protocolVersion`, `role`, `windowId?` | Must be first. A mismatched version is rejected. |
| `ack` | `sequence` | Confirms the delivery with that exact sequence. |
| `intent` | `commandId`, `kind`, `baseRevision`, `payload` | Requests an action, stating the revision it was decided on. |
| `search-query` | `requestId`, `query`, `commands`, `limit?`, `includeFolders?` | Queries model-derived records; commands are presentation descriptors only. |
| `resync` | None | Discards the client cache and restarts delivery. |

Background to client:

| Message | Fields | Meaning |
| --- | --- | --- |
| `welcome` | `clientId`, `protocolVersion`, `role`, `buildId` | Issues the client identity used for command correlation, and names the worker's build. |
| `snapshot` | `payload`, `revision`, `sequence` | The client's projection at that revision. |
| `command-status` | `statuses`, `revision`, `sequence` | Status-only delivery for the page Search role. |
| `accepted` | `commandId`, `revision` | The intent entered the serial lane. |
| `rejected` | `commandId`, `reason` | The intent never entered the lane. |
| `search-result` | `requestId`, `results`, `revision` | Correlated query results from one committed revision. |
| `search-error` | `requestId`, `reason` | The query could not be served. |
| `protocol-error` | `reason`, `buildId` | The connection violated the contract. |

Each port carries at most one unacknowledged delivery.
Revisions produced while one is in flight collapse into a single follow-up sent on `ack`, so a slow or wedged view cannot make the background queue snapshots without bound.
No delta patches are sent today: deliveries are full scoped projections.
The acknowledged revision gates `intent.baseRevision` exactly; `resync` clears the acknowledged and in-flight deliveries together.
Search validation caps query length at 512, request ID at 128, commands at 96, descriptor fields at 512 and `limit` at 1..48.
These bounds keep port work finite.
If projecting or posting an update fails, the background logs the error and disconnects that port so its view can reconnect instead of silently staying on a stale revision.
Other ports continue receiving their own projections.

A reconnect discards cached domain state and rehydrates from the first delivery after `welcome`.
No view listens to browser events or invokes browser APIs for domain state.

Views connect through `createHyperModelClient` (`entrypoints/lib/modelClient.ts`), which owns the transport only: handshake, acknowledgement, reconnection, and intent correlation.
It derives nothing, so a view cannot disagree with the background about what the browser looks like.
A dropped port is routine, since the worker sleeps when idle, and the client reconnects with backoff from 250 ms doubling to 5000 ms; a `protocol-error` is terminal and is never retried.
An intent or search made while the client is not connected wakes the worker at once, skipping the backoff, and is sent after the first acknowledged snapshot.
It rejects as `unreachable` only if the connection is not back within 5000 ms.
An intent or search that Chrome refused to post is sent again, with the same command id, on the connection that replaces the port.
It is sent at most twice; a second refusal rejects it as `unreachable`.
An intent that left before its port dropped rejects as `disconnected`, and a settlement waiter for an accepted command resolves with `dropped: true`.
The client never repeats such an intent; only a view whose intent is safe to repeat, such as activating a tab, sends it again.
A settlement waiter and an optimistic overlay are released by a drop only once the intent has left; an intent still waiting to be sent is resolved by its own outcome instead.
Admitted effects continue in the background regardless.
See [decision 41](../decisions/41-an-intent-chrome-refused-is-sent-again.md).

Every build stamps one build id into the worker and its pages alike, and the worker states its own in `welcome` and in `protocol-error`.
The client reports a worker from another build, or one that states no build, to its view once, and the view shows a "Hyper was updated." notice until the user reloads Hyper from it.
The connection carries on meanwhile, so the intents both builds share still work.
A refusal from a worker of the page's own build, such as a private window's, shows no notice.
On a mismatch, page Search asks the web page that framed it to close it before Hyper reloads, and the in-page sidebar, which outlives the reload, changes its notice to "Reload this page to use Hyper here." (`entrypoints/inpage/main.tsx`).
See [decision 52](../decisions/52-pages-notice-a-worker-from-another-build.md).

The port server listens from the moment the worker starts.
A port that connects sooner is accepted, but its messages wait until the first nonzero model revision and `inPageSidebar.ready`, independently of slower maintenance and repair.
No view is ever served the empty seed model.
See [decision 42](../decisions/42-the-model-port-listens-from-worker-start.md).

The port authenticates an extension-page role before accepting any other message.
Window identity is taken from `sender.tab` whenever the platform supplies it.
It cannot for a side panel, so a sidebar's claim is corroborated rather than proven: it is bounded by single occupancy, and claiming a window that already has a sidebar evicts the incumbent instead of silently observing alongside it.
A claim that contradicts the window the browser reports is refused.
The sidebar and normal new-tab page receive only their non-private window's tab, ownership, disposition, active-space, and group projection plus durable Hyper bookmarks and their own command statuses.
A page Search frame must prove both its extension URL and its embedded source tab and window parameters.
An in-page sidebar frame (`inpage.html`) takes its window from `sender.tab` and must present the token the background issued to Hyper's content script in that tab; it is served the sidebar projection but never occupies or evicts the window's browser-sidebar slot, which is what tells the background whether the browser's own sidebar is open.
The *page Search* role, in contrast, receives query results and revision/status messages only, never a root snapshot or another window's data.
Its space-switch and music commands are contributed by the background.
It may submit only `activateTab` (not remote), `closeTabs` (only `page-in-space`), `deleteHistory`, `navigateTab`, `forgetSearchSelection`, `recordSearchSelection`, `selectSpace`, `setTabMediaPlayback`, and `setTabMuted`.

`createBrowserModelSourcesReader` reads bookmarks, tabs, windows, focused window, optional groups and recently closed tabs; then session ownership, group/space mappings, root preferences and controller signals.
`createHyperModelReconciler` increments an observation generation and coalesces reads.
It retries when an event invalidates an in-flight read, but after `MAX_STABLE_READ_ATTEMPTS = 8` may commit a stale snapshot to avoid starvation.
A terminal settlement commits with the first read begun after it was queued, stale or not, since that read already holds its effect.
Reads draw on an allowance of `READ_BURST = 20` refilled at `READS_PER_SECOND = 20`, so a burst reads at once and a nonstop stream folds into at most 20 reads a second.
Failed reads retry after `FAILED_READ_RETRY_MS = 1000`.
Thus events are not silently lost, but stability is not guaranteed on every commit.

Per-tab upkeep is throttled the same way: each tab keeps at most one title sync, one history title update and one navigation update waiting, folding later requests into it (`createKeyedCoalescer` in `entrypoints/lib/async.ts`).
Title syncs and history title updates start at most once a second per tab (`entrypoints/background.ts`).
Navigations that change only the fragment start at most every `FRAGMENT_UPDATE_INTERVAL_MS = 250` per tab (`entrypoints/lib/navigationDedupe.ts`).
