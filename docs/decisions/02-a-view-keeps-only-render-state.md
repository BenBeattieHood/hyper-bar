# 2. A view keeps only render state

**Decision.** View state is limited to what the screen needs and the browser does not: folder open or closed, drag geometry, selection, menus, the in-page sidebar being open, animation direction.
Anything another view or a restart must agree on lives in the model and persists through it.

**Why.** State a view keeps instead of the model is a second authority.
It goes stale when the browser changes underneath it, and it is lost or diverges when a second view opens.
Render state has no such reader, so it can stay local.

**Cost.** Some UI reactions arrive one model revision later than a local `useState` would give them.
`useSpaceNavigation` (`sidepanel/hooks/useSpaceNavigation.ts`) therefore slides to whichever active space the model reports, working out the direction from the spaces' order.
Only a switch the sidebar asks for itself sets the direction ahead of the model, because only its own swipe knows it wrapped around.
