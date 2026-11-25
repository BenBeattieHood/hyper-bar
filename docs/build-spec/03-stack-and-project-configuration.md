# 3. Stack and Project Configuration

`wxt.config.ts` owns the manifest: names, permissions (including `clipboardRead`), optional page access, commands and web-accessible resources for Chromium MV3 and Firefox MV2; `wxt.config.test.ts` checks both.
`package.json` owns the dependencies and scripts, and [AGENTS.md](../../AGENTS.md) says which commands to run.
The manifest's only command takes its key from `openHyper` in `SHORTCUTS` (`entrypoints/lib/shortcuts.ts`): Chromium's `_execute_action` on Ctrl/Cmd+Shift+P, and Firefox's `open-command-bar` on Alt+Shift+H.
Unshifted Ctrl/Cmd+P is never a browser command, because `entrypoints/page-shortcut.content.ts` owns it on web pages, where it suppresses Print and opens Search ([§21.1](21-search-new-tab-and-page-overlay.md)).
