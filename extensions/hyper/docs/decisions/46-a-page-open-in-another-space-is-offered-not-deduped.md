# 46. A page open in another space is offered, not deduped

**Decision.** When the user opens a page that a tab in another space already shows, Hyper lets the page open and offers the other tab with an opt-in timed message, "Already open in [space].
Switch instead?".
The tick switches to that space and tab, then silently takes the user's tab back: closed if the page opened it as a new tab, otherwise sent back in history.
The full contract is [build-spec §13.6](../build-spec/13-opening-reuse-and-deduplication.md).

`crossSpaceDuplicates.ts` owns the offer and is called from `tabNavigationIngress.ts` after a navigation is routed and same-space dedupe has passed on it, so one navigation gets at most one offer and same-space dedupe always wins.
It reuses `normaliseUrl`, the identity same-space dedupe uses, and the window's one timed message from `timedMessages.ts`, so it needs no new intent: the tick is `actOnTimedMessage`.
The switch goes through `windowSpaceChoice.beforeTab`, the path a sidebar tab click takes, so the latest space choice in a window still wins.
A back navigation Hyper makes for the tick is marked, so the ingress neither dedupes nor offers it.

**Why.** Spaces separate contexts, so the same page in two spaces is often deliberate, unlike two copies in one space.
Sending the tab back on a guess, as same-space dedupe does, would take the page out of the space the user opened it in; an opt-in keeps that choice with the user and costs nothing when ignored.
Restoring the user's tab only after the switch shows the destination first, and leaves the source looking as it did before the link.

**Cost.** The user's tab is not taken back until the tick is pressed, so it has already loaded the page and may have run it.
A tab that has left the page before the tick is left alone, and the switch still happens.
The offer replaces an earlier message from the same navigation, such as "Linked to bookmark", and with it that message's cross.
Tabs Hyper opens itself, including a ctrl/cmd click on a Search result, are not offered on their first page.
