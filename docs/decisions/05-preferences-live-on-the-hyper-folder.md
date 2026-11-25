# 5. Preferences live on the `hyper` folder

**Decision.** Every preference is saved on the `hyper` root folder's title, as `hyper {"hyper":{"preferences":{...}}}` (`preferences.ts`).
The list, the legacy move and the serialised writer are in [build-spec §5](../build-spec/05-durable-bookmark-model.md).
Only a preference the user has set is written.
A size the user drags is saved once, when the drag or key press ends, and the sidebar shows a change at once through the overlay held against its command.

**Why.** Preferences are part of a person's setup, so they belong with the rest of it (decision 4).
A size the user sets by dragging is a choice in the same way a toggle is, so it is kept; which folders happen to be open is not, and stays render state (decision 2).
Reading preferences from the bookmark tree also means the model gets them in the same read as the spaces they affect.
Running the move before the first read means no view, and no in-page sidebar, briefly sees the defaults.
Keys this version does not know are kept when writing, so an older Hyper on another device never erases a newer one's setting.

**Cost.** A preference change is a synced bookmark write, and writes run one at a time because each one reads and rewrites the same title.
