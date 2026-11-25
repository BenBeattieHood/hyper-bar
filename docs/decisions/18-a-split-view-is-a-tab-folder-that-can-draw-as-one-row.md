# 18. A split view is a tab folder that can draw as one row

**Decision.** Hyper keeps each split in the space's bookmarks as a split view folder: a tab folder marked `hyper.splitView` and titled `Side by side`, holding the split's backings in pane order.
Where the browser can show its tabs side by side, the folder draws as one row of panes (`splitViewRows`); anywhere else it draws as an ordinary tab folder.
Hyper creates and breaks splits only through the browser's own API (`splitTab` and `releaseDeparting` in `splitViewController.ts`), and `planSplitViews` keeps the folders and the browser in step.
The browser is the authority on what is split now, and the folder records what should be.
The full contract, including when a folder falls back and how the two are kept in step, is [build-spec §17.1](../build-spec/17-tabs-tab-folders-and-media.md).

**Why.** Hyper reopens tabs itself, after a restart and whenever a parked space opens, and a split kept only by the browser did not survive that.
Storing it with the backings it joins means it syncs and restores like the rest of the space.
Marking an ordinary tab folder, rather than inventing a new node kind, is what makes the fallback safe: anything that does not understand the mark, including a synced browser that cannot split tabs or an older Hyper, already shows and moves a tab folder correctly, and a folder that has outgrown a split stays visible as what it is instead of being reshaped.
A pair open apart is ambiguous, since Hyper may have just reopened it or the user may have just separated it, so the tabs seen split this browser session are kept in `storage.session` (`hyperSplitViewTabIds`): a seen tab apart was taken apart, an unseen one was reopened.
A split waits while any of its tabs is closed or a command is changing it, so closing a window, which closes its tabs, keeps its splits.

**Cost.** A split writes bookmarks, so splitting and unsplitting in the browser's UI churns synced bookmarks, and another device sees a `Side by side` folder appear and go.
A pair is only split again where all its tabs open in one window; Chrome splits two tabs, so a folder that grows to three stays a folder until the user trims it.
Losing `storage.session` while tabs stay open (an extension reload) forgets which tabs were seen split, so a pair the user had just taken apart, but whose folder was not yet dissolved, would be split again.
