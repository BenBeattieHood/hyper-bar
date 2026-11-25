# 21. Other sessions' tabs show on request and move as backings

**Decision.** Each installation of Hyper is a session, named by the installation ID on the backings it keeps.
Hyper restores and reconciles only its own backings, and adopts another's only when they are the parked backings of the installation it replaced (decisions 4 and 20).
With the `showOtherSessions` preference, the tab list goes on below the window's tabs with a section for each other session, derived in the view from the projected bookmark tree and this installation's projected `installationId`.
A drop between sessions is one `moveSessionTab` intent, which moves a tab's backing or, with a copy modifier, copies it (`sessionTabs.ts`).
The full contract is [build-spec §20.2](../build-spec/20-drag-and-drop-contract.md).
Decision 48 extends this entry: session tabs can also be selected, cut, copied, pasted, closed, and dropped in the bookmarks or on the bin.

**Why.** Apart from a replaced installation's parked backings, Hyper never reopens another installation's tabs, so the tabs another device or an older installation kept could not be reached.
A backing is what a session keeps, so handing one over is the move.
A running session opens a parked backing when it next opens the space, as it does its own parked tabs.
Hiding other sessions until asked keeps the tab list to this window's tabs.

**Cost.**
- Installations record nothing about their device, so a session is labelled only by when it last kept a new tab.
- A device still running keeps a tab taken from it open, under a new backing of its own, so taking a tab from a live device acts as a copy there.
- The switch is a synced preference, so it shows other sessions on every device at once.
- Backings without an installation ID form one session that tabs can leave but not join.
