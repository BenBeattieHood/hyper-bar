import { describe, expect, it } from 'vitest';
import type { BookmarkNode } from './bookmarks';
import {
  buildSearchItems,
  highlightedTextSegments,
  urlMatch,
  urlSearchPresentation,
  type SearchItem,
} from './search';
import {
  recentSearchResults,
  searchResultPreferenceId,
  SharedSearchIndex,
  type SearchCommand,
  type SearchRequestRecords,
  type SharedSearchResult,
} from './searchIndex';
import {
  MAX_SEARCH_SELECTION_RESULT_ID_LENGTH,
  recordSearchSelection,
} from './searchSelection';
import { testTab } from './testFixtures';

const items: SearchItem[] = [
  {
    id: 'bookmark:1',
    kind: 'bookmark',
    source: 'current-space',
    title: 'Incident runbook',
    detail: 'Operations',
    url: 'https://example.com/runbook',
  },
  {
    id: 'bookmark:2',
    kind: 'bookmark',
    source: 'other-space',
    title: 'Design handbook',
    detail: 'Product',
    url: 'https://example.com/design',
  },
];

const resultId = (result: SharedSearchResult) =>
  result.kind === 'item' ? result.item.id : result.kind === 'command' ? result.commandId : result.target.kind;
const ids = (results: readonly SharedSearchResult[]) => results.map(resultId);

type BuildInput = Parameters<typeof buildSearchItems>[0];
const build = (input: Partial<BuildInput>) => buildSearchItems({
  activeSpaceId: 'space-1',
  extensionOrigin: 'chrome-extension://hyper/',
  favourites: [],
  history: [],
  spaceTabs: [],
  spaces: [],
  tabContents: {},
  tabs: [],
  ...input,
});
const node = (id: string, parentId: string, title: string, extra: { children?: BookmarkNode[]; url?: string } = {}) =>
  ({ id, parentId, title, index: 0, syncing: false, ...extra }) as BookmarkNode;
const link = (id: string, parentId: string, title: string, url: string) => node(id, parentId, title, { url });
const folder = (id: string, parentId: string, title: string, children: BookmarkNode[]) =>
  node(id, parentId, title, { children });
const space = (id: string, title: string, index = 0, children: BookmarkNode[] = []) =>
  ({ id, rootId: id, title, index, children });

