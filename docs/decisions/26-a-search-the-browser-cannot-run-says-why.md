# 26. A search the browser cannot run says why

**Decision.** When the browser has no default search engine, Chromium's search API rejects with "Missing default search provider."
`searchWithDefaultEngine` (`browserSearch.ts`) rethrows that as a `CommandFailureError` naming `unsupported`, the intent lane settles the command with the reason a handler names, and `submitSettledIntent` hands it to the caller.
New-tab and page Search wait for their search to settle, and on `unsupported` say that the browser has no default search engine, naming Edge when running in Edge.
The notice links to the browser's search settings (`searchEngineSettings`: `edge://settings/search` in Edge, `chrome://settings/search` elsewhere), opened through `navigateTab`.
The notices sit above the brand mark, where the open results list cannot cover them.

**Why.** Waiting only for the search to be accepted would make a browser left without an engine look like Hyper ignoring Enter.
Naming the reason in the lane lets the page say exactly what is wrong without guessing from any failure.

**Cost.** The message depends on Chromium's error text; if it changes, the search fails with the generic "That search could not be run."
The sidebar's search in a new tab shows only its generic message.
