# entrypoints/inpage

The in-page sidebar: Hyper's sidebar shown inside web pages while the browser's own side panel is closed.

## Layout

- `host.ts`: runs in the page through `entrypoints/page-shortcut.content.ts`.
  Builds a closed shadow root with the corner mark, the resizable edge and the iframe, and hides it after clicks elsewhere.
  Its single `browser.runtime.sendMessage` (frame request and resize) is budgeted in `tests/architecture.test.ts`.
- `index.html` and `main.tsx`: the iframe page (`inpage.html`).
  It renders the sidebar `App` from `../sidepanel/` with the sidebar's `style.css`.

## Rules

- The host trusts only frames Hyper issued; see [docs/decisions/10](../../docs/decisions/10-the-in-page-sidebar-trusts-only-frames-hyper-issued.md).
- Width is a preference: the host sends `resize`, `entrypoints/lib/inPageSidebarController.ts` saves it once per gesture and pushes it to every page.
  Clamping lives in `entrypoints/lib/inPageSidebarProtocol.ts`.
- Playwright cannot reach the closed shadow root: verify host CSS with screenshots, and measure the frame through `frame.frameElement().boundingBox()`.
- Content scripts only attach on page load, so reload open tabs after rebuilding.
- e2e: `tests/e2e/in-page-sidebar.spec.ts`, `sidebar-layout.spec.ts`.
