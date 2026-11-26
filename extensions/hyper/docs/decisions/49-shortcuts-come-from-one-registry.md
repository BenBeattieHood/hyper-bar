# 49. Shortcuts come from one registry

**Decision.** Every keyboard shortcut Hyper handles or shows is an entry in `entrypoints/lib/shortcuts.ts`: its label, its key (Cmd on macOS, Ctrl elsewhere, with a Firefox key where the manifest needs one), who owns it (Hyper, the manifest or the browser), where it applies, the Search command row that runs it and whether a button runs it.
`wxt.config.ts` builds the manifest command from it; `useSidebarShortcuts`, `useTreeKeyboard` and `isPageOpenShortcut` match key presses with it; buttons take their tooltip, `aria-keyshortcuts` and `data-shortcut` from `shortcutButtonProps`; and Search rows, item menus and browser command rows take their key labels from `shortcutLabel`.
`useSidebarShortcuts` returns one action per sidebar shortcut, and `hyperCommandActions` builds the Hyper Search rows from those same actions, so a key and its Search row do the same thing.
New sidebar keys use Alt (Option), which browsers leave mostly free; Alt and bare keys do nothing in a text field, and Cmd/Ctrl keys work everywhere.
How keys behave, and which browser bindings Hyper takes on purpose, is in [build spec 21](../build-spec/21-search-new-tab-and-page-overlay.md#keyboard-shortcuts).

**Why.** Before this, the same key was written in up to four places (a handler, a tooltip string, a Search row and the manifest), and they had already drifted: the workspace row showed `⌘Shift+E` on every platform.
One entry per shortcut makes a drift a type error or a failing test: `shortcuts.test.ts` checks no two shortcuts share a key where both can hear it and that none lands on a browser default without a stated reason, `shortcutTooltips.test.tsx` renders the sidebar controls and checks every button that runs a shortcut names its key, and `hyperCommands.test.ts` checks every registry Search row shows its key.

**Cost.** The registry shows the manifest command's suggested key; a user who rebinds it in the browser's shortcut settings sees the old key on the new tab page's "Open Hyper sidebar" row.
A button that runs a shortcut must pass its id (`shortcutButtonProps`, `BookmarkCreateActions`' `bookmarkShortcut`/`folderShortcut`, `BookmarkMenu`'s `triggerShortcut`) or the tooltip test fails.
