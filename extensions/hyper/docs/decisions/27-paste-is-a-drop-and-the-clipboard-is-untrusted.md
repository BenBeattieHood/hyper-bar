# 27. Paste is a drop, and the clipboard is untrusted

**Decision.** Row context menus, tree keys, and the clipboard act through the same code as dragging.
The drop body lives in `sidepanel/lib/dropActions.ts`, and a paste on a folder builds the same `DropRequest` a drop on that folder's middle would (`planPaste` in `clipboardItems.ts`), with a copy treated as a drop holding the copy modifier.
Move to space and Remove are drops on a space dot and on the bin.
Cut and Copy write four formats from one copy event: plain text holding only the addresses, a URI list, titled HTML links, and Hyper's own JSON with titles, addresses, metadata and folders' contents.
A paste trusts that JSON's IDs only when its installation ID is this installation's and each named row is still here with the same address; a tab must also be in this window.
Everything else, including plain text, pastes as new pages, and a pasted title is stripped of anything that looks like Hyper's metadata.
Paste reads through `execCommand('paste')`, which needs `clipboardRead`.

**Why.** A second implementation of each drop would drift from the first, and "paste does what a drop there does" is easy to predict.
Any page can write the clipboard, so trusting its IDs would let a page move or delete bookmarks.

**Cost.** Adding `clipboardRead` makes the browser ask for the new permission on update.
A cut is only a mark: if the copied rows change before the paste, it pastes copies instead.
A copied bookmark folder cannot be pasted on a bookmark folder: `planPaste` refuses it with "Folders can be cut and pasted, but not copied".
Copied tabs and plain addresses open as tabs in the space rather than inside the tab folder they were pasted on, since `openBookmark` cannot place a tab in the tree.
