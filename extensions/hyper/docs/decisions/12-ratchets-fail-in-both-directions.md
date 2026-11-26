# 12. Ratchets fail in both directions

**Decision.** `tests/architecture.test.ts` counts browser API use, listeners, and runtime messages in view files, and the lines of `background.ts`, `sidepanel/App.tsx`, and `useBrowserState.ts`, against banked budgets.
It also checks that every intent kind has both a handler and a caller.
A count above its budget fails, and so does a count below it.

**Why.** Those three files carry no unit tests, so growth there is where risk compounds.
Failing on improvement forces the budget to follow progress down, so ground that is won cannot be quietly lost again.

**Cost.** Any change that moves a counted line or call into or out of a budgeted file has to edit its budget in `tests/architecture.test.ts` too, even when the change is an improvement.
