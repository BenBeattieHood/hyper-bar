# 10. Acceptance

Focused tests must cover pure projections, stale-generation rejection, exact backing collisions, model-port roles/revisions, batches and partial effects, import boundaries, journal recovery and structural health versus direct repair.
Chromium lifecycle coverage should include worker restart with panels closed, rapid space selection plus native activation, native duplicate and target-blank same-URL tabs, copied-ownership collision, cross-window indicator move, unrelated native groups, external bookmarks, port reconnect, tab replacement/discard/restore, delayed browser restore and privacy separation.
Firefox coverage should exercise session/API fallbacks.
These cases matter because worker and browser event lifetimes are not ordered like React renders.

What [`tests/architecture.test.ts`](../../tests/architecture.test.ts) enforces is in [build-spec §24](../build-spec/24-test-requirements.md).
[AGENTS.md](../../AGENTS.md) lists the commands to run and how to tell whether an e2e failure predates a change.
