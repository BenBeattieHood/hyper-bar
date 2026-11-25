# 11. End-to-end tests build into their own folder

**Decision.** `npm run test:e2e` builds into `output/chrome-mv3-e2e`, selected by `HYPER_E2E_BUILD` in `wxt.config.ts`.
Only `npm run build`, `npm run verify` and `npm run zip` write `output/chrome-mv3`; `npm run check` builds nothing.

**Why.** `wxt build` empties `output/chrome-mv3`, the folder a developer's own browser loads unpacked, so a test run would replace the extension running there.
`wxt build --mode` cannot choose the folder instead, because the mode also sets `NODE_ENV` and would test a non-production React build.

**Cost.** Every end-to-end run makes a full production build of its own, even when `output/chrome-mv3` is current.
`npm run verify` replaces the extension a developer's browser loads, so it is not a check to run while that browser is in use.
