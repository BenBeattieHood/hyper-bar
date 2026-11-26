# 24. Test Requirements

`tests/architecture.test.ts` keeps the model boundary: it ratchets the views' direct browser calls, browser event listeners and runtime messages, and the line counts of three untested files, and checks that every intent kind has a handler and a caller.
Its budgets fail in both directions ([decision 12](../decisions/12-ratchets-fail-in-both-directions.md)); each failure message says what to change.
`wxt.config.test.ts` checks the emitted Chromium and Firefox manifests.

Do not use renderer `page.keyboard.press()` as proof that a browser-level extension accelerator fired.
Exercise the page content-script route in the renderer and action routing through the registered listener, and keep native browser-chrome accelerator delivery in the manual smoke test.
What no automated test proves is listed in the [debugging guide](../debugging.md#limits-no-test-covers).
