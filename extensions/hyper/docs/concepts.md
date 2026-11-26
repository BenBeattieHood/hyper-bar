# Concept index

Each concept is stated in exactly one file, its owner.
Other files may name the concept in a sentence, but they link to the owner rather than restating its rules, so `grep` for the owner's file name finds every file that relies on it.
Before adding a rule, find its concept here and write it in the owner; if the concept is missing, add a row.
When a rule seems to belong in two places, split it by layer: the model spec owns state ownership and authority, build-spec owns product, UI and storage detail, and a decision owns only its choice, reason and cost.
A decision owns a concept outright only when no spec section states it; those rows below point at the decision.

Paths are relative to `docs/`.
`m` is `model/`, `b` is `build-spec/`, `d` is `decisions/`.

## Architecture and transport

| Concept | Owner |
| --- | --- |
| One model store in the worker, no domain store in views, rebuild on every start | [m/01](model/01-decision.md) |
| Why one model in the background | [d/01](decisions/01-one-model-in-the-background.md) |
| Build-spec pointer to the model contract (no rules of its own) | [b/23](build-spec/23-background-model-and-intent-contract.md) |
| Background entrypoint only wires; behaviour in one `lib` module per concern | [d/13](decisions/13-the-background-entrypoint-only-wires.md) |
| One-way flow, overlays, active-space hold, view-local state | [m/02](model/02-the-one-way-flow.md) |
| Snapshot contents, command status, tab disposition | [m/03](model/03-model-contents-and-authority.md) |
| Remote presence and indicator intents | [m/03](model/03-model-contents-and-authority.md) |
| Shared drag, worker side | [m/03](model/03-model-contents-and-authority.md) |
| Port roles, admission, `sender.tab`, in-page token check | [m/04](model/04-store-and-transport.md) |
| Reconnect, resend, listen-at-start, build mismatch notice | [m/04](model/04-store-and-transport.md) |
| Reconciler reads, per-tab throttling | [m/04](model/04-store-and-transport.md) |
| Intent table, payloads, `items` batches, `favouriteSlot` | [m/05](model/05-controller-inputs.md) |
| One intent per user choice, space-switch admission | [m/05](model/05-controller-inputs.md) |
| Admission, gesture-time permission requests, fences, lanes | [m/06](model/06-serialization-causation-and-failures.md) |
| Operation journal, kinds, proofs, recovery modules | [m/06](model/06-serialization-causation-and-failures.md) |
| Group ownership (session value and group, both directions) and recovery | [m/07](model/07-critical-event-policies.md) |
| Duplicate backings and copied-ownership collision | [m/07](model/07-critical-event-policies.md) |
| Sessions as installations, backing hand-over | [m/07](model/07-critical-event-policies.md) |
| Imports, metadata preservation, structure repair | [m/07](model/07-critical-event-policies.md) |
| Search pipeline, history cache, warm index, selection history | [m/08](model/08-search.md) |
| Acceptance coverage | [m/10](model/10-acceptance.md) |

## Storage

| Concept | Owner |
| --- | --- |
| Bookmark hierarchy, `Space` fields, backing identity, `tabIndex` | [b/05](build-spec/05-durable-bookmark-model.md) |
| Preferences, legacy migration, root-title writer | [b/05](build-spec/05-durable-bookmark-model.md) |
| Title metadata codec, space and backing metadata | [b/06](build-spec/06-metadata-codec-and-schemas.md) |
| `storage.local` and `storage.session` keys, installation ID, reinstall adoption | [b/07](build-spec/07-local-session-and-in-memory-state.md) |
| Canonical repair and compatibility | [b/08](build-spec/08-canonical-repair-and-compatibility.md) |
| URL, page and navigation identity | [b/09](build-spec/09-url-page-and-navigation-identity.md) |

## Tabs, spaces and windows

