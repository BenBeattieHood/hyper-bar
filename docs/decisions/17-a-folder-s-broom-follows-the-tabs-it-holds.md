# 17. A folder's broom follows the tabs it holds

**Decision.** Every tab folder and autofolder that holds the same page more than once, counting its subfolders, shows a broom button that closes the extra copies.
`duplicateTabIdsByFolder` (`sidepanel/lib/tabFolders.ts`) derives this on each render from the tabs and tree in the current projection.
A copy Hyper permits (Duplicate, a ctrl/cmd or middle click, Open link in new tab, a link from another app, a forced-new open) is only spared automatic dedupe; the broom counts it like any other.
Nothing records which copies the user wanted.
The broom matches copies by `normaliseUrl`, which keeps the query, as automatic dedupe does.

**Why.** Automatic dedupe already removes the copies Hyper does not permit, so nearly every duplicate a user sees is a permitted one.
A broom that ignored permitted copies, whether by a mark on the backing or only while a copy matched its original, would rarely appear, and a mark that is never cleared keeps a copy exempt long after the reason for it has passed.
Permitting a copy means Hyper does not close it unasked; the broom is the user asking, and the easiest way to consolidate.
Matching by `pageIdentity` drops the query, so two frames of one Figma file (`?node-id=1`, `?node-id=2`) would draw a broom as though they were one page.

**Cost.** Sweeping a folder also closes copies the user kept on purpose; the timed message is the only way to act on one copy alone.
