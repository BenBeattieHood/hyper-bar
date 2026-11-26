# Workspace agent guide

This repo is a workspace with multiple projects.

## Layout

- `extensions/hyper/`: primary browser extension project.
  See `extensions/hyper/AGENTS.md` for architecture, constraints, and extension-specific commands.
- `apps/site/`: Next.js client-only website and embedded live demo.
- `extensions/companions/`: sibling folder for additional companion extensions.

## Commands

- `npm run dev:hyper`: run extension dev server
- `npm run build:hyper`: build extension
- `npm run dev:site`: run website
- `npm run build:site`: build website

## Rule of thumb

Run commands from the workspace root unless you are working inside one project exclusively.
