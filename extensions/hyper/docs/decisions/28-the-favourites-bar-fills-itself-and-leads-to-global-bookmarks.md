# 28. The favourites bar fills itself and leads to global bookmarks

**Decision.** The favourites bar holds seven favourite slots and a global bookmarks button in the eighth place.
A favourite is a pinned bookmark in `hyper/favourites` and keeps its slot.
Every slot without a favourite shows one of this window's recent tabs, leaving out the music tabs the model projects as `backgroundMusicTabIds` while Now Playing is shown, so the view never classifies sites itself (`sidepanel/lib/favouriteBar.ts`).
Global bookmarks live in `hyper/bookmarks`, beside the spaces rather than in any of them, and the button opens them in place of the space's tabs and bookmarks.
Both kinds of tile, and the button, act through the same row menu and drop code as the tree.
The full behaviour, including how the recent order holds still under the pointer, is [build-spec §16](../build-spec/16-favourites.md).

**Why.** Empty slots were dead space for anyone who does not pin favourites, and recent tabs are the most likely next click.
A bookmark that belongs to no space had nowhere to live, and the eighth slot is the one place visible from every space.
Reusing the bookmark tree, the drop code and the row menus keeps one behaviour per gesture.

**Cost.** The bar holds seven favourites, not eight.
The recent tiles move as tabs are used, which the hold only softens.
The global panel replaces the space's view rather than sitting beside it, so a drag between a space's bookmarks and global bookmarks has to go through the button.
