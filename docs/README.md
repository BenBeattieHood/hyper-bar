# Hyper docs

Each folder is split into one file per section.
Open the folder's index first and read only the sections the task needs.

| Folder | Question it answers | Read when |
| --- | --- | --- |
| [concepts.md](concepts.md) | Which single file owns each concept? Every concept is stated once in its owner and linked from elsewhere. | Before writing or changing any spec text, to find where it belongs. |
| [model/](model/README.md) | Who owns state, and how does it change? The background model, its projections and intents, and the rules that keep views from orchestrating. Where build-spec/ disagrees with it on state ownership, it wins. | Placing or moving any state, adding an intent, touching ports or projections. |
| [decisions/](decisions/README.md) | Why is it built this way? One entry per choice that shapes the code, with its reason and cost. Decision 53 lists designs that must not return. | Before a structural change; add an entry when making one. |
| [debugging.md](debugging.md) | Where do restore, activation and bookmark visibility bugs come from, and what can no test catch? | Debugging lifecycle, restore or backing bugs. |
| [build-spec/](build-spec/README.md) | What exactly does Hyper do? The product and UI contracts and the storage formats, in full detail. | Exact UI or interaction behaviour (layout, drag, selection, search, naming), or a storage format. |
| [analytics.md](analytics.md) | Which usage measures would matter if local analytics were ever added? A proposal only; nothing is collected. | Rarely. |
| [images/](images) | Reference images for UI specs. | Matching a visual spec. |
