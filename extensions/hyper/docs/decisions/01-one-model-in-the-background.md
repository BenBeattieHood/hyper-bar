# 1. One model, in the background

**Decision.** The background service worker holds the only application model, a Jotai vanilla store rebuilt from browser APIs and the bookmark tree on every worker start.
The sidebar, new tab page, in-page sidebar, and page Search receive read-only projections over a port and send typed intents back.

**Why.** Each extension page is a separate JavaScript context.
When views kept their own copies of browser state, they disagreed with each other and with the browser, and a change made in one view raced a change observed in another.
One model means one answer to "what is true now", and an intent handler is the only place that can change it.

**Cost.** Every view action is asynchronous and goes through the port.
Views cover the gap with optimistic overlays held against the command that carries them (`modelOverlay.ts`); an overlay is never written into the model.
