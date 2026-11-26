# 24. A new space takes the focused new tab page

**Decision.** Creating a space shows it with the full switch (decision 9), but asks it to take the window's focused tab when that is a new tab page (`takeNewTab` in `spaceSwitch.select`, `showNewSpace` in `windowSpaceChoice.ts`).
The tab moves into the new space and stays active.
Otherwise the space opens on a new tab.

**Why.** The full switch on its own opens a blank tab in the new space and disposes of the one left in the old space, so the new tab page the user was on would be replaced rather than moved.

**Cost.** Only creating a space takes the tab: switching to an existing empty space opens a new one.