describe('buildSearchItems', () => {
  it('finds mortem across favourites, space bookmarks, tabs, and history', () => {
    const spaceTab = testTab({
      id: 7,
      index: 2,
      windowId: 1,
      groupId: 4,
      title: 'Pre mortem notes',
      url: 'https://example.com/notes',
    });
    const built = build({
      favourites: [link('favourite-mortem', 'favourites', 'Pre mortem checklist', 'https://example.com/checklist')],
      localBookmarksBySpaceId: {
        'space-1': [folder('current-folder', 'space-1', 'Reviews', [
          link('tree-mortem', 'current-folder', 'Pre-mortem template', 'https://example.com/template'),
        ])],
        'space-2': [folder('other-folder', 'space-2', 'Records', [
          link('other-tree-mortem', 'other-folder', 'Post mortem archive', 'https://example.com/archive'),
        ])],
      },
      spaces: [space('space-1', 'Operations'), space('space-2', 'Archive', 1)],
      tabs: [spaceTab],
      spaceTabs: [spaceTab],
      tabSpaceIds: { 7: 'space-1' },
      history: [{
        id: 'history-mortem',
        title: 'Pre mortem review',
        url: 'https://example.com/review',
        lastVisitTime: 1,
        visitCount: 1,
        typedCount: 0,
      }],
    });

    expect(ids(queryIndex(new SharedSearchIndex(), built, 'mortem', 'space-1'))).toEqual([
      'bookmark:favourite-mortem',
      'tab:7',
      'bookmark:tree-mortem',
      'bookmark:other-tree-mortem',
      'history:history-mortem',
    ]);
    expect(built.find((item) => item.id === 'history:history-mortem')?.lastVisitTime).toBe(1);
  });

  it('finds global bookmarks and ranks them with the current space', () => {
    const global = { id: 'global', title: 'Global runbook', url: 'https://global.example.com' } as BookmarkNode;
    const built = build({ globalBookmarks: [{ id: 'folder', title: 'Ops', children: [global] } as BookmarkNode] });

    const match = built.find((item) => item.id === 'bookmark:global');
    expect(match).toMatchObject({ detail: 'Ops / Bookmarks', source: 'bookmark' });
    expect(match?.spaceId).toBeUndefined();
    expect(ids(queryIndex(new SharedSearchIndex(), built, 'runbook', 'space-1'))).toEqual(['bookmark:global']);
  });

  it('finds a tab by the name the user gave it', () => {
    const tab = testTab({ id: 4, title: 'Docs - Example', url: 'https://example.com/docs', windowId: 1 });
    const built = build({ spaceTabs: [tab], tabTitles: { 4: 'Team docs*' }, tabs: [tab] });

    expect(queryIndex(new SharedSearchIndex(), built, 'team', 'space-1').map((result) =>
      result.kind === 'item' ? result.item.title : result.commandId))
      .toEqual(['Team docs*']);
  });

  it('does not expose hidden tab-backing records from spaces', () => {
    const built = build({
      spaces: [space('space-1', 'Work', 0, [link(
        'backing-1',
        'space-1',
        'Secret draft {"hyper":{"tab":true,"tabToken":"one"}}',
        'https://example.com/secret',
      )])],
    });

    expect(queryIndex(new SharedSearchIndex(), built, 'secret', 'space-1')).toEqual([]);
  });

  it('indexes local bookmark descendants with their owning space', () => {
    const built = build({
      localBookmarksBySpaceId: { 'space-1': [folder('local-folder', 'space-1', 'Team docs', [
        link('local-bookmark', 'local-folder', 'Team runbook', 'https://example.com/runbook'),
      ])] },
      spaces: [space('space-1', 'Work')],
    });

    expect(built.map(({ id, source, spaceId }) => ({ id, source, spaceId })))
      .toEqual([
        { id: 'folder:local-folder', source: 'current-space', spaceId: 'space-1' },
        { id: 'bookmark:local-bookmark', source: 'current-space', spaceId: 'space-1' },
      ]);
  });

  it('records the folders that contain each bookmark and tab', () => {
    const report = link('report', 'metrics', 'Dashboard', 'https://example.com/d');
    const work = folder('work', 'space-1', 'Work', [folder('metrics', 'work', 'Metrics', [report])]);
    const tab = testTab({ id: 4, title: 'Review', url: 'https://example.com/review', windowId: 1 });
    const built = build({
      localBookmarksBySpaceId: { 'space-1': [work] },
      spaceTabs: [tab],
      spaces: [space('space-1', 'Home')],
      tabFolders: { 4: ['Reviews', 'Today'] },
      tabs: [tab],
    });

    expect(built.map(({ id, folders }) => ({ id, folders }))).toEqual([
      { id: 'folder:work', folders: undefined },
      { id: 'folder:metrics', folders: ['Work'] },
      { id: 'bookmark:report', folders: ['Work', 'Metrics'] },
      { id: expect.stringMatching(/^tab:/), folders: ['Reviews', 'Today'] },
    ]);
  });

  it('excludes space folders while retaining ordinary bookmark folders', () => {
    const built = build({
      localBookmarksBySpaceId: { 'space-1': [folder('references', 'bookmarks', 'References', [
        link('guide', 'references', 'Release guide', 'https://example.com/guide'),
      ])] },
      spaces: [space('space-1', 'Work')],
    });

    expect(built.map((item) => item.id)).toEqual([
      'folder:references',
      'bookmark:guide',
    ]);
    expect(built.some((item) => item.nodeId === 'space-1')).toBe(false);
  });

  it('groups matching tabs and orders their open spaces with the current space first', () => {
    const backing = (id: string, parentId: string) =>
      link(id, parentId, `Shared page {"hyper":{"tab":true,"tabToken":"${id}"}}`, 'https://example.com/shared');
    const tabs = [31, 32].map((id, index) => testTab({
      id,
      index,
      windowId: 1,
      groupId: index + 1,
      title: 'Shared page',
      url: 'https://example.com/shared',
      active: index === 0,
    }));
    const built = build({
      spaces: [
        space('space-a', 'First', 0, [backing('backing-a', 'space-a')]),
        space('space-b', 'Current', 1, [backing('backing-b', 'space-b')]),
      ],
      tabs,
      spaceTabs: tabs,
      tabContents: {
        31: 'current space content',
        32: 'other space content',
      },
      tabSpaceIds: {
        31: 'space-b',
        32: 'space-a',
      },
      activeSpaceId: 'space-b',
    });

    expect(built).toHaveLength(1);
    expect(built.filter((item) => item.kind === 'tab')).toEqual([
      expect.objectContaining({
        id: 'tab:31',
        openSpaces: [
          { id: 'space-b', title: 'Current', tabId: 31, windowId: 1 },
          { id: 'space-a', title: 'First', tabId: 32, windowId: 1 },
        ],
        content: 'current space content\nother space content',
      }),
    ]);
  });
});

describe('search result presentation', () => {
  it('highlights every visible query term without changing the text', () => {
    const segments = highlightedTextSegments('Incident response runbook', 'RUNBOOK incident');
    expect(segments.map((segment) => segment.text).join('')).toBe('Incident response runbook');
    expect(segments.filter((segment) => segment.matched).map((segment) => segment.text))
      .toEqual(['Incident', 'runbook']);
  });

  it('keeps URLs with early matches in their natural reading order', () => {
    expect(urlSearchPresentation('https://runbook.example.com/reference', 'runbook'))
      .toEqual({ recentered: false, text: 'https://runbook.example.com/reference' });
  });

  it('uses a middle ellipsis to expose deep URL matches', () => {
    expect(urlSearchPresentation(
      'https://example.com/a/very/long/path/to/incident-runbook/reference',
      'runbook',
    )).toEqual({
      recentered: true,
      prefix: 'https://example.com/…/',
      match: 'runbook',
      suffix: '/reference',
    });
  });

  it('uses a leading ellipsis when the URL origin is already long', () => {
    expect(urlSearchPresentation(
      'https://a-very-long-subdomain.example.com/reference/incident-runbook',
      'runbook',
    )).toMatchObject({ recentered: true, prefix: '…', match: 'runbook' });
  });
});

