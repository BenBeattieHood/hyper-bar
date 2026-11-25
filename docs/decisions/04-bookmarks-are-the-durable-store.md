# 4. Bookmarks are the durable store

**Decision.** Everything the user would expect to keep lives in the browser's bookmarks under `hyper/`: spaces and their order, every open tab's backing record, tab folders, favourites and their slots, custom names, and preferences.
Hidden metadata rides at the end of a bookmark title as a JSON object after whitespace; the UI hides and preserves it.

**Why.** Bookmarks already sync, export, and survive reinstalling the extension.
That gives Hyper durable, portable state with no account or backend.
Keeping metadata in titles rather than in a side store means the data can never drift from the bookmark it describes, because they are one record.

**Cost.** Titles carry visible JSON in the browser's native bookmark manager, and every metadata write is a bookmark change that syncs.
A tab backing records an `installationId` so that one synced installation never deletes another's records.
