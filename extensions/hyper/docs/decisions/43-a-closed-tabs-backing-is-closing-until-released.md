# 43. A closed tab's backing is closing until it is released

**Decision.** A tab's backing counts as closing from the moment `tabs.onRemoved` reports the tab until its queued release has run, and no restore opens a tab for a closing backing.
`tabBackingSync` records the removal synchronously, before the release joins the group mutation lane, and `createSpaceTabRestore` checks the record just before it creates each tab.
A space switch that waits for the browser to bring back a missing space group waits only while some backing in the window is not closing, and it checks again on every poll.
A tab removed because its window closed is not recorded, because that window's backings stay so they can be restored as parked tabs.
The failed-removal journal is not consulted, so Undo of Close all can still reopen a tab whose backing could not be removed.
`backingClaimedByAnotherLiveTab` ignores the record, because the release itself uses it to decide whether to remove the backing.

**Why.** Tab and group mutations share one lane, so a closed tab's release can wait behind a restore that is already running, such as a new window showing its space.
That restore saw the backing with no live tab claiming it and opened the tab again, and the release then found the backing claimed and kept it.
A tab the user had just closed came back.
The same backing also made a window that newly showed the space wait five seconds for a group the browser was never going to restore, because the closed tab had been the last one in it.
Every tab and group mutation queued behind that wait, so clicks and the release itself stalled.

**Cost.** Only tab creation and the group wait check the record, so a tab that is already open in the space's group without an owner can still adopt a closing backing by its page.
Every path that reopens tabs from backings must go through `createSpaceTabRestore`, or it brings the race back.
