import { bookmarkById } from './bookmarkStorage';
import { spaceBookmarkTitleWithLastActiveTabToken } from './bookmarks';
import { getTabOwnership } from './tabOwnership';
import { tabById } from './tabs';

export async function rememberActiveTab(tabId: number): Promise<void> {
  const tab = await tabById(tabId);
  if (!tab?.active || tab.incognito) return;
  const ownership = await getTabOwnership(tabId);
  if (!ownership?.backingToken) return;
  const spaceBookmark = await bookmarkById(ownership.spaceId);
  if (!spaceBookmark || spaceBookmark.url) return;
  const title = spaceBookmarkTitleWithLastActiveTabToken(
    spaceBookmark,
    ownership.backingToken,
    tab.windowId,
  );
  if (title !== spaceBookmark.title) await browser.bookmarks.update(spaceBookmark.id, { title });
}
