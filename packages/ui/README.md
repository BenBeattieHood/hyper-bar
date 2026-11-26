# @hyper/ui

Presentational React components shared by the Hyper extension and the website demo.

Keep this package independent from browser extension APIs and application-state services. Browser-specific wiring should remain in `extensions/hyper`; sample-data wiring stays in `apps/site`.

Current exports:

- `Favicon`
- `InlineItemTitle`
- favicon/audio display helpers
- inline-title timing helpers

Styles are available from `@hyper/ui/styles.css`.
