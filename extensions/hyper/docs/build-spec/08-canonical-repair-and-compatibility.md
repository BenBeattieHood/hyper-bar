# 8. Canonical Repair and Compatibility

`ensureHyperBookmarkStructure()` is idempotent, restartable, and conservative:

1. Locate the bookmark bar without relying on one localized title.
2. Find/create and merge duplicate canonical `hyper`, `favourites`, and `spaces` folders without dropping children.
   `repairHyperBookmarkStructure()` in `bookmarkStorage.ts` also ensures `hyper/bookmarks` (`BOOKMARKS_FOLDER_TITLE`), the global bookmarks folder ([decision 28](../decisions/28-the-favourites-bar-fills-itself-and-leads-to-global-bookmarks.md)).
3. Ensure at least one space exists.
4. Ensure one marked `tabs` root and one marked `bookmarks` root per space.
5. Adopt a direct plain `bookmarks` folder in place and mark it.
   Do not move other direct visible children into it.
6. Preserve every other record, including hidden backings outside a marked `tabs` root, per-window folders, and foreign-installation, unidentified, unmarked, and ambiguous nodes.
7. After moving a known child snapshot, re-read a source and remove it only when currently empty and only non-recursively.
8. Remove empty JSON metadata suffixes only within the Hyper hierarchy.

Repair stamps no schema version.
It creates missing structure and merges exact duplicate canonical folders; every other reshaping is a manual user task, with one exception: a favourite whose slot no longer exists, since the bar keeps seven, moves into `hyper/bookmarks`, the global bookmarks folder.
