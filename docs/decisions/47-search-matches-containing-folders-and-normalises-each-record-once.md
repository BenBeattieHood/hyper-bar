# 47. Search matches containing folders and normalises each record once

**Decision.** The folders holding a bookmark, folder or tab count toward its match, in their own tier below title, history and contiguous URL.
`SearchItem.folders` lists them outermost first: a bookmark's folder path within its space, and the named tab folders around a tab.
A space's name only helps complete a query; alone it would match everything in the space, so it never earns the tier.
The folder rule is in [build-spec §21](../build-spec/21-search-new-tab-and-page-overlay.md).

Search keeps its per-keystroke work proportional to change.
`searchText.ts` lowercases and folds each record's text once, cached per record object, and each query once as a `SearchTerm`.
The controller interns each window's projected records, so a new model revision reuses every record object that did not change, and with it the cached text, scores and index entries.
When Search opens with nothing typed, the controller fills its text index in idle batches, so the first keystroke does not pay for the first build.
The caches and batches are described in [model §8](../model/08-search.md), and `npm run bench:search` measures the background half of a keystroke on a large generated profile.

**Why.** Users file pages in folders and remember the folder as part of the page's name, so "metrics dashboard" should find the Dashboard filed in Metrics.
Keeping folder matches in their own tier keeps a direct title match first.
Every keystroke ranks every record, so normalising each record's text and URLs afresh would repeat the same work on each one; caching it leaves only what changed.
On the bench's profile of about 7,000 records, a keystroke costs a few milliseconds and the first query after opening under 10 ms.

**Cost.** Interning compares each projected record with the last one on every revision.
The caches live as long as their records or the worker, and the URL memo is cleared when it fills.
A query typed before the idle batches finish still builds the rest of the index on that keystroke.