describe('URL matching', () => {
  it('needs the query unbroken or each of its words at a word start, never scattered letters', () => {
    expect(urlMatch('https://example.com/react-hooks', 'react hooks')).toBe(true);
    expect(urlMatch('https://github.com/netbank', 'netbank github')).toBe(true);
    expect(urlMatch('https://github.com/netbank', 'githubnetba')).toBe(false);
    expect(urlMatch('https://gir.example/affe', 'giraffe')).toBe(false);
    expect(urlMatch('https://github.com/nextjs/tbank', 'github netbank')).toBe(false);
  });
});

function searchIndexItem(
  id: string,
  title: string,
  source: SearchItem['source'],
  overrides: Partial<SearchItem> = {},
): SearchItem {
  return {
    id,
    title,
    detail: source,
    source,
    kind: source === 'history' ? 'history' : source === 'tab' ? 'tab' : 'bookmark',
    url: `https://${id}.example`,
    ...overrides,
  };
}

function queryIndex(
  index: SharedSearchIndex,
  items: SearchItem[],
  query: string,
  activeSpaceId: string,
  commands: SearchCommand[] = [],
  limit = 24,
  includeFolders = true,
) {
  return index.searchRequest({ commands, items }, query, activeSpaceId, limit, includeFolders);
}

/** The ids a fresh index ranks for `query` among `items`. */
function rank(items: SearchItem[], query: string, activeSpaceId = 'space-a', now?: () => number) {
  return ids(queryIndex(new SharedSearchIndex(now), items, query, activeSpaceId));
}

/** Ranks one request in space-a with the given selection history. */
function withHistory(
  index: SharedSearchIndex,
  request: SearchRequestRecords & { includeNavigation?: true },
  query: string,
  selectionHistory: Parameters<typeof recordSearchSelection>[0],
): SharedSearchResult[] {
  return index.searchRequest(request as SearchRequestRecords & { includeNavigation: true }, query, 'space-a', 24, true, selectionHistory);
}

