# 33. A tab keeps the last title its page gave it

**Decision.** A tab backing's visible title is the tab's last known page title.
When the browser reports only a placeholder for the same page, Hyper keeps the stored title instead of writing the placeholder over it.
What counts as a placeholder, and where else the rule applies, is in [build-spec §14](../build-spec/14-tab-naming.md).
The rule lives once, in `tabPageTitle`.
The background model derives each tab's title and page title with it, and every surface reads those projections rather than recomputing from raw tabs.
The backing write path applies the same rule to fresh reads.

**Why.** Without this, a tab that failed to load once, for example while offline, showed only its domain in the sidebar from then on, and plain bookmarks for that page were renamed to the domain too.
The backing title is already the one place every surface reads a tab's name from, so keeping it accurate fixes the tab rows, Search and Favourites at once.
A separate `lastKnownTitle` field would duplicate that title and need every surface to choose between the two.

**Cost.** A page that really is titled with its own host or address is treated as untitled, so on the same page Hyper keeps showing its previous title.
