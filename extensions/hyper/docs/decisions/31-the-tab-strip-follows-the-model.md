# 31. The tab strip follows the model

**Decision.** The browser's tab strip shows each space's tabs in the order of its Tabs list, which is the model's, and the background reorders the strip whenever that order changes.
A tab the user moves in the strip is first taken into the tab tree beside its new neighbours, and only then does the strip follow the model again.
The full contract is [build-spec §17.2](../build-spec/17-tabs-tab-folders-and-media.md).

**Why.** Before this, the strip was only ordered when a space was shown, so the list and the strip drifted apart and keyboard tab switching walked an order the user could not see.
Letting either side lead would make two authorities, so the strip is treated as an input, like any other browser event: the model interprets a strip move as a tree move, and the strip is always rendered from the result.
Every move Hyper makes heads toward the model's order, so taking a move into the tree changes nothing when its neighbours already match the list.
That lets every external tab move be taken in without telling the user's drags apart from Hyper's own.

**Cost.** A strip move the model cannot honour springs back, for example a tab dragged out of its site's autofolder, which the list gathers again.
A tab with no backing yet, such as a link that is still loading or a new tab page, keeps its strip place until it has one.
Reordering is one browser move per tab out of place, kept fewest by leaving the longest run already in order, and waits while the browser refuses edits during a drag.
