# 13. The background entrypoint only wires

**Decision.** `background.ts` creates the store, registers listeners, and connects modules; behaviour lives in `entrypoints/lib`, one module per concern (see the [module map](../../entrypoints/lib/AGENTS.md)).
A module that journals a multi-step operation also recovers it, as the table in [model §6](../model/06-serialization-causation-and-failures.md) lists.
The background only dispatches on the operation's kind.

**Why.** The entrypoint registers listeners when it loads, so code inside it cannot be unit tested; recovery code that lived there had no tests at all.
Keeping an operation's journal entry and its recovery in one module keeps the completion proof one writes and the other checks in one place, so they cannot drift apart.

**Cost.** Modules take their worker-local state (activation tokens, navigation generations, the mutation queue) as injected dependencies, which makes their signatures longer than inline code would be.
