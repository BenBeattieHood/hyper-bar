import { describe, expect, it } from 'vitest';
import { splitViewFolderBookmarkTitle, tabFolderBookmarkTitle } from './bookmarks';
import { createHyperModelStore, hyperModelAtom } from './model';
import type { SearchItem } from './search';
import { createSearchItemInterner, searchRecordsForWindow } from './searchProjection';
import { hyperBookmarkTree, spaceTabsFolder, testBacking } from './testBookmarkTree';
import { commitTestSources, testTab } from './testFixtures';

describe('window search records', () => {
  it('derives a window-scoped search record set from one committed revision', () => {
    const model = createHyperModelStore();
    commitTestSources(model, {
      extensionOrigin: 'chrome-extension://x/',
      tabs: [
        { id: 1, url: 'https://design.example', windowId: 7 } as Browser.tabs.Tab,
        { id: 2, url: 'https://other.example', windowId: 8 } as Browser.tabs.Tab,
        { id: 3, url: 'chrome-extension://x/newtab.html', windowId: 7 } as Browser.tabs.Tab,
      ],
      windows: [
        { id: 7, incognito: false } as Browser.windows.Window,
        { id: 8, incognito: false } as Browser.windows.Window,
      ],
    }, {
      activeSpaceIds: { 7: 'space-1' },
      historySearchItems: [{
        detail: 'History',
        id: 'history:1',
        kind: 'history',
        source: 'history',
        title: 'Design history',
        url: 'https://history.example/design',
      }],
      tabContents: {
        1: { navigationVersion: 0, text: 'Design document', url: 'https://design.example' },
      },
      tabContentVersions: { 1: 0 },
    });

    const records = searchRecordsForWindow(model.get(hyperModelAtom), 7);

    expect(records?.activeSpaceId).toBe('');
    expect(records?.items.map((item) => item.id)).toEqual(expect.arrayContaining([
      'tab:1',
      'history:1',
    ]));
    expect(records?.items.some((item) => item.id === 'tab:2')).toBe(false);
    expect(records?.items.some((item) => item.id === 'tab:3')).toBe(false);
    expect(records?.items.find((item) => item.id === 'tab:1')?.content)
      .toBe('Design document');
  });

  it('gives history records the favicon of an open tab showing the same page', () => {
    const history = (id: string, url: string) => ({
      detail: 'History',
      id,
      kind: 'history' as const,
      source: 'history' as const,
      title: id,
      url,
    });
    const model = createHyperModelStore();
    commitTestSources(model, {
      extensionOrigin: 'chrome-extension://x/',
      tabs: [
        { id: 1, favIconUrl: 'https://docs.example/icon.png', url: 'https://docs.example/page#top', windowId: 8 } as Browser.tabs.Tab,
        { id: 2, favIconUrl: 'https://secret.example/icon.png', incognito: true, url: 'https://secret.example/', windowId: 9 } as Browser.tabs.Tab,
      ],
      windows: [{ id: 7, incognito: false } as Browser.windows.Window],
    }, {
      historySearchItems: [
        history('history:1', 'https://docs.example/page'),
        history('history:2', 'https://secret.example/'),
        history('history:3', 'https://unopened.example/'),
      ],
    });

    const items = searchRecordsForWindow(model.get(hyperModelAtom), 7)?.items ?? [];
    const faviconFor = (id: string) => items.find((item) => item.id === id)?.faviconUrl;

    expect(faviconFor('history:1')).toBe('https://docs.example/icon.png');
    expect(faviconFor('history:2')).toBeUndefined();
    expect(faviconFor('history:3')).toBeUndefined();
  });

  it('names the tab folders that hold each tab, but not side-by-side pairs', () => {
    const tree = hyperBookmarkTree([{ id: 'space-1', title: 'Space 1', children: [spaceTabsFolder('space-1', [
      testBacking('loose', 'token-1'),
      { id: 'reviews', title: tabFolderBookmarkTitle('Reviews'), children: [
        testBacking('filed', 'token-2'),
        { id: 'today', title: tabFolderBookmarkTitle('Today'), children: [
          { id: 'pair', title: splitViewFolderBookmarkTitle(), children: [testBacking('paired', 'token-3')] },
        ] },
      ] },
    ])] }]);
    const model = createHyperModelStore();
    commitTestSources(model, {
      bookmarkTree: tree,
      extensionOrigin: 'chrome-extension://x/',
      tabs: [
        testTab({ id: 1, title: 'Loose page', url: 'https://example.com/loose', windowId: 7 }),
        testTab({ id: 2, title: 'Filed page', url: 'https://example.com/filed', windowId: 7 }),
        testTab({ id: 3, title: 'Paired page', url: 'https://example.com/paired', windowId: 7 }),
      ],
      windows: [{ id: 7, incognito: false, type: 'normal' } as Browser.windows.Window],
    }, {
      activeSpaceIds: { 7: 'space-1' },
      tabOwnerships: {
        1: { backingId: 'loose', backingToken: 'token-1', spaceId: 'space-1', windowId: 7 },
        2: { backingId: 'filed', backingToken: 'token-2', spaceId: 'space-1', windowId: 7 },
        3: { backingId: 'paired', backingToken: 'token-3', spaceId: 'space-1', windowId: 7 },
      },
    });

    const tabs = searchRecordsForWindow(model.get(hyperModelAtom), 7)?.items
      .filter((item) => item.kind === 'tab') ?? [];
    const foldersOf = (id: string) => tabs.find((item) => item.id === id)?.folders;

    expect(foldersOf('tab:1')).toBeUndefined();
    expect(foldersOf('tab:2')).toEqual(['Reviews']);
    expect(foldersOf('tab:3')).toEqual(['Reviews', 'Today']);
  });
});

describe('search item interner', () => {
  const item = (id: string, title: string, overrides: Partial<SearchItem> = {}): SearchItem => ({
    detail: 'History',
    id,
    kind: 'history',
    source: 'history',
    title,
    ...overrides,
  });

  it('keeps unchanged records, and the whole list when nothing changed', () => {
    const intern = createSearchItemInterner();
    const first = intern([item('a', 'A', { folders: ['Work'] }), item('b', 'B')]);
    const same = intern([item('a', 'A', { folders: ['Work'] }), item('b', 'B')]);
    const changed = intern([item('a', 'A', { folders: ['Home'] }), item('b', 'B')]);

    expect(same).toBe(first);
    expect(changed).not.toBe(first);
    expect(changed[0]).not.toBe(first[0]);
    expect(changed[0]?.folders).toEqual(['Home']);
    expect(changed[1]).toBe(first[1]);
  });
});
