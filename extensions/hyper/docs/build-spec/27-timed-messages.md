# 27. Timed Messages

A timed message lets Hyper act on a best guess while still giving the user a moment to choose differently.
It shows a short message beside a single button wrapped in a shrinking countdown ring.
When the ring empties, the message and its button disappear and the best guess stands.

## 27.1 When to show one

Every timed message serves exactly one of these cases, and its button icon names the case.
Each case is a `TimedMessageKind` in `entrypoints/lib/timedMessages.ts`.

| Case | Hyper has | The button lets the user | Icon |
| --- | --- | --- | --- |
| a) Opt in (`opt-in`) | offered a helpful follow-up that the user may not want, without applying it | apply the follow-up | Tick |
| b) Opt out (`opt-out`) | applied a helpful follow-up that the user very probably wants | cancel the follow-up | Cross |
| c) Undo (`undo`) | made a change, such as a move or delete, that cannot otherwise be reversed easily | undo the change | Undo |
| d) Feedback (`feedback`) | reported an error or other feedback | copy the message text to the clipboard | Copy |

Choose between a) and b) by how sure Hyper is that the user wants the follow-up.
When the user's own action suggests they may have meant the result, offer the follow-up (a).
When the result was very probably accidental, apply the follow-up and let them cancel it (b).

## 27.2 Rules

- The message says what Hyper did or is offering, and the button's accessible label says what clicking does.
- The ring shows the case's icon at all times, not only on hover.
- Expiry only closes the choice; it never applies anything.
  A case a) follow-up that is not chosen is dropped.
- The button acts on the exact items the message was about, never on whatever is current when it is clicked.
  If those items have changed so that the action no longer applies, it fails with a case d) message rather than acting on something else.
- One timed message shows per window at a time; a newer one replaces the older, which closes its choice as if it had expired.
  Messages never stack.
- A middle click anywhere on the message closes it at once, as if it had expired, without pressing its button.
- Do not show a message that offers no action.

## 27.3 Where it shows and how long it lasts

The message takes the sidebar header while it lasts: the space title, Settings and Search step aside, and come back when it goes.
It fades in as it slides down from the top, and fades out as it slides back up; under reduced motion it only fades.
A newer message waits for the one it replaces to leave before it shows.
In Settings it replaces the Settings heading and leaves Back in place.
At 99px wide and below the header keeps its title and the message does not show, and while Search is open the message is hidden (`sidepanel/style.css`).

Every timed message lasts the same time, seven seconds by default.
The user sets it in Settings > System with the Message timing slider, from three seconds (Fast) to fifteen (Relaxed), in whole seconds.
A dot on the slider marks each whole second it can stop at, coloured like the bar where it sits: blue up to the thumb and grey after it.
On a sidebar too narrow to keep the dots apart they shrink, and then merge into the bar.
The choice is saved as the `timedMessageSeconds` preference in the `hyper` root folder's metadata, and the background reads it as each message shows, so a change applies from the next message.

The tone colours the message: blue for information, yellow for a refusal or warning, red for an error.
`TimedMessageNotice.tsx` renders it.
The message's tooltip shows its text and, on a second line, any detail, such as the title of the bookmark involved; the button's tooltip and accessible label say what it does.
The copy button of a case d) message copies that same text and detail to the clipboard, and its icon then turns to a tick and its label to "Copied" until the message goes.

## 27.4 The model owns the message

The message is model state ([decision 1](../decisions/01-one-model-in-the-background.md)), and each one is a best guess the user can change ([decision 30](../decisions/30-a-timed-message-is-a-best-guess-the-user-can-change.md)).
`entrypoints/lib/timedMessages.ts` keeps one message per window and projects it as `HyperWindowProjection.timedMessage`.
What the button does stays in the background; the view only sends `actOnTimedMessage {messageId}`, or `dismissTimedMessage {messageId}` for a middle click.
A dismissal of a message that has already gone does nothing.
A button that asks the browser for a permission runs as the press is admitted ([model §6](../model/06-serialization-causation-and-failures.md)).
A stale id, because the message was replaced or expired, is refused with "This message has expired." and nothing runs.
If the action itself fails, Hyper shows the failure as a case d) message.
Views report errors and feedback by sending `showMessage {text, tone}`, so a report replaces any open offer rather than appearing alongside it.
A message about one tab goes when that tab leaves the window.

A run of like actions shares one undo message rather than each replacing the last ([decision 59](../decisions/59-like-undos-in-a-row-share-one-message.md)).
An undo offer names its series, such as closed tabs, and the items it acted on.
While a message of the same series shows, a new offer joins it: the message counts every distinct item the run acted on, such as "Closed 3 tabs", and starts its time again.
A run that has only acted on the newest offer's items again, such as one tab moved twice, reads as that offer.
Any other message in between, or the message going, ends the run, and the next offer starts a new one.

| Series | Joined message | Joins |
| --- | --- | --- |
| Closed tabs | "Closed N tabs" | Closing tabs, a tab folder or autofolder, or a space's tabs from its menu |
| Moved tabs | "Moved N items" | Moving tabs in the Tabs list or tab tree |
| Moved bookmarks | "Moved N items" | Moving bookmarks |
| Deleted bookmarks | "Deleted N items" | Deleting bookmarks or bookmark folders |
| Closed other sessions' tabs | "Closed N items" | Closing other sessions' tabs |
| Unpinned favourites | "Unpinned N items" | Unpinning favourites |
| Removed tab folders | "Removed N folders" | Sending tab folders to the bin with their tabs |

