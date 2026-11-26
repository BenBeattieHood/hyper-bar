# 22. Optional Page Content and Privacy

- Feature starts off; the `pageTextSearch` preference turns it on and off.
- Read page text through Hyper's own HTTP(S) content script, asking the tab's top frame by message, so the feature needs no permission of its own ([decision 56](../decisions/56-page-text-is-read-by-hyper-s-page-script.md)).
- The page script answers once the document has been parsed.
- A tab whose page script does not answer, such as one opened before Hyper loaded, is asked again when its load status changes.
- Capture eligible open-page title, headings, and body text up to 30,000 characters.
- Bind each snapshot to tab ID, exact pending/current URL, and navigation version.
- Keep text in memory only.
- Invalidate on navigation, reload, close, capture failure, or disable.
- Disabling clears snapshots.
- Skip restricted/internal pages.

Hyper adds no app-controlled upload of bookmarks, tabs, history, queries or page text.
Browser bookmark sync may carry the durable tree and preferences.
