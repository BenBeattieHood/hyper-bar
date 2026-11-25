# 32. A restored tab takes back its own backing

**Decision.** When the worker starts, before any tab is routed, Hyper pairs every tab that holds no backing with a backing no tab holds, one to one.
It pairs by page, then site, then tab position, as [build-spec §11](../build-spec/11-startup-restoration-and-race-control.md) specifies.
Each pair is recorded as the tab's ownership, with a parked backing moved to the tab's window, so routing then keeps that backing and moves it to the tab's current address.

**Why.** Chromium browsers keep tab ownership only in session storage, which a browser restart clears, so startup had to find each tab's backing by its page.
The browser saves a tab's address before its redirects and in-page navigations settle, while the backing follows every navigation, so a restored tab can come back at an earlier address than its backing recorded.
Routing tab by tab gave such a tab a new backing, and space restoration then reopened the old, unclaimed backing as a second tab.
Each restart could add more, which is how sign-in pages, wikis and chat apps multiplied.
Pairing all tabs at once keeps the bookmarks the durable record and the background model the only authority: the browser's restored tabs are input, and each one is matched to the backing it most likely is.

**Cost.** A tab on another site at the same position in the same window takes over a backing it may not be, and that backing's address is replaced by the tab's.
The alternative, a duplicate tab, is worse, and the tab's page is kept either way.
A closed window's backing is never taken by position alone, so a parked tab is not lost to an unrelated one.