## 27.5 Current messages

| Message | Case | Source |
| --- | --- | --- |
| "Deduplicate?" after a kept duplicate opens ([§13.5](13-opening-reuse-and-deduplication.md)) | a) Tick | `duplicateController.ts` |
| "Fix play/pause?" while Now Playing can only mute a page Hyper's script cannot reach ([§17.3](17-tabs-tab-folders-and-media.md)) | a) Tick | `mediaAccessOffers.ts` |
| "Deduplicated tab" after a link to an open page is sent back or closed ([§13.4](13-opening-reuse-and-deduplication.md)) | b) Cross | `navigationDedupe.ts` |
| "Already open in [space]. Switch instead?" after the user opens a page another space shows ([§13.6](13-opening-reuse-and-deduplication.md)) | a) Tick | `crossSpaceDuplicates.ts` |
| "Linked to bookmark" after a tab links itself ([§14](14-tab-naming.md)) | b) Cross | `tabBookmarkLinkController.ts` |
| "Deleted bookmark", "Deleted folder" or "Deleted N items" | c) Undo | `deleteBookmark` in `bookmarkIntentHandlers.ts` |
| "Closed tab" or "Closed N items" when other sessions' tabs are closed ([§20.2](20-drag-and-drop-contract.md)) | c) Undo | `deleteBookmark` in `bookmarkIntentHandlers.ts` |
| "Item unpinned" when one favourite is unpinned | c) Undo | `deleteBookmark` in `bookmarkIntentHandlers.ts` |
| "Closed tab" or "Closed N tabs" when a space's menu closes its tabs ([§12.5](12-spaces-windows-and-activation.md)) | c) Undo | `closeSpaceTabs` in `spaceIntentHandlers.ts` |
| "Closed tab" or "Closed N tabs" when Hyper closes this window's tabs, as a row's X, middle click, the bin, a menu's Close, the broom or Close other tabs do | c) Undo | `closeTabs` in `tabIntentHandlers.ts` |
| "Closed folder" when a tab folder or autofolder's X, middle click, or its menu's Close closes the tabs it holds, one message for the whole folder | c) Undo | `closeTabs` with `folderTitle` in `tabIntentHandlers.ts` |
| "Moved bookmark", "Moved folder" or "Moved N items" | c) Undo | `moveBookmark` in `workspaceIntentHandlers.ts` |
| "Moved tab", "Moved folder" or "Moved N items" in the tab tree | c) Undo | `setTabFolder` move in `workspaceIntentHandlers.ts` |
| "Moved tab" or "Moved N items" when tabs are reordered, pasted within their window's Tabs list, or moved to another space by a held drag | c) Undo | `moveTabs` in `tabIntentHandlers.ts` |
| "Removed folder" when a tab folder goes to the bin with its tabs | c) Undo | `setTabFolder` remove in `workspaceIntentHandlers.ts` |
| Errors, refusals and confirmations such as "Copied …" | d) Copy | `showMessage` in `timedMessages.ts` |

Closing a tab outside Hyper, such as from the tab strip, has no undo; the browser's own Reopen closed tab covers it.
Closing a page in another space from Search has no undo either, and nor has dragging tabs in from another window.
A close that takes away only blank or pinned tabs offers nothing, as neither has a backing to make again.
A move that leaves every item where it was offers nothing.

## 27.6 Undo

Undo state is held in the background only while its message shows, and is dropped when the message expires or is replaced.
The Undo of a joined message undoes every action in the run, newest first, as each was done on top of the one before.
An undo that makes a bookmark again records the copy's new ID, so an older undo in the run finds a folder a newer one made again rather than failing or making a second.
One that fails does not stop the older ones; the first failure shows as a case d) message.
- Moves record each item's parent and index first, and undo puts each item back in its parent in its original order.
  A tab's place in the Tabs list is its backing bookmark's place, so undoing a tab move restores the backing bookmarks and the tab strip follows the list.
- Deletes record each deleted subtree, and undo recreates it at its original position.
  Recreated bookmarks get new ids, so undo relinks each tab that was linked to a deleted bookmark to its copy, unless the tab has since left that bookmark's domain.
- Removing a tab folder with its tabs records the folder's subtree; undo recreates the folder, moves the surviving tab bookmarks back into it, and reopens the tabs that were closed in the background, in the folder's space.
  A reopened tab does not keep a custom name.
- Closing tabs records each of their spaces' tab trees first (`closedTabsUndo.ts`).
  Undo makes the closed tabs' backings again in their tab folders and split views, with their names and bookmark links, and reopens them in the window.
  A folder emptied and since removed is made again around its tabs.
  If one of the closed tabs was showing, it shows again.
- Closing a space's tabs from its menu does the same.
  If the window still shows the new tab page that stood in for them, the tab that was showing shows again.
  A stand-in Hyper opened then closes, unless it has left the new tab page or is still showing.
- Undo of items that no longer exist fails with a case d) message.
