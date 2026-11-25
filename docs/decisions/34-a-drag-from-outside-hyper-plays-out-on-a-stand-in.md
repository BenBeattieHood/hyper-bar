# 34. A drag from outside Hyper plays out on a stand-in

**Decision.** Links, addresses and files dragged into the sidebar from a page, another app, the desktop, or the browser's own bookmarks and tabs go through the same dnd-kit drag as a row.
When such a drag enters, `useExternalDrag` starts a hidden stand-in draggable carrying an `external` drag item, as decision 19 does for a drag from another window.
Every existing drop target, collision rule, indicator and overlay badge then serves it unchanged.
Its contents are copied in the native `drop` event and turned into pages, which go through the same `createBookmark {page}` and `openBookmark` intents paste uses (decision 27), by way of the shared `carryOutPagePlan`.
Shortcut files (`.url`, `.webloc`, `.inetloc`, `.desktop`, `.lnk`) are parsed in the view for the page they point at.
Any other dropped file is named in a notice rather than linked.

**Why.** A separate drop path for outside drags would duplicate the tree projection, favourite slots and view switching that row drags already have, and would drift from them.
The browser protects a drag's data until it drops, so the only thing knowable while hovering is how many files it holds; reading at the drop is the only option, and the stand-in needs no data until then.
Treating the drop as a list of pages, exactly as paste does, keeps the background's validation in one place: it accepts only `http:`, `https:` and `file:` pages, strips metadata-looking titles, and skips pages the folder already holds.
Chromium never exposes a dropped file's path to web content, so a file cannot become a `file:` link.
A shortcut file's contents can be read, and they say where it points, so shortcuts are the one kind of file that can be linked.

**Cost.** The overlay cannot show the dragged page's favicon or title while hovering, only a globe or file icon.
Dropping on a tab row opens the pages at the end of the space, as a dropped bookmark does, because `openBookmark` cannot place a tab in the tab tree.
A `.lnk` to a folder or program becomes a `file:` page the browser may refuse to open.
Arbitrary files need a detour: open the file in a tab, then drag the tab.
