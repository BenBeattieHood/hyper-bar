# 22. A busy browser cannot hold Hyper up

**Decision.** Hyper's work keeps pace with the browser however many events arrive:
- The reconciler reads from a refilling allowance, so a burst of events reads at once but a stream of them folds into a bounded number of reads a second (`modelReconciler.ts`).
- A command's terminal status commits with the first read begun after it was queued, even one that later events have made stale, because that read already holds the command's effect.
- Navigation events from frames inside a page start no read.
- Each tab keeps at most one of each kind of upkeep waiting in the mutation queue, carrying its newest value, and the title and fragment-only updates are held to a minimum interval (`createKeyedCoalescer` in `async.ts`, `createNavigationUpdateQueue` in `navigationDedupe.ts`).
- Sending a tab to an address or a web search in place runs at once, as the address bar does, rather than behind the mutation queue (`navigateTab`).
- Search keys its answers by the query, not the model revision, so a model change asks again without discarding an answer on its way, and the newest request's answer wins.

The rates and intervals are in [model §4](../model/04-store-and-transport.md).

**Why.** A page that retitled itself or rewrote its address many times a second queued a title sync and a navigation update for every change, each reading and writing bookmarks.
The queue grew without end, so a new tab's search waited behind it and never ran.
Every event also invalidated the read under way, and the reconciler read again at once, thousands of browser calls a second in Edge, while the stale reads held back the settlement a search pick waited for.
Each new revision also dropped the search answer in flight, so a busy model left Search with no results for Enter to act on.

**Cost.**
- In a sustained stream of events the model can trail the browser by up to 50ms a read.
- A backing's title and the bookmarks following the page title can lag a retitling page by up to a second.
- A search answer can briefly be one model revision old.
