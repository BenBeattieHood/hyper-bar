# 16. Everything that crosses a port is untrusted

**Decision.** Intent payloads are parsed before a command is admitted, and a payload that does not parse is rejected without becoming a pending command (`intentHandler`, `modelIntentPayloads.ts`).
A client's role and window come from the browser's `sender`, not from what the client says: a page-search client must be loaded for its own source tab and window, the in-page sidebar must carry the token issued to its tab, and a side panel, which has no `sender.tab`, is bounded by one sidebar per window.
Each client receives one unacknowledged delivery at a time (`modelPort.ts`).

**Why.** Extension pages can be framed or reached by web pages, and a view can be stale or broken.
Deriving identity from the browser stops a client from acting on another window, and parsing first means a malformed message can never reach a browser API.
Bounding deliveries means a wedged view cannot make the worker queue snapshots without limit.

**Cost.** Each intent needs a payload parser and declared targets, and payload shapes change only together with their parsers.
