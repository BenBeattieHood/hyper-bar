# 8. Search

`searchController.initialize` loads up to 1200 history entries from the last 180 days and commits them as `RuntimeMetadata.historySearchItems`.
History events and tab title changes update the background cache then reconcile.
`searchRecordsForWindow` derives non-private current-window tabs, spaces, local bookmarks, favourites, filtered captured page text and history from one committed snapshot, memoized per snapshot and window.
The controller interns each window's records so unchanged records keep their identity, and with it their cached normalised text, across revisions.
Results never carry captured page text across the port.
An empty query, as Search opens, fills the index in idle batches of 400 records.
`SharedSearchIndex` keeps its prefix and tolerant FlexSearch indexes warm and syncs them to each request's records, then ranks only hits among those records.
A record that left the request can never be returned, so ranking stays tied to the revision and window whose results are actionable ([decision 29](../decisions/29-search-ranks-by-summed-tiers-over-a-warm-index.md)).

Ranking tiers and weights are owned by [build-spec §21](../build-spec/21-search-new-tab-and-page-overlay.md), with reasons in [decision 29](../decisions/29-search-ranks-by-summed-tiers-over-a-warm-index.md) and [decision 47](../decisions/47-search-matches-containing-folders-and-normalises-each-record-once.md).

An empty query answers with the last 10 distinct picks, newest first, each marked `recent` with the query and result ID it was picked under.
A pick that no longer exists falls back to another record for the same page, then to its address, and commands the view cannot run are skipped.

The port's `search-query` sends text, bounded presentation-only command descriptors, optional folders and limit; it never supplies browser records or a claimed active space.
For page-search the worker contributes space-switch and music command descriptors because that role has no projection; a music descriptor names the tab it acts on as `tabId`, so the frame can run it without knowing the window's tabs.
`search-result` carries request ID, revision and `SharedSearchResult` (`command`, `item` or `navigate`); `search-error` is correlated too.
Query and result focus are local; activating a result submits a normal intent resolved against current entities.
A stale result alone cannot mutate the model.
A view keys answers by query, not revision: a revision asks again without discarding the answer in flight, the newest request's answer wins, Enter waits for the typed query's answer, and a pick does not wait for `recordSearchSelection` to settle.
`recordSearchSelection` validates query/result IDs, serializes persistence at `hyperSearchSelectionHistory`, and reconciles before ranking changes.
`forgetSearchSelection` removes one result ID under every query through the same serialized path, so it leaves the recent list and stops lifting ranking.
A pick lifts a result for a similar query (`entrypoints/lib/searchSelection.ts`); a pick under a dissimilar query counts only within `RECENT_SELECTION_WINDOW_MS` (30 days).
Selection history is capped at 100 queries and 20 result IDs per query; the payload parser bounds queries to 512 and result IDs to 1024 characters.
`tabContentController` invalidates captured page text on navigation and filters by URL/version; old-page text cannot leak into a new page's results.
