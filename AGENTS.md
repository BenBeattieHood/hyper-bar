# Hyper agent guide

Hyper is an Arc-inspired sidebar for tabs and bookmarks, built as a WXT browser extension (MV3) with React 19 and TypeScript.
The user runs it in Edge, loaded unpacked from `output/chrome-mv3`.

## Layout

| Path | What lives there |
| --- | --- |
| `entrypoints/background.ts` | Service worker. Wiring only: builds controllers, registers listeners, composes intent handlers. |
| `entrypoints/lib/` | All shared and background logic, one module per concern. See [entrypoints/lib/AGENTS.md](entrypoints/lib/AGENTS.md). |
| `entrypoints/sidepanel/` | The sidebar view (native side panel, also reused in-page). See [entrypoints/sidepanel/AGENTS.md](entrypoints/sidepanel/AGENTS.md). |
| `entrypoints/newtab/` | New tab page and the page Search overlay. See [entrypoints/newtab/AGENTS.md](entrypoints/newtab/AGENTS.md). |
| `entrypoints/inpage/` | In-page sidebar host and frame. See [entrypoints/inpage/AGENTS.md](entrypoints/inpage/AGENTS.md). |
| `entrypoints/page-shortcut.content.ts` | HTTP(S) content script: Ctrl/Cmd+P Search overlay and the in-page sidebar host. |
| `tests/architecture.test.ts` | Executable architecture rules and line-budget ratchets. |
| `tests/e2e/` | Playwright specs; shared code in `fixtures/` and `helpers/`. |
| `docs/` | Specs and decision log, one file per section. Start at [docs/README.md](docs/README.md). |
| `INDEX.md` | Generated index of every file and function with its responsibility. Regenerate with `npm run index`; never edit by hand. |
| `scripts/` | Repo tooling: `generateIndex.ts` and `indexDescriptions.json` (responsibilities for functions without a doc comment). |

WXT treats every top-level file in `entrypoints/` as an entrypoint, so new modules go in a subfolder, never directly in `entrypoints/`.

## Commands

- `npm run check`: typecheck plus quiet unit tests.
  Run this first; it prints only failures.
- `npm run build`: production build into `output/chrome-mv3`.
  Always run it after changing code, then tell the user to Reload Hyper in `edge://extensions` and reload open tabs.
- `npm run test:e2e:quiet -- tests/e2e/<file> -g "<title>" > logs/e2e-<name>.log 2>&1`: builds `output/chrome-mv3-e2e` and runs Playwright with the line reporter.
  Read only the log tail.
- On macOS, Chromium cannot launch inside the VS Code agent sandbox, which denies the Mach `bootstrap_check_in` its child processes need; no Chromium flag or sandbox path setting avoids this.
  Request e2e runs outside the sandbox from the start.
  Each run needs the user's approval, even in Autopilot, so batch specs into one command.
- `npm run verify`: compile, full unit tests, Chrome and Firefox builds.
- `npm run index`: regenerates `INDEX.md`. It lists any function with no description; give it a doc comment.
- `npm run bench:search > logs/bench-search.log 2>&1`: times the background half of Search keystrokes on a large generated profile (`tests/bench/`).
  Run it before and after changing search code.

## Rules

`tests/architecture.test.ts` enforces these:

- The background model is the only authority.
  Views receive projections over a port and send typed intents.
  Beyond the few calls budgeted per file, they make no browser domain calls and add no browser event listeners.
- One user choice is one intent.
  Every intent kind needs a handler and a caller.
- Line budgets fail in both directions: when a budgeted file shrinks or grows, set its budget to the exact new `split('\n').length`.

No test checks these, so check them yourself:

- Bookmarks are the durable store; `storage.session` is only a cache and `storage.local` holds machine-local data only.
- Add a `docs/decisions/` entry when making a structural choice.

## Working efficiently

- Trace one change through `entrypoints/sidepanel/hooks/useBrowserState.ts` (or `entrypoints/newtab/App.tsx`) -> `entrypoints/lib/modelClient.ts` -> `entrypoints/lib/modelPort.ts` -> `entrypoints/lib/modelIntents.ts` -> its handler -> `entrypoints/lib/modelReconciler.ts`.
  Read only the files on that path.
- Do not read whole spec folders.
  Open the folder's `README.md` index and read only the needed section files.
- Never search or read `output/`, `logs/`, `.wxt/`, `node_modules/` or `test-results/`.
- Send long command output to `logs/` (gitignored) and read the tail or grep it.
- Test observable behavior at the nearest layer; do not keep unit tests for removed or unreachable adapters.
  Run focused tests before the full `check` and `build`.
- Several e2e tests are timing-sensitive under four workers; rerun a failure alone with `--repeat-each=3` before treating it as a regression.
- If it still fails, run it against a control: `git worktree add` the last commit without your change, symlink this checkout's `node_modules` into it, run `npm run build:e2e` there, then run `npx playwright test` here with `HYPER_EXTENSION_PATH` set to the worktree's `output/chrome-mv3-e2e`.
  A failure the control also shows predates your change.
- Commit at each suitable milestone, such as a feature or fix that passes `check`, its focused e2e specs and `build`; do not wait to be asked.
  Commit only your own changes, one coherent change per commit, and leave unrelated uncommitted work alone.
