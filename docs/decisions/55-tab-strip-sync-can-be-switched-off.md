# 55. Tab strip sync can be switched off

**Decision.** A preference, `syncTabStripOrder`, on by default, gates [decision 31](31-the-tab-strip-follows-the-model.md) as a whole.
With it off, `tabStripOrderController.ts` neither moves strip tabs into list order nor takes the user's strip moves into the tab tree, and a space switch leaves restored tabs where the browser put them.
One switch covers both directions, because syncing in one direction only would let the strip and the list drift and then fight on the next sync.
A new tab still takes its backing from its strip place (build-spec §17.2), since that is placement at creation rather than sync.
A multi-tab drag in the list moves backed tabs as tree nodes, as a single-tab drag already did, instead of moving them in the strip and adopting the strip's order, which only lands right while the two match.

**Why.** Some users want the browser's tab strip to keep its own order, for example to keep keyboard tab switching in the order tabs were opened, while organising the list in Hyper.
The model stays the authority over the list either way; the switch only chooses whether the strip is one of its projections and inputs.

**Cost.** With sync off, keyboard tab switching walks an order the list does not show.
Turning sync back on makes the list win: the strip is reordered to the list, and strip moves made while it was off are not kept.
