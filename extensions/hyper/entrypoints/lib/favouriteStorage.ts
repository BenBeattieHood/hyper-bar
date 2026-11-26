import {
  shownSpaces,
  deriveSpaces,
  findHyperBookmarkStructure,
  planFavouriteSlotReplacement,
} from './bookmarks';
import { ensureHyperBookmarkStructure, ensureSpaceBookmarksFolder } from './bookmarkStorage';
import { getWindowActiveSpaceId } from './windowState';

/**
 * Files a bookmark into a favourite slot, displacing whatever held it.
 *
 * The slot is recorded in each favourite's title, so the plan renames several
 * siblings as well as moving the source. The background runs it inside its one
 * serialised mutation queue, so a reader can only ever observe the arrangement
 * before it or the arrangement after it.
 */
export async function setFavouriteSlot(
  bookmarkId: string,
  slotIndex: number,
  windowId: number,
): Promise<void> {
  await ensureHyperBookmarkStructure();
  const tree = await browser.bookmarks.getTree();
  const favouritesId = findHyperBookmarkStructure(tree)?.favourites.id;
  const spaces = shownSpaces(deriveSpaces(tree));
  const activeSpaceId = await getWindowActiveSpaceId(windowId);
  // A displaced favourite stays a bookmark, in the space the user is working in.
  const displacedSpaceId = (spaces.find((space) => space.id === activeSpaceId) ?? spaces[0])?.id;
  if (!favouritesId || !displacedSpaceId) {
    throw new Error('The Hyper favourites folder is unavailable.');
  }
  const [nodes, [source]] = await Promise.all([
    browser.bookmarks.getChildren(favouritesId),
    browser.bookmarks.get(bookmarkId),
  ]);
  if (!source?.url) throw new Error('Only a bookmark can hold a favourite slot.');
  const plan = planFavouriteSlotReplacement(nodes, source, slotIndex);
  if (plan.titleUpdates.length === 0) return;
  for (const update of plan.titleUpdates) {
    if (update.title !== update.node.title) {
      await browser.bookmarks.update(update.node.id, { title: update.title });
    }
  }
  if (plan.displaced) {
    const displacedRoot = await ensureSpaceBookmarksFolder(displacedSpaceId);
    await browser.bookmarks.move(plan.displaced.id, { parentId: displacedRoot.id });
  }
  if (source.parentId !== favouritesId) {
    await browser.bookmarks.move(source.id, { parentId: favouritesId });
  }
}