describe('SharedSearchIndex', () => {
  const NOW = Date.UTC(2026, 9, 2, 12);
  const HOUR = 60 * 60 * 1000;

  it('finds prefixes and tolerant misspellings', () => {
    expect(rank(items, 'runb')).toContain('bookmark:1');
    expect(rank(items, 'incdent')).toContain('bookmark:1');
  });

  it('ranks a title match ahead of a match only in the detail', () => {
    const index = new SharedSearchIndex();
    const folder = searchIndexItem('folder:3', 'Operations', 'other-space', { kind: 'folder' });
    const favourite = searchIndexItem('bookmark:favourite', 'On-call guide', 'favourite', {
      detail: 'Operations',
    });
    const history = searchIndexItem('history:title', 'Operations', 'history');

    expect(ids(queryIndex(index, [...items, folder], 'operations', 'space-a'))[0])
      .toBe('folder:3');
    expect(ids(queryIndex(index, [favourite, history], 'operations', 'space-a')))
      .toEqual(['history:title', 'bookmark:favourite']);
  });

  it('weights recently visited history slightly within equally good matches', () => {
    const items = [
      searchIndexItem('history:old', 'Release notes', 'history', { lastVisitTime: NOW - 90 * 24 * HOUR }),
      searchIndexItem('history:recent', 'Release notes', 'history', { lastVisitTime: NOW - HOUR / 2 }),
      searchIndexItem('history:week', 'Release notes', 'history', { lastVisitTime: NOW - 3 * 24 * HOUR }),
    ];

    expect(rank(items, 'release', 'space-a', () => NOW))
      .toEqual(['history:recent', 'history:week', 'history:old']);
  });

  it('lends a recent visit to the tab or bookmark of that page instead of its history entry', () => {
    const items = [
      searchIndexItem('bookmark:quiet', 'Release notes', 'bookmark', { url: 'https://quiet.example/' }),
      searchIndexItem('bookmark:visited', 'Release notes', 'bookmark', { url: 'https://visited.example/' }),
      searchIndexItem('history:visited', 'Release notes', 'history', {
        lastVisitTime: NOW - HOUR / 2,
        url: 'https://visited.example/',
      }),
      searchIndexItem('history:other', 'Release notes', 'history', {
        lastVisitTime: NOW - 2 * 24 * HOUR,
        url: 'https://other.example/',
      }),
    ];

    expect(rank(items, 'release', 'space-a', () => NOW))
      .toEqual(['bookmark:visited', 'bookmark:quiet', 'history:other', 'history:visited']);
  });

  it('orders history by a blend of how well it matches and how recently it was visited', () => {
    const items = [
      searchIndexItem('history:recent-weak', 'Old release notes', 'history', { lastVisitTime: NOW - HOUR / 2 }),
      searchIndexItem('history:stale-strong', 'Release notes', 'history', { lastVisitTime: NOW - 90 * 24 * HOUR }),
      searchIndexItem('history:recent-strong', 'Release notes', 'history', { lastVisitTime: NOW - HOUR }),
    ];

    expect(rank(items, 'release', 'space-a', () => NOW))
      .toEqual(['history:recent-strong', 'history:recent-weak', 'history:stale-strong']);
  });

  it('requires fuzzy matches to account for every query character in order', () => {
    const items = [
      searchIndexItem('bookmark:my-prs', '[My PR]s', 'bookmark'),
      searchIndexItem('history:prometheus', '[Pr]ometheus', 'history'),
    ];

    expect(rank(items, 'My PR')).toEqual(['bookmark:my-prs']);
  });

  it('matches a query of several words only where every word is found', () => {
    const items = [
      searchIndexItem('bookmark:both', 'React hooks reference', 'bookmark'),
      searchIndexItem('tab:text-both', 'Docs home', 'tab', {
        content: 'Welcome to react. Read about the hooks of the framework',
      }),
      searchIndexItem('tab:text-one', 'Docs other', 'tab', {
        content: 'Welcome to react rendering. Go home or browse books for kids',
      }),
    ];

    expect(rank(items, 'react hooks')).toEqual(['bookmark:both', 'tab:text-both']);
  });

  it('returns bookmarks from every space with the active space first', () => {
    const items = [
      searchIndexItem('bookmark:work', 'Work runbook', 'current-space', {
        spaceId: 'space-work',
        localSpaceId: 'space-work',
      }),
      searchIndexItem('bookmark:home', 'Home runbook', 'other-space', {
        spaceId: 'space-home',
        localSpaceId: 'space-home',
      }),
    ];

    expect(rank(items, 'runbook', 'space-work')).toEqual(['bookmark:work', 'bookmark:home']);
    expect(rank(items, 'runbook', 'space-home')).toEqual(['bookmark:home', 'bookmark:work']);
  });

  it('ranks archived spaces\' bookmarks below every other space\'s', () => {
    const items = [
      searchIndexItem('bookmark:archived', 'Reference', 'other-space', {
        archived: true,
        localSpaceId: 'space-old',
        spaceId: 'space-old',
      }),
      searchIndexItem('bookmark:other', 'Reference', 'other-space', {
        localSpaceId: 'space-home',
        spaceId: 'space-home',
      }),
    ];

    expect(rank(items, 'reference', 'space-work'))
      .toEqual(['bookmark:other', 'bookmark:archived']);
  });

  it('ranks current-space bookmarks and folders before other spaces', () => {
    const items = [
      searchIndexItem('bookmark:other', 'Reference', 'other-space', {
        localSpaceId: 'space-home',
        spaceId: 'space-home',
      }),
      searchIndexItem('folder:other', 'Reference', 'other-space', {
        kind: 'folder',
        localSpaceId: 'space-home',
        spaceId: 'space-home',
      }),
      searchIndexItem('bookmark:current', 'Reference', 'current-space', {
        localSpaceId: 'space-work',
        spaceId: 'space-work',
      }),
      searchIndexItem('folder:current', 'Reference', 'current-space', {
        kind: 'folder',
        localSpaceId: 'space-work',
        spaceId: 'space-work',
      }),
    ];

    expect(rank(items, 'reference', 'space-work'))
      .toEqual([
        'bookmark:current',
        'folder:current',
        'bookmark:other',
        'folder:other',
      ]);
  });

  it('does not retain records between queries', () => {
    const index = new SharedSearchIndex();
    const first = [
      searchIndexItem('tab:1', 'Alpha dashboard', 'tab'),
    ];
    const second = [
      searchIndexItem('tab:2', 'Beta dashboard', 'tab'),
    ];

    expect(queryIndex(index, first, 'dashboard', 'space-a')).toEqual([{
      kind: 'item',
      item: searchIndexItem('tab:1', 'Alpha dashboard', 'tab'),
    }]);
    expect(queryIndex(index, second, 'dashboard', 'space-b')).toEqual([{
      kind: 'item',
      item: searchIndexItem('tab:2', 'Beta dashboard', 'tab'),
    }]);
    expect(queryIndex(index, [], 'dashboard', 'space-a')).toEqual([]);
  });

  it('ranks request records from committed selection history', () => {
    const index = new SharedSearchIndex();
    const first = searchIndexItem('bookmark:first', 'Design first', 'bookmark');
    const second = searchIndexItem('bookmark:second', 'Design second', 'bookmark');
    const selectionHistory = recordSearchSelection(
      {},
      'design',
      searchResultPreferenceId({ kind: 'item', item: second }),
      100,
    );

    expect(withHistory(index, { commands: [], items: [first, second] }, 'design', selectionHistory).map(resultId))
      .toEqual(['bookmark:second', 'bookmark:first']);
  });

  it('ranks navigation results from committed selection history', () => {
    const index = new SharedSearchIndex();
    const navigation = {
      kind: 'navigate' as const,
      target: {
        detail: 'Search',
        kind: 'search' as const,
        label: 'Search the web for “design”',
        query: 'design',
      },
    };
    let selectionHistory = {};
    for (let count = 0; count < 3; count += 1) {
      selectionHistory = recordSearchSelection(
        selectionHistory,
        'design',
        searchResultPreferenceId(navigation),
        count,
      );
    }

    expect(withHistory(index, {
      commands: [],
      includeNavigation: true,
      items: [
        searchIndexItem('bookmark:first', 'Design first', 'bookmark'),
        searchIndexItem('bookmark:second', 'Design second', 'bookmark'),
      ],
    }, 'design', selectionHistory).map((result) => result.kind)).toEqual(['navigate', 'item', 'item']);
  });

  it('uses bounded deterministic identifiers for long URL selections', () => {
    const first = searchIndexItem('bookmark:first', 'Long first', 'bookmark', {
      url: `https://example.test/${'a'.repeat(MAX_SEARCH_SELECTION_RESULT_ID_LENGTH)}`,
    });
    const second = searchIndexItem('bookmark:second', 'Long second', 'bookmark', {
      url: `https://example.test/${'b'.repeat(MAX_SEARCH_SELECTION_RESULT_ID_LENGTH)}`,
    });
    const firstId = searchResultPreferenceId({ kind: 'item', item: first });
    const secondId = searchResultPreferenceId({ kind: 'item', item: second });

    expect(firstId).toMatch(/^bookmark:/);
    expect(firstId).toHaveLength(MAX_SEARCH_SELECTION_RESULT_ID_LENGTH);
    expect(secondId).not.toBe(firstId);
    expect(recordSearchSelection({}, 'long', firstId, 100)).toEqual({
      long: { [firstId]: { count: 1, lastUsed: 100 } },
    });
  });

  it('returns commands and items in ranked order while projecting space membership', () => {
    const index = new SharedSearchIndex();
    const items = [
      searchIndexItem('space:active', 'Project Alpha', 'other-space', {
        detail: 'Project Alpha · other workspace',
        spaceId: 'space-a',
      }),
      searchIndexItem('space:other', 'Project Alpha notes', 'other-space', {
        spaceId: 'space-b',
      }),
      searchIndexItem('bookmark:alpha', 'An Alpha Project', 'bookmark'),
    ];
    const commands: SearchCommand[] = [{
      id: 'open-alpha',
      label: 'Project Alpha command',
      detail: 'Hyper',
      icon: 'space',
    }];

    expect(queryIndex(index, items, 'project alpha', 'space-a', commands)).toEqual([
      { kind: 'command', commandId: 'open-alpha' },
      {
        kind: 'item',
        item: searchIndexItem('space:active', 'Project Alpha', 'current-space', {
          detail: 'Project Alpha · current workspace',
          spaceId: 'space-a',
        }),
      },
      {
        kind: 'item',
        item: searchIndexItem('space:other', 'Project Alpha notes', 'other-space', {
          spaceId: 'space-b',
        }),
      },
      // Every word in the title, out of order, matches below the ordered titles.
      { kind: 'item', item: searchIndexItem('bookmark:alpha', 'An Alpha Project', 'bookmark') },
    ]);
  });

  it('does not retain client command descriptors', () => {
    const index = new SharedSearchIndex();
    const commands: SearchCommand[] = [{
      id: 'settings',
      label: 'Open settings',
      detail: 'Hyper',
      icon: 'settings',
    }];

    expect(queryIndex(index, [], 'settings', 'space-a', commands))
      .toEqual([{ kind: 'command', commandId: 'settings' }]);
    expect(queryIndex(index, [], 'settings', 'space-a')).toEqual([]);
  });

  it('prefers current-workspace tabs when title quality is tied', () => {
    const items = [
      searchIndexItem('tab:other', 'Incident guide', 'tab', {
        openSpaces: [{ id: 'space-b', title: 'Other' }],
      }),
      searchIndexItem('tab:current', 'Incident guide', 'tab', {
        openSpaces: [{ id: 'space-a', title: 'Current' }],
      }),
    ];

    expect(rank(items, 'incident')).toEqual(['tab:current', 'tab:other']);
  });

  it('ranks word-start titles, then history, then URL matches', () => {
    const index = new SharedSearchIndex();
    const items = [
      searchIndexItem('favourite:title', 'GitHub Netbank favourite', 'favourite'),
      searchIndexItem('bookmark:title', 'GitHub Netbank bookmark', 'bookmark'),
      searchIndexItem('favourite:url', 'Favourite URL', 'favourite', {
        url: 'https://github.com/netbank',
      }),
      searchIndexItem('bookmark:url', 'Bookmark URL', 'bookmark', {
        url: 'https://github.com/netbank',
      }),
      searchIndexItem('history:url', 'Visited page', 'history', {
        url: 'https://github.com/netbank',
      }),
      searchIndexItem('history:title', 'GitHub Netbank history', 'history', {
        url: 'https://example.com/visited',
      }),
      searchIndexItem('tab:current-title', 'GitHub Netbank current', 'tab', {
        openSpaces: [{ id: 'space-a', title: 'Current' }],
      }),
      searchIndexItem('tab:other-title', 'GitHub Netbank other', 'tab', {
        openSpaces: [{ id: 'space-b', title: 'Other' }],
      }),
      searchIndexItem('tab:current-url', 'Current URL', 'tab', {
        openSpaces: [{ id: 'space-a', title: 'Current' }],
        url: 'https://github.com/netbank',
      }),
      searchIndexItem('tab:other-url', 'Other URL', 'tab', {
        openSpaces: [{ id: 'space-b', title: 'Other' }],
        url: 'https://github.com/netbank',
      }),
      searchIndexItem('tab:weak-url', 'Weak URL', 'tab', {
        openSpaces: [{ id: 'space-a', title: 'Current' }],
        url: 'https://github.com/nextjs/tbank',
      }),
    ];
    const commands: SearchCommand[] = [{
      id: 'switch-command',
      label: 'Switch to Netbank',
      detail: 'Hyper',
      icon: 'space',
    }];

    expect(queryIndex(index, items, 'github netbank', 'space-a', commands).map(resultId).slice(0, 10))
      .toEqual([
        'favourite:title',
        'tab:current-title',
        'tab:other-title',
        'bookmark:title',
        'history:title',
        'favourite:url',
        'tab:current-url',
        'tab:other-url',
        'bookmark:url',
        'history:url',
      ]);
    expect(queryIndex(index, items, 'githubnetba', 'space-a', commands)).toEqual([]);
    expect(queryIndex(index, items, 'gith', 'space-a', commands).map(resultId))
      .toEqual([
        'favourite:title',
        'tab:current-title',
        'tab:other-title',
        'bookmark:title',
        'history:title',
        'favourite:url',
        'tab:current-url',
        'tab:weak-url',
        'tab:other-url',
        'bookmark:url',
        'history:url',
      ]);
  });

  it('only gives commands the command tier for matches beginning at a word', () => {
    const index = new SharedSearchIndex();
    const items = [
      searchIndexItem('tab:switch', 'Witch reference', 'tab', {
        openSpaces: [{ id: 'space-a', title: 'Current' }],
      }),
    ];
    const commands: SearchCommand[] = [{
      id: 'switch-command',
      label: 'Switch to Operations',
      detail: 'Hyper',
      icon: 'space',
    }];

    expect(queryIndex(index, items, 'switch', 'space-a', commands)[0])
      .toEqual({ kind: 'command', commandId: 'switch-command' });
    expect(queryIndex(index, items, 'witch', 'space-a', commands)[0])
      .toEqual({
        kind: 'item',
        item: searchIndexItem('tab:switch', 'Witch reference', 'tab', {
          openSpaces: [{ id: 'space-a', title: 'Current' }],
          source: 'current-space',
        }),
      });
  });

  it('filters folders before applying the result limit', () => {
    const index = new SharedSearchIndex();
    const items = [
      searchIndexItem('folder:one', 'Project folder one', 'bookmark', { kind: 'folder' }),
      searchIndexItem('folder:two', 'Project folder two', 'bookmark', { kind: 'folder' }),
      searchIndexItem('bookmark:one', 'Project page one', 'bookmark'),
      searchIndexItem('bookmark:two', 'Project page two', 'bookmark'),
    ];

    expect(queryIndex(index, items, 'project', 'space-a', [], 2, false).map(resultId))
      .toEqual(['bookmark:one', 'bookmark:two']);
  });

  it('uses request records for one query without retaining client descriptors', () => {
    const index = new SharedSearchIndex();

    expect(index.searchRequest({
      commands: [{ detail: 'Hyper', icon: 'settings', id: 'settings', label: 'Open settings' }],
      items: [
        searchIndexItem('bookmark:design', 'Design notes', 'bookmark'),
        searchIndexItem('tab:design', 'Design system', 'tab'),
      ],
    }, 'design', 'space-a').map(resultId)).toEqual(['tab:design', 'bookmark:design']);
    expect(queryIndex(index, [], 'settings', 'space-a')).toEqual([]);
  });

  it('fuzzy-matches a request-local command without storing it', () => {
    const index = new SharedSearchIndex();

    expect(index.searchRequest({
      commands: [{ detail: 'Hyper', icon: 'settings', id: 'settings', label: 'Open settings' }],
      items: [],
    }, 'opn setngs', 'space-a')).toEqual([{ kind: 'command', commandId: 'settings' }]);
  });
});
describe('search tiers', () => {
  const NOW = Date.UTC(2026, 9, 2, 12);
  const DAY = 24 * 60 * 60 * 1000;
  const resultIds = (results: readonly SharedSearchResult[]) => results.map((result) =>
    result.kind === 'item'
      ? result.item.id
      : result.kind === 'command' ? `command:${result.commandId}` : `navigate:${result.target.kind}`);
  const page = (
    id: string,
    title: string,
    source: SearchItem['source'],
    url: string,
    overrides: Partial<SearchItem> = {},
  ) => searchIndexItem(id, title, source, { url, ...overrides });

  it('ranks chosen, command, title, history, URL, then folder matches, never split URL matches', () => {
    const index = new SharedSearchIndex(() => NOW);
    const chosen = page('history:chosen', 'Quiet page', 'history', 'https://chosen.example/giraffe', {
      lastVisitTime: NOW - 300 * DAY,
    });
    const items = [
      page('bookmark:split', 'Split', 'bookmark', 'https://gir.example/affe'),
      page('bookmark:filed', 'Filed', 'bookmark', 'https://filed.example/', { detail: 'Giraffe notes / Work' }),
      page('bookmark:url', 'Address', 'bookmark', 'https://example.com/giraffe-crossing'),
      page('history:title', 'Giraffe facts', 'history', 'https://facts.example/', { lastVisitTime: NOW - DAY }),
      page('bookmark:title', 'Giraffe stripes', 'bookmark', 'https://stripes.example/'),
      chosen,
    ];
    const commands: SearchCommand[] = [{ detail: 'Hyper', icon: 'settings', id: 'giraffe', label: 'Giraffe mode' }];
    const selectionHistory = recordSearchSelection(
      {},
      'gir',
      searchResultPreferenceId({ kind: 'item', item: chosen }),
      NOW - DAY,
    );

    expect(resultIds(withHistory(index, { commands, items }, 'giraffe', selectionHistory))).toEqual([
      'history:chosen',
      'command:giraffe',
      'bookmark:title',
      'history:title',
      'bookmark:url',
      'bookmark:filed',
    ]);
  });

  it('lets an old pick for a dissimilar query only nudge, not outrank fresher matches', () => {
    const index = new SharedSearchIndex(() => NOW);
    const picked = page('history:picked', 'acme/no-mistakes • GitHub', 'history',
      'https://github.com/acme/no-mistakes', { lastVisitTime: NOW - 11 * DAY });
    const items = [
      picked,
      page('history:fresh', 'Pull requests • GitHub', 'history',
        'https://github.com/acme/app/pulls', { lastVisitTime: NOW - DAY }),
    ];
    const pickedId = searchResultPreferenceId({ kind: 'item', item: picked });
    const search = (query: string, pickedFor: string) => resultIds(withHistory(
      index, { commands: [], items }, query, recordSearchSelection({}, pickedFor, pickedId, NOW - 11 * DAY),
    ));

    expect(search('github', 'mistakes')).toEqual(['history:fresh', 'history:picked']);
    expect(search('github', 'git')).toEqual(['history:picked', 'history:fresh']);
  });

  it('sums the tiers a result matches, so several lower tiers can pass one higher tier', () => {
    const index = new SharedSearchIndex(() => NOW);
    const items = [
      page('history:title-only', 'Zebra facts', 'history', 'https://facts.example/', {
        lastVisitTime: NOW - 400 * DAY,
      }),
      page('bookmark:url-and-folder', 'Saved', 'bookmark', 'https://example.com/zebra', {
        detail: 'Zebra / Work',
      }),
      page('bookmark:url-only', 'Saved', 'bookmark', 'https://example.org/zebra'),
    ];

    expect(resultIds(queryIndex(index, items, 'zebra', 'space-a')))
      .toEqual(['bookmark:url-and-folder', 'history:title-only', 'bookmark:url-only']);
  });

  it('keeps a typed address first and lifts a chosen web search into the chosen tier', () => {
    const index = new SharedSearchIndex(() => NOW);
    const items = [page('bookmark:design', 'Design notes', 'bookmark', 'https://design.example/')];
    const webSearch = { kind: 'navigate' as const, target: {
      detail: 'Search', kind: 'search' as const, label: 'Search the web for “design”', query: 'design',
    } };
    const selectionHistory = recordSearchSelection({}, 'design', searchResultPreferenceId(webSearch), NOW);

    expect(resultIds(withHistory(index, { commands: [], includeNavigation: true, items }, 'design', selectionHistory)))
      .toEqual(['navigate:search', 'bookmark:design']);
    expect(resultIds(withHistory(
      index,
      { commands: [], includeNavigation: true, items },
      'design.example',
      recordSearchSelection({}, 'design.example', 'bookmark:https://design.example/', NOW),
    ))[0]).toBe('navigate:url');
  });

  it('keeps its text index warm across requests but answers only from the latest records', () => {
    const index = new SharedSearchIndex(() => NOW);
    const first = [page('bookmark:a', 'Alpha plan', 'bookmark', 'https://a.example/')];
    const renamed = [page('bookmark:a', 'Omega plan', 'bookmark', 'https://a.example/')];

    expect(resultIds(queryIndex(index, first, 'alp', 'space-a'))).toEqual(['bookmark:a']);
    expect(resultIds(queryIndex(index, renamed, 'alp', 'space-a'))).toEqual([]);
    expect(resultIds(queryIndex(index, renamed, 'ome', 'space-a'))).toEqual(['bookmark:a']);
    expect(resultIds(queryIndex(index, [], 'ome', 'space-a'))).toEqual([]);
  });
});

