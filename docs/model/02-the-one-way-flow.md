# 2. The One-Way Flow

There is one model with observations and user choices as inputs:

```text
browser events -> background observation/read -> atomic model commit
view choice -> authenticated typed intent -> background browser/bookmark effects
effects and their browser events -> fresh read -> commit -> scoped projections
scoped projections -> views and model-derived Search
```

Listeners schedule reconciliation and may maintain background-only signals (navigation status, history, media, content and duplicate detection); they do not write individual Jotai browser fields.
Controller effects become visible after a browser/bookmark read; admission only adds `pending` command status.
This gives browser changes and command outcomes one ordered revision stream.

The sidebar can render edits from `entrypoints/lib/modelOverlay.ts` over its last projection.
It adds an edit before submitting an intent, marks it admitted on `accepted`, and drops it on rejection.
A dropped port drops only admitted edits (`discardPendingCommands`); an edit not yet admitted waits for its own intent's outcome.
`project` retires an edit at terminal status or, after admission, when a pruned status is absent.
`MAX_PENDING_OVERLAYS = 64` bounds edits in application order.
No overlay is broadcast, written back to the model or retired by timeout; the view has no direct-write overlay path.
`useBrowserState.ts` writes domain fields only in `reproject`, from the projection, the overlays and the active-space hold; a caller never adopts a field by hand after its intent settles, because the settling revision already carries it.
`entrypoints/sidepanel/lib/commandSettlement.ts` tracks waiting callers.
`entrypoints/sidepanel/lib/activeSpaceHold.ts` keeps the chosen space visible until that exact value appears in the projection or its `selectSpace` command settles, so an intervening revision cannot switch the view back and the settling revision is authoritative after that.
`entrypoints/sidepanel/lib/spaceActivation.ts` coalesces burst choices after admission, not settlement.

Search text, result selection, row selection and marquee rectangles, drag geometry, collapsed folders, the active compact view, hover, popovers, pending notices and animations are view-local ([decision 2](../decisions/02-a-view-keeps-only-render-state.md)).
Persisted Search selection ranking is committed runtime metadata.
The background's FlexSearch indexes (`SharedSearchIndex` in `entrypoints/lib/searchIndex.ts`) are warm indexes synced to each request's records, not another model.

There are exactly two sanctioned view self-reads.
`useBrowserState.ts` calls `browser.windows?.getCurrent()` once for the sidebar's window id in `hello`: a side-panel port sender has no window.
`sidebarPlacement.ts` calls `browser.windows.getCurrent()` once to compare Firefox panel geometry (`mozInnerScreenX`) with its owning window when `sidePanel.getLayout` cannot give the side.
This is placement only; in-page placement defaults left.
How the port checks a claimed window is in [§4](04-store-and-transport.md).
The architecture test budgets one occurrence per file; neither read grants access to remote or domain state.
