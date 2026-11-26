# 45. A space wears its tab group's colour

**Decision.** A space's colour is the colour its open tab groups wear, read live from the browser and stored nowhere else.
Hyper paints each of the nine tab group colours (`chrome.tabGroups.Color`) with the colour Edge paints a tab group in that colour, light and dark; the values in `style.css` were sampled from Edge screenshots for both appearances.
The model fills `Space.colour` from the groups each space owns (`liveSpaceColours` in `groupOwnership.ts`); a window's view prefers the space's group in that window, else one in another window.
A space with no open group has no colour and is drawn in the muted tone of the sidebar's icons.
A group Hyper creates takes the colour the space's groups already wear in other windows, else one derived from the space's ID, since a browser group needs a colour.
Every group a space owns, in every window, wears one colour (`spaceGroupColours.ts`, run from window maintenance).
A group that does not wear the colour Hyper last gave or saw on it was recoloured by the user in the browser, so its colour reaches the space's groups in other windows.
That last colour per group is kept in `storage.session` under `spaceGroupColours`, so it survives the service worker sleeping but not a browser restart.

**Why.** Hyper's space colours were once muted tones of its own, close to but never the same as the colours the browser paints its groups, and with no dark variant at all; matching the rendered values fixed that.
A later version kept the colour on the space folder title as `hyper.colour` and made the space the authority, recolouring groups to match.
That left two copies of one fact, and they drifted: groups the browser restored, groups recreated or adopted, and groups Hyper could not recolour showed one colour in the tab strip while the sidebar showed another.
Reading the colour only from the groups makes a mismatch impossible by construction, because there is nothing else to disagree with.
Drawing a space without a group in a neutral tone, rather than inventing one, keeps every colour Hyper shows one the user can see in the tab strip.
Allowing any colour and mapping it to the nearest group colour was rejected: the group and the space would still differ by design, and the mapping would need tuning per browser.
Reading live state after its own writes keeps a stale model read from mistaking a group still being recoloured for the user's choice.
Earlier versions' `hyper.colour` is removed from space folder titles by the colour pass's first run.

**Cost.** A space's colour does not survive all its groups closing, or travel to another machine through sync; a group it opens later takes the ID's colour.
Edge's palette is what Hyper matches; it differs from Chromium's, so the colour names in the API do not always match the hues they suggest.
The dark palette follows the colour scheme, not the browser's own theme, so a light browser theme on a dark system shows the dark tones.
When the user recolours a space's groups differently in two windows between passes, the first window's choice wins.
A recolour the browser refuses, as it does during a tab drag, is retried on the next model change.
Yellow and orange are light enough that the active space's label, which is drawn in its colour, has low contrast on the light theme, as the group title does in the tab strip.
