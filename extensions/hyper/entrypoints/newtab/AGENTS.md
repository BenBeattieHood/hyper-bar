# entrypoints/newtab

The new tab page and the page Search overlay (Ctrl/Cmd+P in a web page), both served from `newtab.html`.

## Layout

- `App.tsx`: search UI built on the sidebar's `CommandBar`, item menus and clipboard helpers from `../sidepanel/`.
  It must keep the literal `browserCommandActions({` call (checked by `tests/architecture.test.ts`).
- `main.tsx`: mounts the app and the Reload Hyper notice (decision 52), and applies the overlay theme sent by the content script.
- `lib/`: small pure helpers with unit tests (`newTabData.ts`, `inspiration.ts`, `searchEngineSettings.ts`).
- `style.css`: page styles; imports the shared tokens and resets from `../sidepanel/base.css`.

## Rules

- A view like the sidebar: it reads the model projection and sends intents.
  Its single `browser.runtime.sendMessage` is budgeted in `tests/architecture.test.ts`.
- Ranking and indexing live in `entrypoints/lib/search*.ts`, not here.
- Contract: [docs/build-spec/21](../../docs/build-spec/21-search-new-tab-and-page-overlay.md). e2e: `tests/e2e/page-shortcut.spec.ts`, `partial-url-search.spec.ts`, `google-search-dedup.spec.ts`.
