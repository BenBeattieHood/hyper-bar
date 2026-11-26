# entrypoints/sidepanel

The sidebar view: a React app shown in the browser's side panel and, through `entrypoints/inpage/`, inside web pages.
It is a view only: it renders a projection of the background model and sends typed intents.

## Layout

- `App.tsx`: composition root.
  Wires the hooks and lays out the top-level components.
  It must keep the literal `browserCommandActions({` call (checked by `tests/architecture.test.ts`).
- `components/`: presentational pieces (`Tabs.tsx`, `BookmarkTree.tsx`, `SortableTree.tsx`, `CommandBar.tsx`, `SpacePagination*.tsx`, `SidebarTopbar.tsx`, `SettingsView.tsx`, menus and notices).
- `hooks/`: stateful view logic.
  `useBrowserState.ts` owns the model port subscription, overlays and intent submission.
  Drag is split across `useDragSession.ts` (start and sensors) and `useWorkspaceDrop.ts` (projection and drop).
  Item menus, paste and remove go through `useItemActions.tsx`.
- `lib/`: pure, unit-tested view logic, for example `drag*.ts`, `dropActions.ts`, `nativeDrag.ts`, `externalDrop.ts`, `shortcutFiles.ts`, `pagePlans.ts`, `treeKeyboard.ts`, `itemClipboard.ts`, `clipboardItems.ts`, `intentSubmission.ts`, `projectionState.ts`.
- `style.css`: all sidebar styles (shared with the in-page frame).
- `base.css`: theme tokens, resets and the Hyper mark shared by the sidebar and the new tab page; both stylesheets `@import` it.

## Rules

- No direct `browser.tabs|bookmarks|windows|...` calls and no browser event listeners; the few sanctioned ones are budgeted per file in `tests/architecture.test.ts`.
- React state is for render state only (open folders, hover, editor state).
  Domain state comes from the projection.
- Every edit goes through an intent; `entrypoints/lib/modelOverlay.ts` holds only command-bound guesses until the model proves or rejects them.
  Do not add a direct-write overlay path.
- Send one intent per user choice; multi-item actions use `submitSelection(kind, items)`.
- `App.tsx` and `hooks/useBrowserState.ts` have exact line budgets; move logic into `hooks/` or `lib/` rather than growing them.
- Keep class names, `data-*` and aria attributes stable; e2e tests select rows by `data-url`, never by title.
- Drag uses native HTML5 DnD bridged into dnd-kit; read [docs/decisions/19](../../docs/decisions/19-a-drag-between-windows-goes-through-the-model.md) before changing it.
- UI contracts: [docs/build-spec](../../docs/build-spec/README.md) sections 15 to 21.
