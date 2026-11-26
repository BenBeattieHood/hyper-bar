# 20. A reinstall keeps the tabs it backed

**Decision.** When Hyper finds no installation ID in `storage.local`, it keeps the ID of the installation whose backings name the most of the browser's open windows.
If none does, it starts a new installation, and a space that opens adopts the parked backings of the installation this one replaced.
The exact rules are in [build-spec §7](../build-spec/07-local-session-and-in-memory-state.md) (`installationId` and `parkedTabBackings` in `bookmarkStorage.ts`).

**Why.** Removing an extension deletes its `storage.local`, but the bookmarks stay.
A Hyper that was removed and loaded again therefore saw its own backings as another device's (decision 4).
It recreated backings for the tabs that were open, but left every parked tab, including the tabs of spaces whose collapsed groups the browser had not restored, waiting for an installation that no longer existed.
Their spaces opened empty.
Window IDs belong to one browser, so backings that name its open windows prove the same installation.
Otherwise, an installation whose last backing predates this one's start has stopped adding tabs, while another device in use keeps adding them.

**Cost.**
- A device that has not opened a tab since this installation started looks like the installation it replaced, so its parked tabs move to whichever device opens their space first.
- A tab the replaced installation still recorded under a closed window, which it had not yet parked, is not adopted.
- Only the most recent replaced installation is followed.
  Tabs left by earlier ones stay in the bookmarks unrestored.
