# 58. Closing tabs in Hyper can be undone

**Decision.** Every `closeTabs` of this window's tabs offers an Undo timed message ([build-spec §27](../build-spec/27-timed-messages.md)), as closing a space's tabs from its menu already did, and both share `closedTabsUndo.ts`.
Before the tabs close it records each of their spaces' tab trees; Undo makes the closed backings again with `rebuildTabTree` and reopens them with the space tab restore.
A folder's close sends the folder's title in the same intent as `folderTitle`, so the message says "Closed folder" once rather than counting tabs.

**Why.** A stray click on a row's or folder's X lost the tab's place, name and bookmark link, which the browser's Reopen closed tab does not bring back.
An autofolder exists only in the view, so the worker cannot tell from tab IDs that a folder was closed; the view says so as part of the one choice.

**Cost.** Undo reopens a tab at its page, without its back and forward history.
The folder title is display text the view supplies, and the worker trusts it only for the message.
