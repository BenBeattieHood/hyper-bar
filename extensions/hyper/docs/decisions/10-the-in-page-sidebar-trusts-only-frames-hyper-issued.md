# 10. The in-page sidebar trusts only frames Hyper issued

**Decision.** Hyper's content script asks the background for a token for its tab, and `inpage.html` connects to the model only with that token in its URL (`inPageSidebarController.ts`).
Tokens persist in `storage.session` so a woken worker still recognises frames it issued.
The background answers pages only after its first model read.
The frame's width reaches the background only through the content script, which reports it when a resize ends.
The full contract is in [build-spec §21.2](../build-spec/21-search-new-tab-and-page-overlay.md).

**Why.** Any website can frame an extension page that is web-accessible, so a frame without a token could otherwise read the user's tabs and bookmarks.
A woken worker starts from the seed model with default preferences, so answering before the first read would tell every page that the in-page sidebar is off.
The resize travels over the content script's own message channel rather than from inside the frame, because a page can post messages into the frame but not send runtime messages as the extension.

**Cost.** A page that asks while the worker wakes waits for the first model read before it learns whether to show the in-page sidebar.
