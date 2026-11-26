# 9. Two ways to show a space

**Decision.** A switch requested by the sidebar, or to a space with parked tabs, runs the full `spaceSwitch.select`: reconcile groups, reopen parked tabs, open a blank tab in an empty space, and dispose of the previous space's spare new tabs.
A switch requested by the new tab page or page Search runs the lighter `activateSpaceFromSearch`: expand the space's group and focus one of its tabs, restoring the space's tabs only if none are open.
`switchTo` in `windowSpaceChoice.ts` chooses between them.

**Why.** The sidebar shows the space it switches to, so the window must end up matching what it shows.
Search surfaces only take the user to a space's tabs and show nothing of the space themselves.
Parked tabs reopen only through the full switch, so that path is used whichever view asked.

**Cost.** Showing a space has two implementations, so a change to what it means has to be made, or deliberately left out, in both `spaceSwitch.select` and `activateSpaceFromSearch`.
