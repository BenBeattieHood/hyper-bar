import { describe, expect, it } from 'vitest';
import {
  createHyperModelStore,
  hyperModelAtom,
  hyperRevisionAtom,
  modelTabTitles,
  spacesAtom,
} from './model';
import { hyperBookmarkTree, spaceTabsFolder, testBacking } from './testBookmarkTree';
import { commitTestSources, testTab } from './testFixtures';

describe('Hyper model store', () => {
  it('commits browser and runtime sources as one incrementing snapshot', () => {
    const model = createHyperModelStore();
    const revisions: number[] = [];
    const unsubscribe = model.sub(hyperModelAtom, () =>
      revisions.push(model.get(hyperRevisionAtom)));

    const snapshot = commitTestSources(model, { focusedWindowId: 9 }, {
      activeSpaceIds: { 9: 'space-1' },
      bookmarkImportActiveCount: 1,
      historySearchItems: [{
        detail: 'History',
        id: 'history:1',
        kind: 'history',
        source: 'history',
        title: 'Design notes',
      }],
    });

    expect(revisions).toEqual([1]);
    expect(snapshot).toMatchObject({
      revision: 1,
      browser: { focusedWindowId: 9 },
      runtime: {
        activeSpaceIds: { 9: 'space-1' },
        bookmarkImportActiveCount: 1,
        historySearchItems: [{ id: 'history:1', title: 'Design notes' }],
      },
      hyper: { spaces: [] },
    });
    expect(model.get(hyperModelAtom)).toBe(snapshot);
    expect(model.get(spacesAtom)).toEqual([]);

    unsubscribe();
  });

  it('owns tabs by the backings each space keeps, and calls each by the title its backing keeps', () => {
    const tree = hyperBookmarkTree([{ id: 'space-1', title: 'Space 1', children: [spaceTabsFolder('space-1', [
      testBacking('direct', 'token-1'),
      {
        id: 'folder',
        title: `Folder ${JSON.stringify({ hyper: { tabFolder: true } })}`,
        children: [testBacking('nested', 'token-2')],
      },
    ])] }]);
    const snapshot = commitTestSources(createHyperModelStore(), {
      bookmarkTree: tree,
      tabs: [
        testTab({ id: 1, title: 'example.com', url: 'https://example.com/direct', windowId: 9 }),
        testTab({ id: 2, title: 'Nested live', url: 'https://example.com/nested', windowId: 9 }),
      ],
      windows: [{ id: 9, incognito: false, type: 'normal' } as Browser.windows.Window],
    }, {
      tabOwnerships: {
        1: { backingId: 'direct', backingToken: 'token-1', spaceId: 'space-1', windowId: 9 },
        2: { backingId: 'nested', backingToken: 'token-2', spaceId: 'space-1', windowId: 9 },
      },
    });

    expect([...snapshot.derived.tabDispositions]).toEqual([
      [1, { backingId: 'direct', spaceId: 'space-1', status: 'owned' }],
      [2, { backingId: 'nested', spaceId: 'space-1', status: 'owned' }],
    ]);
    expect(Object.fromEntries(snapshot.derived.tabTitles)).toEqual({ 1: 'Page', 2: 'Page' });
    expect(Object.fromEntries(snapshot.derived.tabPageTitles)).toEqual({ 1: 'Page', 2: 'Page' });
    expect(modelTabTitles(snapshot, 1, 'https://example.com/direct')).toEqual({ pageTitle: 'Page' });
    expect(modelTabTitles(snapshot, 1, 'https://example.com/elsewhere')).toEqual({});
  });

  it('gives a bookmark made from a tab the name the tab shows, even when its linked bookmark gave it', () => {
    const tree = hyperBookmarkTree([{ id: 'space-1', title: 'Space 1', children: [
      spaceTabsFolder('space-1', [{ ...testBacking('backing', 'token-1'), url: 'https://example.com/docs' }]),
      {
        id: 'bookmarks',
        title: `bookmarks ${JSON.stringify({ hyper: { spaceBookmarks: true, spaceId: 'space-1' } })}`,
        children: [{ id: 'named', title: 'Team docs {"isCustomName":true}', url: 'https://example.com/docs' }],
      },
    ] }]);
    const snapshot = commitTestSources(createHyperModelStore(), {
      bookmarkTree: tree,
      tabs: [testTab({ id: 1, title: 'Page', url: 'https://example.com/docs', windowId: 9 })],
      windows: [{ id: 9, incognito: false, type: 'normal' } as Browser.windows.Window],
    }, {
      tabOwnerships: { 1: { backingId: 'backing', backingToken: 'token-1', spaceId: 'space-1', windowId: 9 } },
    });

    expect(modelTabTitles(snapshot, 1, 'https://example.com/docs')).toEqual({ name: 'Team docs', pageTitle: 'Page' });
  });
});