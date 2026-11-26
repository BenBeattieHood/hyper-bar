# 15. Multi-step effects are journalled before they start

**Decision.** An operation that takes several browser effects and cannot be undone by simply reading the browser is written to `hyperOperationJournal:v1` before its first effect, advanced as it goes, and removed when done (`operationJournal.ts`).
Its kinds, entry shape and per-kind proofs are in [model §6](../model/06-serialization-causation-and-failures.md).
On the next worker start, recovery checks each entry's recorded completion proof and then completes it, rolls back only what the entry names, or records it as abandoned.

**Why.** A Manifest V3 worker can be stopped at any moment.
Without a record, a restart would find half a deletion or half an imported folder and could not tell it from something the user made.
Rolling back only named entities, and abandoning when the proof does not match, means recovery never deletes content it cannot prove it created.

**Cost.** Live entries are capped at 64 and abandoned ones at 32, so a burst of failures is kept as history only up to that bound; a new operation is refused rather than evicting a live one.
