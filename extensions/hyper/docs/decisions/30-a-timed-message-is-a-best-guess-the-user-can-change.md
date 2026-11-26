# 30. A timed message is a best guess the user can change

**Decision.** Hyper shows a timed message only when its single button gives the user a real choice about something Hyper just did or offered.
There are four cases, each with a fixed button icon: opt in to an uncertain follow-up (tick), opt out of a likely follow-up (cross), undo a change (undo), and copy an error or feedback message (copy).
The background owns the one message per window, as model state, so it never disagrees across sidebars and never stacks.
Errors and feedback take the same path, so a report replaces an open offer instead of covering it.
The full contract is [build-spec §27](../build-spec/27-timed-messages.md).

**Why.** Hyper often has to guess, for example whether a duplicate tab was deliberate.
A modal question would interrupt every time, and acting silently would surprise the user when the guess is wrong.
A countdown lets the best guess stand by default while the alternative stays one click away.
Fixing the icon per case means the user learns what the button does once, instead of reading each message.
Giving error and feedback messages a copy button means no timed message is just text that disappears.

**Cost.** Each follow-up has to be reversible, or deferrable until the user opts in, for the length of the countdown.
The button must act on the exact items its message named, so the background has to keep that identity, and any undo snapshot, until the message expires.
A newer message replaces an older one, so a quick second action takes away the first one's undo.
No message shows beside the section it concerns; every message shows in the header.
