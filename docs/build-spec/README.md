# Hyper Build Specification

This spec states Hyper's exact product, UI and storage contracts: what the user sees, what each gesture does, and what is written where.
Each section names the source file that owns a behaviour; read that file for detail the spec does not repeat.
Where this spec and the [model spec](../model/README.md) disagree on which part of Hyper owns state, the model spec wins.

## Sections

- §2 [Product and Vocabulary](02-product-and-vocabulary.md)
- §3 [Stack and Project Configuration](03-stack-and-project-configuration.md)
- §5 [Durable Bookmark Model](05-durable-bookmark-model.md)
- §6 [Metadata Codec and Schemas](06-metadata-codec-and-schemas.md)
- §7 [Local, Session, and In-Memory State](07-local-session-and-in-memory-state.md)
- §8 [Canonical Repair and Compatibility](08-canonical-repair-and-compatibility.md)
- §9 [URL, Page, and Navigation Identity](09-url-page-and-navigation-identity.md)
- §10 [Exact Tab Backing Lifecycle](10-exact-tab-backing-lifecycle.md)
- §11 [Startup, Restoration, and Race Control](11-startup-restoration-and-race-control.md)
- §12 [Spaces, Windows, and Activation](12-spaces-windows-and-activation.md)
- §13 [Opening, Reuse, and Deduplication](13-opening-reuse-and-deduplication.md)
- §14 [Tab Naming](14-tab-naming.md)
- §15 [Side-Panel Layout](15-side-panel-layout.md)
- §16 [Favourites](16-favourites.md)
- §17 [Tabs, Tab Folders, and Media](17-tabs-tab-folders-and-media.md)
- §18 [Bookmark Trees and Indicators](18-bookmark-trees-and-indicators.md)
- §19 [Selection, Row States, and Accessibility](19-selection-row-states-and-accessibility.md)
- §20 [Drag and Drop Contract](20-drag-and-drop-contract.md)
- §21 [Search, New Tab, and Page Overlay](21-search-new-tab-and-page-overlay.md)
- §22 [Optional Page Content and Privacy](22-optional-page-content-and-privacy.md)
- §23 [Background Model and Intent Contract](23-background-model-and-intent-contract.md)
- §24 [Test Requirements](24-test-requirements.md)
- §27 [Timed Messages](27-timed-messages.md)