describe('containing folder matches', () => {
  const search = (items: SearchItem[], query: string) =>
    ids(queryIndex(new SharedSearchIndex(), items, query, 'space-a'));
  const dashboard = searchIndexItem('bookmark:dashboard', 'Dashboard', 'current-space', {
    detail: 'Work / Metrics / Home',
    folders: ['Work', 'Metrics'],
    spaceId: 'space-a',
    url: 'https://grafana.example/d/1',
  });

  it('matches a bookmark by a containing folder, alone or with its title', () => {
    expect(search([dashboard], 'work')).toEqual(['bookmark:dashboard']);
    expect(search([dashboard], 'metrics')).toEqual(['bookmark:dashboard']);
    expect(search([dashboard], 'metrics dashboard')).toEqual(['bookmark:dashboard']);
    expect(search([dashboard], 'dashboard metrics')).toEqual(['bookmark:dashboard']);
    expect(search([dashboard], 'work metrics')).toEqual(['bookmark:dashboard']);
  });

  it('requires every query word to begin a word of the title or a folder', () => {
    expect(search([dashboard], 'metrics budget')).toEqual([]);
    expect(search([dashboard], 'etrics dashboard')).toEqual([]);
  });

  it('matches a tab by the folders it sits in', () => {
    const tab = searchIndexItem('tab:7', 'Pull request 12', 'tab', {
      folders: ['Reviews'],
      url: 'https://git.example/pr/12',
    });

    expect(search([tab], 'reviews')).toEqual(['tab:7']);
    expect(search([tab], 'reviews pull')).toEqual(['tab:7']);
  });

  it('ranks a direct title match above a folder-only match', () => {
    const titled = searchIndexItem('bookmark:titled', 'Metrics overview', 'current-space', {
      detail: 'Reports / Home',
      folders: ['Reports'],
      spaceId: 'space-a',
      url: 'https://reports.example/',
    });
    const both = searchIndexItem('bookmark:both', 'Dashboard for metrics', 'current-space', {
      detail: 'Reports / Home',
      folders: ['Reports'],
      spaceId: 'space-a',
      url: 'https://both.example/',
    });

    expect(search([dashboard, titled], 'metrics')).toEqual(['bookmark:titled', 'bookmark:dashboard']);
    expect(search([dashboard, both], 'dashboard metrics')).toEqual(['bookmark:both', 'bookmark:dashboard']);
  });

  it('lets a space name complete a query but never earn the folder tier on its own', () => {
    const tab = searchIndexItem('tab:9', 'Roadmap', 'tab', {
      openSpaces: [{ id: 'space-b', title: 'Studio' }],
      url: 'https://plan.example/',
    });

    expect(search([dashboard, tab], 'studio')).toEqual([]);
    expect(search([dashboard, tab], 'home dashboard')).toEqual(['bookmark:dashboard']);
    expect(search([dashboard, tab], 'studio roadmap')).toEqual(['tab:9']);
  });

  it('does not treat favourites as filed in a folder', () => {
    const favourite = searchIndexItem('bookmark:favourite', 'Inbox', 'favourite', {
      detail: 'Favourites',
      url: 'https://mail.example/',
    });

    expect(search([favourite], 'favourites inbox')).toEqual([]);
  });
});

