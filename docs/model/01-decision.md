# 1. Decision

The background worker owns one materialized model in a Jotai vanilla store (`createHyperModelStore`, `hyperModelAtom` in `entrypoints/lib/model.ts`).
`entrypoints/background.ts` only wires; model behavior lives in `entrypoints/lib` ([decision 13](../decisions/13-the-background-entrypoint-only-wires.md)).
A Jotai store in a React view is prohibited for browser or Hyper domain state because it would be a separate store in a separate JavaScript context.
Views consume read-only projections over a versioned runtime port and send typed intents.
The background Search controller reads the committed model too.

This is an ownership rule, not a library preference; [decision 1](../decisions/01-one-model-in-the-background.md) keeps the reason.
Worker memory is disposable.
On every start, rebuild from browser APIs, bookmarks and local/session storage, not an old in-memory projection.
