# 14. Tab Naming

The exact backing is durable title authority for a backed live tab.

- Render the backing's visible title when available; fall back to browser title/URL.
- The backing keeps the last title the page gave itself.
  A browser placeholder for the same page never replaces it, nor the titles of bookmarks following that page, nor history titles in Search ([decision 33](../decisions/33-a-tab-keeps-the-last-title-its-page-gave-it.md)).
  A placeholder is a blank title, the page address with or without its scheme, `www.` or query, or the bare host, shown while the page loads, sleeps or fails to load.
  A name Hyper applied is not a page title either.
  On a different page a placeholder is stored as usual; `tabPageTitle` holds the rule once.
- A title-area slow double click starts rename only when the interval is strictly greater than 200ms and strictly less than 800ms.
- The title hit area is the whole title, not a fractional left region.
- Rename only the exact owned `backingId`; preserve metadata and set `isCustomName: true`.
- Serialize rename with backing lifecycle work and reject missing/stale ownership explicitly.
- Do not fall back to URL matching.
- Best-effort update `document.title` using already available script capability/permission.
  Durable rename succeeds even when page mutation is unsupported.
- Queue non-custom page-title updates in the background while panels are closed; the throttle is in [model §4](../model/04-store-and-transport.md).

A tab can remember a visible bookmark in its own space, Favourites, or global bookmarks, matched in that order (`indexLinkableBookmarks()` in `tabBookmarkLink.ts`).
Prefer an existing linked ID while the tab stays on that bookmark's domain; otherwise infer an exact normalized-navigation match, except a previously declined ID.
A link has `drifted` once the tab leaves the bookmark's exact page.
A named linked bookmark wins the tab display name, adding `*` while the tab drifts to another page on that domain; otherwise the tab's own user-given name shows while the tab stays on that name's domain.
A tab Hyper opens onto a bookmark's page takes that bookmark from tabs that drifted from it.
A bookmark made from a named tab, wherever it is dropped, takes the name the tab shows, whether the user gave it to the tab or to its linked bookmark.
The background keeps the browser's tab strip showing the same names.
Renaming a linked tab updates the bookmark too; unlinking records `declinedBookmarkId` on the backing.
When navigation independently arrives at a bookmark, show a "Linked to bookmark" timed message whose cross button unlinks the tab ([§27](27-timed-messages.md) case b).
Page-title synchronization follows only non-custom bookmark names.
