# 13. Opening, Reuse, and Deduplication

## 13.1 Visible bookmark activation

Normal activation opens into the bookmark's intended destination:

- sidebar bookmark Search result: its owning space;
- bookmark row in the active pane: active space.

`openTabInSpace()` (`ownedTabActions.ts`) looks for a tab in that exact space whose `normaliseUrl()` matches, through `findReusableTab()` in `tabs.ts`, preferring an active match, then one not discarded.
The `openBookmark` payload's reuse scope decides where it looks: `'window'` (the default in `parseOpenBookmarkPayload`) searches only the requesting window, and `'browser'`, which the sidebar always sends, searches all same-context windows.
If found, set that target window's active-space preference, focus its window, and activate the exact tab.
Otherwise create in the current/requested window, assign the destination space, and create an exact backing.

This owner-space rule applies to the sidebar's `openBookmark` intent.
New-tab and page-overlay Search submit `navigateTab` for URL results, navigating their source tab instead; they do not issue `openBookmark`.
New-tab Search can focus an already-open local tab with `activateTab`, which disposes the replaced new-tab page.
Page Search may only activate local tabs.
A ctrl/cmd or middle click on any result with a page, including a typed address or a web search, opens it in a new tab instead and leaves the Search page where it is.
The sidebar forces a new tab in the destination space; new-tab and page Search send `navigateTab` with `newTab`.

`Alt` activation bypasses reuse and creates another tab in the destination.

## 13.2 Favourite activation

Normal click sends `openFavourite`, and `openFavourite()` in `bookmarkOperations.ts` picks the destination with `preferredSpaceForPage()` in `bookmarks.ts`, matching by `pageIdentity()`:

1. the current space, if it has a tab open on the page;
2. otherwise the leftmost shown space that has;
3. otherwise the current space.

It then opens with `reuse: 'browser'`, so a tab of that space with the same `normaliseUrl()` in any same-context window is focused, and otherwise a new one is created there.

`Alt` forces a new current-space copy.

## 13.3 Tab activation

- Normal click focuses the exact tab.
- `Alt`-click duplicates the exact tab into the same space.
- Middle click or Close closes the exact tab.
- Closing several selected tabs may run independent closes concurrently, but each reports success only after confirming disappearance.

## 13.4 Ordinary navigation deduplication

When one existing tab navigates to an already-open strict normalized URL in its current space and window, background logic may focus the existing target and restore the source's previous navigation.
Guard with source generation, prior URL/backing, same-context ownership, target ownership, and final source/target URL checks.
Focus the destination before restoring the source.
A focused, opener-linked new tab that a page opened for itself is deduped the same way.

Such a duplicate was very probably accidental, so deduplication is an opt-out follow-up ([§27](27-timed-messages.md) case b).
Show a "Deduplicated tab" timed message in that window's header with a cross button.
The cross cancels deduplication: it lets the source tab make the navigation it was taken back from.
A source tab that was closed instead opens again at its old index in its window, as a tab Hyper opened.
The tab the user kept is not deduped again, nor offered "Deduplicate?", until it shows another page.
`navigationDedupe.ts` owns the offer and the kept pages.

## 13.5 Allowed duplicates

A copy the user asked for is kept: native Duplicate (or `Alt`-click; in Firefox, copied ownership whose backing another live tab claims), a link opened in the background with ctrl/cmd or middle click or Open link in new tab, a link from outside the browser (no opener, including Safe Links wrappers), a forced-new open, and a ctrl/cmd or middle click on a Search result.
When it shares a strict normalized URL with an older tab in the same space and window, the copy may be deliberate, so deduplication is an opt-in follow-up ([§27](27-timed-messages.md) case a): show a "Deduplicate?" timed message in that window's header; its tick button closes the copy and focuses its original.
Nothing is written to the copy's backing.
Every tab folder and autofolder that holds the same strict normalized URL more than once, counting subfolders, shows a broom button that closes the extra copies (kept ones included), keeping the active copy or else the first; derive it on each render from the tabs the folder holds (`duplicateTabIdsByFolder` in `sidepanel/lib/tabFolders.ts`), never from remembered events.
Both match by `normaliseUrl` (`urlIdentity.ts`), so a different query is a different page.
A new tab stays a candidate only through its first load and that load's redirects: a failed load counts as one, and the next commit that is not a redirect is the user's own navigation.

`duplicateController.ts` bounds the first-load redirect candidate to ten seconds (`CANDIDATE_MS`) and waits up to 500 ms for a navigation commit.
Treat `https://teams.public.onecdn.static.microsoft/evergreen-assets/safelinks/2/atp-safelinks.html` as a redirect wrapper, not a fresh user navigation.
Browser APIs give no native duplicate reason, and `openerTabId` also occurs for ordinary links; page `sessionStorage` and `window.name` are not detection mechanisms either.
Chromium's Duplicate names the active tab as opener, like a page's link, and copies no ownership, since ownership is kept in `storage.session` by tab ID; tell it apart by the page its `url` already shows at creation, where a link's is empty (`newTabOrigin` in `tabNavigationIngress.ts`).

## 13.6 A page already open in another space

When the user opens a page that a tab in another space already shows, the page opens as asked, because the user may want it in this space too.
Hyper then offers the other tab as an opt-in follow-up ([§27](27-timed-messages.md) case a): "Already open in [space].
Switch instead?", with a tick, in the window the user opened it in, lasting while the user's tab stays in that window.
It covers a tab navigated by a link, the address bar or new-tab and page Search, and a new tab a link, the address bar or another app opened.

- Pages match by strict normalized URL, as same-space dedupe does (§9): the fragment and a trailing slash are ignored, the query is not.
- Only web and file pages count; browser, extension and new tab pages never do.
- Same-space duplicates stay with §13.4 and §13.5.
  If the user's own space shows the page in any window, nothing is offered, and a "Deduplicate?" offer for the same navigation wins.
- The other tab may be in any window of the same browsing context; one in the user's window wins, then one its window shows, then the oldest.
- Nothing is offered for a reload or fragment change, for the first page of a tab Hyper opened, restored or duplicated, or for a navigation Hyper made to send a tab back.

The tick acts on the exact tabs it named.
If the other tab has left the page or its space, it fails with "That page is no longer open in [space]." and touches nothing.
Otherwise the window that tab is in switches to its space, as a sidebar tab click does, the tab is activated and its window focused, and then the user's tab is restored silently: closed if the page opened it as a new tab (including one left on the new tab page), otherwise sent back in history.
A user's tab that has meanwhile left the page is left alone.
Hyper's back navigation is neither deduped nor offered again.
Expiry or a newer message does nothing.
`crossSpaceDuplicates.ts` owns the offer; `tabNavigationIngress.ts` calls it after routing each navigation.