| Concept | Owner |
| --- | --- |
| Backing lifecycle, close, cleanup journal, parked backings | [b/10](build-spec/10-exact-tab-backing-lifecycle.md) |
| Startup chain, browser start vs extension-only restart, restored-tab pairing | [b/11](build-spec/11-startup-restoration-and-race-control.md) |
| Window ID remapping gap | [debugging.md](debugging.md) |
| Space switching steps, focus before collapse | [b/12.1](build-spec/12-spaces-windows-and-activation.md) |
| Chromium groups presentation, colours, in-transit tab placement | [b/12.3](build-spec/12-spaces-windows-and-activation.md) |
| Space lifecycle: create, delete, duplicate, close all, reload, archive, menu | [b/12.5](build-spec/12-spaces-windows-and-activation.md) |
| Opening, reuse, Search activation targets | [b/13.1](build-spec/13-opening-reuse-and-deduplication.md) |
| Favourite destination space | [b/13.2](build-spec/13-opening-reuse-and-deduplication.md) |
| Deduplication, kept copies, duplicate detection | [b/13.4-13.6](build-spec/13-opening-reuse-and-deduplication.md) |
| Tab naming, bookmark links, drift, title placeholders | [b/14](build-spec/14-tab-naming.md) |
| Split views | [b/17.1](build-spec/17-tabs-tab-folders-and-media.md) |
| Tab strip order | [b/17.2](build-spec/17-tabs-tab-folders-and-media.md) |
| Now Playing and media access offers | [b/17.3](build-spec/17-tabs-tab-folders-and-media.md) |

## Sidebar and UI

| Concept | Owner |
| --- | --- |
| Product vocabulary | [b/02](build-spec/02-product-and-vocabulary.md) |
| Stack and project configuration | [b/03](build-spec/03-stack-and-project-configuration.md) |
| Production JavaScript not obfuscated | [d/36](decisions/36-production-javascript-is-not-obfuscated-for-now.md) |
| Side panel layout, header, pagination, archive | [b/15](build-spec/15-side-panel-layout.md) |
| Favourites bar, recent tabs, domain groups | [b/16](build-spec/16-favourites.md) |
| Bookmark trees, open-space indicators | [b/18](build-spec/18-bookmark-trees-and-indicators.md) |
| Selection scopes, row states, accessibility | [b/19](build-spec/19-selection-row-states-and-accessibility.md) |
| Keyboard-opened context menus anchor to their item | [d/40](decisions/40-a-menu-opened-from-the-keyboard-never-covers-its-item.md) |
| Cut, copy and paste: paste as a drop, clipboard formats, paste trust | [d/27](decisions/27-paste-is-a-drop-and-the-clipboard-is-untrusted.md) |
| Drag and drop matrix, held drag over a space | [b/20](build-spec/20-drag-and-drop-contract.md) |
| Drag between windows, sidebar side | [b/20.1](build-spec/20-drag-and-drop-contract.md) |
| Other sessions UI | [b/20.2](build-spec/20-drag-and-drop-contract.md) |
| Drags from outside Hyper | [b/20.3](build-spec/20-drag-and-drop-contract.md) |
| Search sources, ranking, UI, keys | [b/21](build-spec/21-search-new-tab-and-page-overlay.md) |
| Keyboard shortcut behaviour, modifiers and owners | [b/21](build-spec/21-search-new-tab-and-page-overlay.md#keyboard-shortcuts) |
| Shortcut registry and its readers | [d/49](decisions/49-shortcuts-come-from-one-registry.md) |
| Page Search overlay, in-page sidebar, new-tab host | [b/21.1-21.3](build-spec/21-search-new-tab-and-page-overlay.md) |
| Page content capture and privacy | [b/22](build-spec/22-optional-page-content-and-privacy.md) |
| Timed messages, undo | [b/27](build-spec/27-timed-messages.md) |

## Testing and debugging

| Concept | Owner |
| --- | --- |
| Architecture test and manifest test | [b/24](build-spec/24-test-requirements.md) |
| Limits no test covers | [debugging.md](debugging.md#limits-no-test-covers) |
| Diagnosing restore, activation and bookmark visibility | [debugging.md](debugging.md) |
| e2e build folder | [d/11](decisions/11-end-to-end-tests-build-into-their-own-folder.md) |

## Constraints on change

| Concept | Owner |
| --- | --- |
| Rejected designs that must not return without a new decision | [d/53](decisions/53-rejected-designs-stay-rejected.md) |
| Analytics proposal (nothing is collected today) | [analytics.md](analytics.md) |