describe('recent search results', () => {
  const tab = searchIndexItem('tab:1', 'Inbox', 'tab', {
    openSpaces: [{ id: 'space-a', title: 'Work' }],
    url: 'https://mail.example/inbox',
  });
  const bookmark = searchIndexItem('bookmark:2', 'Docs', 'bookmark', { url: 'https://docs.example/' });
  const history = searchIndexItem('history:3', 'Docs history', 'history', { url: 'https://docs.example/' });
  const remember = (entries: Array<[string, string]>) => entries.reduce(
    (selections, [query, resultId], index) => recordSearchSelection(selections, query, resultId, index + 1),
    {},
  );

  it('lists the latest picks newest first, resolved against current records and marked as recent', () => {
    const selections = remember([
      ['docs', searchResultPreferenceId({ kind: 'item', item: bookmark })],
      ['set', 'command:settings'],
      ['inbox', searchResultPreferenceId({ kind: 'item', item: tab })],
      ['weather', 'navigate:search:weather'],
    ]);

    expect(recentSearchResults(
      { commandIds: new Set(['settings']), items: [tab, bookmark, history] },
      selections,
      'space-a',
    ).map((result) => [result.kind === 'item' ? result.item.id : searchResultPreferenceId(result), result.recent?.query]))
      .toEqual([
        ['navigate:search:weather', 'weather'],
        ['tab:1', 'inbox'],
        ['command:settings', 'set'],
        ['bookmark:2', 'docs'],
      ]);
  });

  it('falls back to the same page when the picked tab has closed, or to its address', () => {
    const closedTab = searchResultPreferenceId({ kind: 'item', item: { ...tab, url: 'https://docs.example/' } });
    const gone = 'tab:https://gone.example/page';
    const selections = remember([['gone', gone], ['docs', closedTab]]);

    const results = recentSearchResults({ commandIds: new Set(), items: [history, bookmark] }, selections, 'space-a');

    expect(results.map((result) => result.kind === 'item' ? result.item.id : result.kind)).toEqual(['bookmark:2', 'navigate']);
    expect(results[0]?.recent?.resultId).toBe(closedTab);
    expect(results[1]).toMatchObject({ kind: 'navigate', target: { kind: 'url', url: 'https://gone.example/page' } });
  });

  it('skips commands the view cannot run, shows each record once, and stops at the limit', () => {
    const selections = remember([
      ['a', 'command:unknown'],
      ['b', searchResultPreferenceId({ kind: 'item', item: history })],
      ['c', searchResultPreferenceId({ kind: 'item', item: bookmark })],
      ['d', 'navigate:search:one'],
      ['e', 'navigate:search:two'],
    ]);

    expect(recentSearchResults(
      { commandIds: new Set(), items: [bookmark, history], limit: 3 },
      selections,
      'space-a',
    ).map((result) => result.kind === 'item' ? result.item.id : searchResultPreferenceId(result)))
      .toEqual(['navigate:search:two', 'navigate:search:one', 'bookmark:2']);
  });
});
