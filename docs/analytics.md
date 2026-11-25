# Analytics proposal

This is a proposal: Hyper collects no analytics today, and no bookmark, tab, history, or page-content data leaves the browser.
Most measures below could be computed from the intents that already pass through the model layer (modelIntents, commandBar, bookmarkOperations, etc.).

Activation (is it adopted?)
- Time to first meaningful action: time from install to the first tab move, folder created, or command-bar use.
- Setup completion rate: the share of new users who import bookmarks, create a space, and pin the sidebar.

Engagement (is it used?)
- Daily and weekly active users, and their ratio: this ratio is the best single signal of whether Hyper has become a habit.
- Command bar opens per active hour, plus the share of opens that end in an action rather than being dismissed.
- Sidebar interactions per session: clicks, drags, and folder expand/collapse.
- Share of tab switches done through Hyper vs. the browser's own tab strip: this shows whether Hyper is replacing the native UI.
- In-page sidebar: how often a hover on the mark leads to a click, how long the sidebar stays open before a click elsewhere hides it, and how often it is resized.

Efficiency (does it help?)
- Command bar time to action: time from opening to running a command (median and 95th percentile).
- Search success rate: the share of queries where the user picks a result without changing the query.
- Open tab count over time: a falling count suggests users are relying on bookmarks and spaces instead of hoarding tabs.
- Duplicate tabs prevented, counted by duplicateController.

Reliability (does it work?)
- Model integrity failures and reconciler corrections: modelIntegrity / modelReconciler corrections per 1,000 intents.
- Recovery events: journal replays from operationJournal and backingCleanupJournal.
- Intent error rate and latency: time from an intent being sent to the UI showing the change.
- Background restarts / service-worker wakeups, and the time until the sidebar is usable again.

Retention (does it stick?)
- Retention at day 1, day 7, and day 30.
- Uninstall rate: set an uninstall URL with chrome.runtime.setUninstallURL to collect exit feedback.
- Feature retention: the share of users still using spaces or the command bar after 2 weeks.

How to implement:
1. Emit lightweight events from the model's intent dispatch, since it's a single choke point and needs little instrumentation.
2. Aggregate counts locally, then batch-send anonymised counters rather than raw URLs or titles.
3. Make collection opt-in and declare it in the privacy policy.
   The Chrome Web Store and Firefox add-on (AMO) policies require this for any data that leaves the device.
4. Show a local dev dashboard (Hyper has no debug view yet; a development-only Settings panel would do) so you can see the metrics live during development without any backend.
5. If you only track three, choose the daily/weekly active ratio, the command bar's open-to-action rate, and the share of tab switches through Hyper.
   Together they show whether Hyper has replaced the browser's native tab handling.