# 9. URL, Page, and Navigation Identity

Do not use one over-broad equality helper.

## 9.1 Normalized navigation URL

`normaliseUrl()`:

- removes fragments;
- removes non-root trailing slashes for HTTP(S);
- preserves query strings;
- preserves protocol, host, path, and other parseable URL components.
- returns trimmed input for an unparseable, nonempty URL; empty input is null.

Use this stricter identity for actual tab reuse, navigation deduplication, the kept copies, and a folder's broom, where distinct query state may represent a distinct live destination.
The kept copies are the `kept` map in `createNavigationDedupe()` (`navigationDedupe.ts`): the page each tab may stay on as a duplicate after the user cancelled its dedupe, until it shows another page.

## 9.2 Page identity

`pageIdentity()` starts with `normaliseUrl()` and normally removes HTTP(S) query strings for bookmark/open-state equivalence.
Preserve the query for query-driven pages where the query is the content identity:

- Google `/search` URLs across supported Google country domains;
- GitHub `/search`;
- GitHub `/<owner>/<repo>/issues`;
- GitHub `/<owner>/<repo>/pulls`.

This means Google searches for different terms and filtered GitHub issue/PR lists are different pages.
Use this helper for visible-bookmark equivalence, indicators, and Search aggregation, not for deciding which tabs are copies of each other.

## 9.3 Exact current navigation

Where a bookmark-sync action asks whether a tab is still on the exact saved navigation, use `sameNavigationUrl()` in `tabs.ts`.
It compares the browser-normalised `URL.href` of both addresses, query and fragment included, and falls back to string equality when either does not parse.
`tabBookmarkLink.ts` uses it to mark a linked bookmark as drifted, and `tabNavigationIngress.ts` to match navigations.
Do not conflate exact navigation, page identity, and backing identity.
