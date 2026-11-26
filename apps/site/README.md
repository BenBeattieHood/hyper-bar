# Hyper website and live demo

The site is a client-only Next.js application in `apps/site`.

## Real shared UI

The embedded demo mounts the extension's production `SidebarApp` in an iframe at `/demo`. It uses the real Hyper topbar, favourites bar, Tabs and Bookmarks trees, settings surface, drag infrastructure, context actions, and space pagination from `extensions/hyper`—not a website redesign or copied approximation.

## Demo adapter

`app/demo/useDemoBrowserState.ts` is a typed in-memory adapter for the production `BrowserStateApi`. It provides a valid Hyper bookmark hierarchy, tab ownership, and local operations. It intentionally does not run the extension background worker or access real browser bookmarks, windows, or tabs.

The adapter supports:

- searching through the real Hyper command bar
- activating and closing tabs
- opening bookmarks as tabs
- renaming tabs, bookmarks, and spaces through the production editors
- opening menus, changing settings, and using the production keyboard/drag surfaces

The iframe is deliberate: it gives the production app its own viewport and prevents Hyper's extension-page reset/CSS from affecting the marketing page.

## Running

From the workspace root:

```sh
npm run dev:site
npm run build:site
```
