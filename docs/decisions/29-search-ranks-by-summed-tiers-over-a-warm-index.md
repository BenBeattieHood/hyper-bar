# 29. Search ranks by summed tiers over a warm index

**Decision.** A Search result scores the sum of every tier it matches, and each tier is worth 1.5 times the one below.
The tiers are a recent pick for a similar query, commands, titles, history, URL matches and containing-folder matches.
Quality within a tier moves a result by at most 30% of that tier, so it never passes a whole tier, while several lower tiers together can.
A pick for a dissimilar query is only a nudge at the lowest tier's weight with no floor, so a faint, stale pick cannot outrank fresher and better matches.
Queries are similar when one, trimmed and lowercased, equals or begins the other.
The background keeps one prefix and one tolerant FlexSearch index warm (`SharedSearchIndex` in `searchIndex.ts`), syncs them to each request's records, and ranks only hits among those records.
Partial matches are not results: an index hit must hold every word of the query, and a URL matches only when the query runs unbroken through it or each of its words begins a word of it, so there is no tier for letters scattered over a URL.
The tiers in full, and what an empty query shows, are in [build-spec §21](../build-spec/21-search-new-tab-and-page-overlay.md).
What a containing folder matches, and how a keystroke avoids repeated work, is [decision 47](47-search-matches-containing-folders-and-normalises-each-record-once.md).

**Why.** Fixed tiers with a bounded promotion could not express a result that is strong in several ways at once.
A gentle exponential keeps the stated order for single matches while letting real multi-way matches rise.
Building the indexes for a full history takes a few hundred milliseconds, while syncing warm ones costs a few milliseconds a keystroke (`npm run bench:search`).
Filtering hits to the request's records keeps the rule that a request answers only from its own revision and window.

**Cost.** The index holds text for records that may have left, until the next request removes them.
A query typed without its spaces, such as `githubnetba`, no longer finds `github.com/netbank` by its URL.
Tier weights are tuned by hand, and the tests pin the order they produce.
