# 41. An intent Chrome refused is sent again

**Decision.** The model client sends an intent or search again, once and with the same command id, when Chrome refuses to post it.
Chrome can close a port before it reports the drop, and `postMessage` then throws, so that message provably never reached the background.
An intent that left before its port dropped is never repeated by the client, because the background may have run it and its record of command ids lives only in that worker's memory.
A view repeats it only when the intent is safe to run twice, as the sidebar's `focusTab` (`useBrowserState.ts`) does with `activateTab`.
The retry limits, outcomes and when waiters and overlays are released are in [model §4](../model/04-store-and-transport.md).

**Why.** Clicking a tab while the background worker slept sometimes did nothing, and sometimes opened a second copy of the tab.
The click's intent was refused by a port Chrome had already closed, and a fallback then reopened the tab's URL in a new tab.
Sending a refused message again removes the reason for that fallback, which was deleted with it.
Repeating only intents that are known to be lost or safe to repeat keeps a dropped close, move or delete from running twice.

**Cost.** A click made just as the worker sleeps can take one reconnection longer.
Every new intent kind a view repeats after `dropped` must be idempotent, or that repeat can apply the user's choice twice.
