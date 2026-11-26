import { describe, expect, it } from 'vitest';

import type { BookmarkNode } from './bookmarks';
import {
  syncBookmarkTitlesFollowingPage,
  type BookmarkTitleSyncPorts,
} from './bookmarkTitleSync';

function node(
  id: string,
  title: string,
  parentId: string | undefined,
  extra: Partial<BookmarkNode> = {},
): BookmarkNode {
  return { id, index: 0, parentId, title, ...extra } as BookmarkNode;
}

function tree(bookmarks: BookmarkNode[], favourites: BookmarkNode[] = []) {
  return [node('0', '', undefined, {
    children: [node('1', 'Bookmarks bar', '0', {
      children: [node('2', 'hyper', '1', {
        children: [
          node('3', 'favourites', '2', { children: favourites }),
          node('4', 'spaces', '2', {
            children: [node('6', 'Work', '4', {
              children: [node('5', 'bookmarks {"hyper":{"spaceBookmarks":true,"spaceId":"6"}}', '6', {
                children: bookmarks,
              })],
            })],
          }),
        ],
      })],
    })],
  })];
}

const pageA = 'https://example.com/a';
const page = (id: string, title: string, url = pageA, parentId = '5') => node(id, title, parentId, { url });

/** Syncs `title` for `url` over `nodes`, reading `listed` as the tree, and answers the writes. */
async function sync(
  nodes: BookmarkNode[],
  title: string,
  backingId?: string,
  { listed = tree(nodes), url = pageA }: { listed?: BookmarkNode[]; url?: string } = {},
) {
  const updates: Array<{ id: string; title: string }> = [];
  const byId = new Map(nodes.map((entry) => [entry.id, entry]));
  const surface: BookmarkTitleSyncPorts = {
    get: (id) => Promise.resolve(byId.has(id) ? [byId.get(id)!] : []),
    getTree: () => Promise.resolve(listed),
    update: (id, changes) => {
      updates.push({ id, title: changes.title });
      return Promise.resolve(undefined);
    },
  };
  await syncBookmarkTitlesFollowingPage(surface, { title, url }, backingId);
  return updates;
}

describe('syncBookmarkTitlesFollowingPage', () => {
  it('retitles every bookmark pointing at the page', async () => {
    const updates = await sync([page('10', 'Old'), page('11', 'Also old'), page('12', 'Untouched', 'https://example.com/b')], 'New');

    expect(updates.map((update) => update.id).sort()).toEqual(['10', '11']);
    expect(updates.every((update) => update.title === 'New')).toBe(true);
  });

  const renamedBacking = page('10', 'Renamed {"isCustomName":true}');

  it('leaves the whole tree alone when the tab backing carries a custom name', async () => {
    await expect(sync([renamedBacking, page('11', 'Old')], 'Renamed', '10')).resolves.toEqual([]);
  });

  it('syncs the siblings but not the renamed backing itself', async () => {
    await expect(sync([renamedBacking, page('11', 'Old')], 'A different page title', '10'))
      .resolves.toEqual([{ id: '11', title: 'A different page title' }]);
  });

  it('does not take a linked bookmark name Hyper showed on the tab for the page title', async () => {
    const pageB = 'https://example.com/b';
    const nodes = [
      page('20', 'Team docs {"isCustomName":true}'),
      page('21', 'Old', pageB),
      page('10', 'Page {"hyper":{"tab":true,"linkedBookmarkId":"20"}}', pageB, '7'),
    ];

    await expect(sync(nodes, 'Team docs*', '10', { url: pageB })).resolves.toEqual([]);
  });

  it.each([
    ['ignores a page with no title', ['']],
    ['ignores the address or host the browser shows while a page sleeps or fails to load',
      ['example.com', 'example.com/a', pageA]],
  ])('%s', async (_name, titles) => {
    for (const title of titles) await expect(sync([page('10', 'Old')], title)).resolves.toEqual([]);
  });

  it('does nothing when the structure is missing', async () => {
    await expect(sync([], 'New', undefined, { listed: [node('0', '', undefined, { children: [] })] }))
      .resolves.toEqual([]);
  });

  it('skips a bookmark that was renamed between the tree read and the write', async () => {
    await expect(sync([renamedBacking], 'New', undefined, { listed: tree([page('10', 'Old')]) }))
      .resolves.toEqual([]);
  });
});
