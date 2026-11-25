# 7. `storage.session` is a cache

**Decision.** Hyper keeps in `storage.session` only values it can rebuild from the bookmarks and the open browser, or lose without harm, such as tab ownership, each window's active space, the group ID of each space in each window, and in-page sidebar tokens.
The full list of keys is in [build-spec §7](../build-spec/07-local-session-and-in-memory-state.md).

**Why.** These values are keyed by tab, window, and group IDs that last only for one browser session, so they cannot be durable.
`storage.session` is wiped whenever the extension reloads, updates, or is disabled, and Chromium has no `sessions.setTabValue`, so nothing in it may be the only copy of anything.

**Cost.** After an extension-only restart, Hyper has to re-derive tab ownership from the bookmarks (decision 8).
