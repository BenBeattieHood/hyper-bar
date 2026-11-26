# Hyper Workspace

This repository is now organized as a multi-project workspace.

## Folders

- `extensions/hyper`: primary Hyper browser extension (WXT + React + TypeScript)
- `apps/site`: client-only Next.js website describing Hyper, with an embedded live demo powered by sample data
- `extensions/companions`: home for additional companion extensions (for example, GitHub PR status helpers)

## Quick Start

```sh
npm install --legacy-peer-deps
npm run dev:site
npm run dev:hyper
```

## Build

```sh
npm run build:site
npm run build:hyper
```

Production setup for Render and browser-store publishing is in [DEPLOYMENT.md](DEPLOYMENT.md).

## Notes

- The extension remains source-of-truth in `extensions/hyper`.
- The website demo in `apps/site` is an in-browser simulation backed by sample data so it can run without extension APIs.
