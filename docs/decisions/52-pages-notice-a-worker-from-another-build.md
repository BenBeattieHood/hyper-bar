# 52. Pages notice a worker from another build

**Decision.** Every build stamps one build id into the background worker and its pages alike, and a page that hears another build's id, or none, shows a "Hyper was updated." notice whose Reload Hyper button calls `runtime.reload()`.
The connection carries on meanwhile.
How each page reacts is in [model §4](../model/04-store-and-transport.md).

**Why.** For an unpacked extension the browser reads each page from disk as it opens, but keeps starting the worker script it registered until the extension reloads, so a rebuild leaves newer pages talking to an older worker.
An older worker treats an intent kind it has never heard of, such as `setSpaceArchived`, as a protocol violation and cuts the page off, so the user's choice silently does nothing.
Only the page can tell, because a worker cannot know what a newer build's intents look like.
A build id changes with every build, so nobody has to remember to bump a protocol version.
The notice renders beside the app's error boundary rather than inside it, because a projection from another build is also what is most likely to break the app, and the boundary's Reload reloads only the page.

**Cost.** The notice shows on every page opened after a rebuild until Hyper reloads, even when the older worker would have understood every intent.
Reloading closes Hyper's tabs and the side panel.
Web pages keep the content scripts they had before the reload, so page Search and the in-page sidebar come back to a page only once it reloads.
Playwright's Chromium disables an unpacked extension that reloads while developer mode is off, so end-to-end tests turn developer mode on before they reload Hyper.
