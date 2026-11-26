# 48. Other sessions' tabs act like this window's tabs

**Decision.** Another session's tab (decision 21) selects, cuts, copies, pastes, closes and drags as this window's tabs do, through the same selection, menus, keys, clipboard and drops.
Every action goes through an existing intent: drops and pastes are one `moveSessionTab`, and closing is one `deleteBookmark` for the backings, which Undo restores.
`ContextMenuEntry` has `disabled` and `hint`, rendered as `aria-disabled` and a tooltip, so an action that cannot work, such as Reload on a session tab, is shown and explained rather than hidden or silently dropped.
The full contract is [build-spec §20.2](../build-spec/20-drag-and-drop-contract.md).

**Why.** Session tabs could only be dragged one at a time, so moving several or keeping one as a bookmark took detours, and nothing could be closed.
Routing every action through the paste-is-a-drop path (decision 27) and the existing intents keeps one way to do each thing and one place for its rules.
No browser API lets an extension close or reload a tab on another device: `chrome.sessions` lists other devices' tabs but has no close, reload or move, and Hyper's sessions are bookmark backings rather than `chrome.sessions` entries anyway.
Forgetting the backing is the closest robust close: it syncs to every device, it is what the session keeps, and it can be undone.

**Cost.**
- A device still running that Hyper installation keeps its real tab open and lists it again under a new backing, so Close and Cut there act like a copy (decision 21's cost), as the Close entry and the row's X say in their tooltip.
- Several actions cannot work on a session tab and show disabled or refused instead, as listed in [build-spec §20.2](../build-spec/20-drag-and-drop-contract.md).
