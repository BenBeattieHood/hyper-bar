import { describe, expect, it } from 'vitest';
import type { BookmarkNode, BrowserTab } from '../../lib/bookmarks';
import { testTab } from '../../lib/testFixtures';
import { activeTabRows } from './activeTabReveal';

const node = (id: string, parentId: string, title: string, url?: string, children?: BookmarkNode[]) =>
  ({ id, parentId, syncing: false, title, ...(url ? { url } : {}), ...(children ? { children } : {}) }) as BookmarkNode;

const guideUrl = 'https://reveal.test/guide';
// Tabs: one, Reading/ (Later/ (two))
const tabNodes = [
  node('b1', 'tabs-root', 'One', 'https://reveal.test/one'),
  node('reading', 'tabs-root', 'Reading', undefined, [
    node('later', 'reading', 'Later', undefined, [node('b2', 'later', 'Two', guideUrl)]),
  ]),
];
const tabsByNodeId: Record<string, BrowserTab> = {
  b1: testTab({ id: 1, url: 'https://reveal.test/one' }),
  b2: testTab({ id: 2, url: guideUrl }),
};
// Bookmarks: Guide (loose), Docs/ (Guide)
const bookmarkNodes = [
  node('loose', 'bookmarks-root', 'Guide', guideUrl),
  node('docs', 'bookmarks-root', 'Docs', undefined, [node('guide', 'docs', 'Guide', guideUrl)]),
];
const surroundings = {
  bookmarks: { nodes: bookmarkNodes, rootId: 'bookmarks-root' },
  tabs: { nodes: tabNodes, rootId: 'tabs-root', tabsByNodeId },
};

describe('where the active tab shows', () => {
  it('finds its tab row and the first bookmark for its page, with the folders above each', () => {
    expect(activeTabRows({ ...surroundings, activeTab: { id: 2, url: guideUrl } })).toEqual([
      { folderIds: ['reading', 'later'], nodeId: 'b2', pane: 'tabs' },
      { folderIds: [], nodeId: 'loose', pane: 'bookmarks' },
    ]);
  });

  it('prefers the bookmark the tab is linked to', () => {
    expect(activeTabRows({ ...surroundings, activeTab: { id: 2, url: guideUrl }, linkedBookmarkId: 'guide' }))
      .toContainEqual({ folderIds: ['docs'], nodeId: 'guide', pane: 'bookmarks' });
  });

  it('finds nothing for a tab no pane shows', () => {
    expect(activeTabRows({ ...surroundings, activeTab: { id: 9, url: 'https://reveal.test/none' } })).toEqual([]);
    expect(activeTabRows({ ...surroundings, activeTab: { url: guideUrl } })).toEqual([]);
  });
});
