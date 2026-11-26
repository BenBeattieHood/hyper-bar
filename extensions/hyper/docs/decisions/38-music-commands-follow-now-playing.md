# 38. Music commands follow Now Playing

**Decision.** Search's music commands do what Now Playing's controls do, to the tab Now Playing shows in that window.
`mediaCommands.ts` builds them for every Search surface, and `searchController` builds them for page Search from the committed model.
An id names the choice, such as `media:pause`, not the tab.
A command sends the intent Now Playing's control sends: `setTabMediaPlayback`, `setTabMuted`, or `activateTab` to switch.
`setTabMuted`, like `setTabMediaPlayback`, refuses a tab outside the sender's window.
The commands and when each is offered are in [build-spec §17.3](../build-spec/17-tabs-tab-folders-and-media.md) and [§21](../build-spec/21-search-new-tab-and-page-overlay.md).

**Why.** Now Playing already decides which tab is the music and what Hyper can do to it, so Search agrees with the footer instead of guessing again.
Offering only what can work keeps a command from failing for a reason the user cannot see, such as a page Hyper's script cannot reach, where muting still works.
A per-tab id made each new tab's command a stranger to Search's learning; one id per choice lets a picked "Pause music" rank first next time, whatever is playing.
Page Search runs in the page and holds no model, so the background, which does, contributes its commands, as it already does for spaces.

**Cost.** Only one tab per window gets music commands; other audible tabs are reached through their tab results.
Typing the music's title finds its tab rather than these commands, because Search scores a command by its label, keywords and shortcut, not its detail.
A recent pick of "Pause music" shows only while there is something to pause.
