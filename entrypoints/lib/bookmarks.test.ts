import { describe, expect, it } from 'vitest';
import {
  bookmarkableTabUrl,
  arrangeFavouriteSlots,
  bookmarkCount,
  bookmarkTitleFollowingPageTitle,
  bookmarkTitleUpdatesFollowingPageTitle,
  bookmarkTitleWithCustomName,
  bestTabFaviconUrl,
  bookmarkFolderIds,
  bookmarkFolderIdsContainingUrls,
  bookmarkFolderOptions,
  bookmarkNodeIdForPage,
  bookmarkTabStatus,
  bookmarkTitleWithFavouriteSlot,
  collectUniqueBookmarkUrls,
  containsNode,
  customBookmarkTitleMatches,
  descendantItemCount,
  deriveBookmarkState,
  deriveSpaces,
  deriveSpaceTabs,
  deriveWindowSpaceTabTree,
  findHyperBookmarkStructure,
  findEquivalentVisibleBookmark,
  findBookmarkPathByUrl,
  filterBookmarkTree,
  bookmarkNodesHaveUrl,
  favouriteSlot,
  foremostTabInWindow,
  indexTabSpacesByPageIdentity,
  indexTabsByPageIdentity,
  summariseBookmarkFolders,
  pageIsForemostInSpace,
  parseBookmarkTitle,
  overflowingFavourites,
  planFavouriteSlotReplacement,
  preferredActiveSpaceId,
  preferredSpaceForPage,
  openSpaceForPage,
  serializeBookmarkTitle,
  isTabBackingBookmark,
  isSplitViewFolder,
  isTabFolder,
  spaceBookmarkTitleWithLastActiveTabToken,
  spaceBookmarkTitleWithMigratedLastActiveTabWindowIds,
  spaceHasTabUrl,
  spaceBookmarkTitleWithoutColour,
  spaceLastActiveTabToken,
  splitViewFolderBookmarkTitle,
  tabBackingBookmarkTitle,
  tabBackingIndex,
  tabBackingInstallationId,
  tabBackingToken,
  tabBackingWindowId,
  tabFolderBookmarkTitle,
  tabSpaceId,
  visibleBookmarkTitle,
  withoutBookmarkNode,
  type BookmarkNode,
} from './bookmarks';
import { testTab } from './testFixtures';
import { testBookmark as bookmark, testFolder as folder } from './testBookmarkTree';
import { pageIdentity } from './urlIdentity';

/** A browser tree whose bookmarks bar holds any extra folders, then the Hyper folder. */
const hyperTree = (spaces: BookmarkNode[], favourites: BookmarkNode[] = [], barExtras: BookmarkNode[] = []) => [
  folder('0', '', undefined, [folder('1', 'Bookmarks bar', '0', [...barExtras, folder('2', 'hyper', '1', [
    folder('3', 'favourites', '2', favourites),
    folder('4', 'spaces', '2', spaces),
  ])])]),
];

const tab = (
  id: number,
  url: string,
  windowId = 1,
  groupId = -1,
): Browser.tabs.Tab => testTab({
  id,
  url,
  title: url,
  index: id,
  windowId,
  groupId,
});

describe('bookmarkFolderIds', () => {
  it('collects every nested folder without including bookmarks', () => {
    const tree = [folder('parent', 'Parent', undefined, [
      bookmark('page', 'Page', 'https://example.com', 'parent'),
      folder('child', 'Child', 'parent', []),
    ])];

    expect(bookmarkFolderIds(tree)).toEqual(['parent', 'child']);
  });

  it('lists external folders while excluding a complete subtree', () => {
    const tree = [folder('root', '', undefined, [
      folder('toolbar', 'Bookmarks Bar', 'root', [
        folder('hyper', 'hyper', 'toolbar', [folder('inside', 'Inside', 'hyper', [])]),
        folder('recipes', 'Recipes', 'toolbar', []),
      ]),
    ])];

    expect(bookmarkFolderOptions(tree, new Set(['hyper']))).toEqual([
      { id: 'toolbar', title: 'Bookmarks Bar', path: 'Bookmarks Bar' },
      { id: 'recipes', title: 'Recipes', path: 'Bookmarks Bar / Recipes' },
    ]);
  });

  it('does not expose Firefox separators as importable folders', () => {
    const separator = {
      id: 'separator',
      title: '',
      parentId: 'toolbar',
      type: 'separator',
      syncing: false,
    } as BookmarkNode & { type: 'separator' };
    const tree = [folder('root', '', undefined, [
      folder('toolbar', 'Bookmarks Bar', 'root', [separator]),
    ])];

    expect(bookmarkFolderIds(tree)).toEqual(['root', 'toolbar']);
    expect(bookmarkFolderOptions(tree, new Set())).toEqual([
      { id: 'toolbar', title: 'Bookmarks Bar', path: 'Bookmarks Bar' },
    ]);
  });
});

describe('bookmarkFolderIdsContainingUrls', () => {
  it('collects every ancestor branch containing an open duplicate URL', () => {
    const tree = [
      folder('first', 'First', undefined, [
        folder('nested', 'Nested', 'first', [
          bookmark('one', 'One', 'https://example.com/page?copy=1', 'nested'),
        ]),
      ]),
      folder('second', 'Second', undefined, [
        bookmark('two', 'Two', 'https://example.com/page?copy=2', 'second'),
      ]),
      folder('closed', 'Closed', undefined, [
        bookmark('other', 'Other', 'https://other.example.com', 'closed'),
      ]),
    ];

    expect(bookmarkFolderIdsContainingUrls(tree, ['https://example.com/page?current=1'])).toEqual(['first', 'nested', 'second']);
  });
});

describe('bookmarkNodesHaveUrl', () => {
  it('finds equivalent bookmarks among a folder direct children only', () => {
    const direct = bookmark('direct', 'Documentation', 'https://example.com/docs?tab=api', 'folder');
    const nested = folder('nested', 'Nested', 'folder', [
      bookmark('nested-doc', 'Nested documentation', 'https://example.com/nested', 'nested'),
    ]);
    const target = folder('folder', 'Folder', undefined, [direct, nested]);

    expect(bookmarkNodesHaveUrl(target.children ?? [], 'https://example.com/docs#install')).toBe(true);
    expect(bookmarkNodesHaveUrl(target.children ?? [], 'https://example.com/nested'))
      .toBe(false);
  });
});

describe('preferredSpaceForPage', () => {
  const spaces = [{ id: 'left' }, { id: 'active' }, { id: 'right' }];
  const identity = pageIdentity('https://example.com/docs')!;

  it("keeps different Google searches out of each other's space indicators", () => {
    const iconSearch = tab(1, 'https://www.google.com/search?q=icon');
    const index = indexTabSpacesByPageIdentity([iconSearch], { 1: 'left' });

    expect(spaceHasTabUrl({
      id: 'left',
      rootId: 'left',
      title: 'Left',
      index: 0,
      children: [],
    }, 'https://www.google.com/search?q=figma', index)).toBe(false);
  });

  it.each([
    ['prefers an open tab in the active space', 'https://example.com/docs?view=print', ['left', 'active'], 'active'],
    ['chooses the first open space from left to right', 'https://example.com/docs#install', ['right', 'left'], 'left'],
    ['falls back to the active space when the page is not open', 'https://example.com/new', ['left'], 'active'],
  ])('%s', (_name, url, openIn, expected) => {
    expect(preferredSpaceForPage(url, 'active', spaces, new Map([[identity, new Set(openIn)]]))).toBe(expected);
  });
});

describe('openSpaceForPage', () => {
  const spaces = [{ id: 'left' }, { id: 'active' }, { id: 'right' }];
  const identity = pageIdentity('https://example.com/docs')!;
  const openIn = (...spaceIds: string[]) => new Map([[identity, new Set(spaceIds)]]);

  it.each([
    ['picks the active space when the page is open there', 'https://example.com/docs', ['right', 'active', 'left'], 'active'],
    ['otherwise picks the left-most space with the page open', 'https://example.com/docs', ['right', 'left'], 'left'],
    ['has no space for a page open nowhere', 'https://example.com/new', ['left'], undefined],
  ])('%s', (_name, url, open, expected) => {
    expect(openSpaceForPage(url, 'active', spaces, openIn(...open))).toBe(expected);
  });
});

describe('preferredActiveSpaceId', () => {
  const spaces = [{ id: 'first' }, { id: 'current' }, { id: 'stored' }];

  it.each([
    ['prefers a valid persisted space', spaces, 'stored', 'current', 'stored'],
    ['falls back to the current state when the persisted space is stale', spaces, 'missing', 'current', 'current'],
    ['falls back to the first space when both candidates are stale', spaces, 'missing', 'also-missing', 'first'],
    ['returns null when no space exists', [], 'stored', 'current', null],
  ])('%s', (_name, candidates, stored, current, expected) => {
    expect(preferredActiveSpaceId(candidates, stored, current)).toBe(expected);
  });
});

describe('bookmark title metadata', () => {
  it('omits empty metadata from bookmark titles', () => {
    expect(serializeBookmarkTitle('My Bookmark', {})).toBe('My Bookmark');
    expect(serializeBookmarkTitle('My Bookmark', { hyper: {} })).toBe('My Bookmark');
    expect(serializeBookmarkTitle('My Bookmark ', {
      hyper: { removed: undefined },
    })).toBe('My Bookmark');
  });

  it('preserves meaningful metadata while removing empty nested objects', () => {
    expect(serializeBookmarkTitle('My Bookmark', {
      future: {},
      hyper: { local: false, slot: 0, tags: [] },
    })).toBe('My Bookmark {"hyper":{"local":false,"slot":0,"tags":[]}}');
  });

  it('stores the last active tab token on a space without losing metadata', () => {
    const space = folder('space', serializeBookmarkTitle('Research', {
      future: 3,
      hyper: { retained: true },
    }), 'spaces', []);
    const title = spaceBookmarkTitleWithLastActiveTabToken(space, 'active-token');

    expect(parseBookmarkTitle(title)).toEqual({
      title: 'Research',
      metadata: {
        future: 3,
        hyper: { retained: true, lastActiveTabToken: 'active-token' },
      },
    });
    expect(spaceLastActiveTabToken({ title })).toBe('active-token');
  });

  it('keeps last active tab tokens separate by native window', () => {
    const firstWindowTitle = spaceBookmarkTitleWithLastActiveTabToken({ title: 'Research' }, 'first-token', 4);
    const secondWindowTitle = spaceBookmarkTitleWithLastActiveTabToken(
      { title: firstWindowTitle },
      'second-token',
      8,
    );

    expect(spaceLastActiveTabToken({ title: secondWindowTitle }, 4)).toBe('first-token');
    expect(spaceLastActiveTabToken({ title: secondWindowTitle }, 8)).toBe('second-token');
    expect(spaceLastActiveTabToken({ title: secondWindowTitle })).toBe('second-token');
  });

  it('removes a stored space colour and keeps the rest of its metadata', () => {
    const token = spaceBookmarkTitleWithLastActiveTabToken({ title: 'Research' }, 'active-token');
    const title = spaceBookmarkTitleWithoutColour({ title: token.replace('{"hyper":{', '{"hyper":{"colour":"purple",') });

    expect(title).toBe(token);
    expect(spaceBookmarkTitleWithoutColour({ title: 'Research {"hyper":{"colour":"magenta"}}' })).toBe('Research');
    expect(spaceBookmarkTitleWithoutColour({ title: 'Research' })).toBe('Research');
  });

  it('migrates native-window last active tokens after browser restoration', () => {
    const title = spaceBookmarkTitleWithLastActiveTabToken({ title: 'Research' }, 'active-token', 4);
    const migrated = spaceBookmarkTitleWithMigratedLastActiveTabWindowIds({ title }, new Map([[4, 12]]));

    expect(spaceLastActiveTabToken({ title: migrated }, 4)).toBeUndefined();
    expect(spaceLastActiveTabToken({ title: migrated }, 12)).toBe('active-token');
  });

  it('marks tab folders while preserving their visible title and unknown metadata', () => {
    const existing = serializeBookmarkTitle('Old title', {
      future: 3,
      hyper: { retained: true },
    });
    const title = tabFolderBookmarkTitle('Research', existing);

    expect(isTabFolder({ title, url: undefined })).toBe(true);
    expect(parseBookmarkTitle(title)).toEqual({
      title: 'Research',
      metadata: {
        future: 3,
        hyper: { retained: true, tabFolder: true },
      },
    });
  });

  it('marks split view folders as tab folders, so they fall back to folders', () => {
    const title = splitViewFolderBookmarkTitle();

    expect(isSplitViewFolder({ title, url: undefined })).toBe(true);
    expect(isTabFolder({ title, url: undefined })).toBe(true);
    expect(visibleBookmarkTitle({ title })).toBe('Side by side');
    expect(isSplitViewFolder({ title: tabFolderBookmarkTitle('Plain'), url: undefined })).toBe(false);
    expect(isSplitViewFolder({
      title: serializeBookmarkTitle('Loose', { hyper: { splitView: true } }),
      url: undefined,
    })).toBe(false);
    expect(isSplitViewFolder({ title: tabFolderBookmarkTitle('Renamed', title), url: undefined }))
      .toBe(true);
  });

  it('marks tab backing records without exposing their metadata as the title', () => {
    const title = tabBackingBookmarkTitle('Working draft', 3, 'tab-token');
    const node = bookmark('tab', title, 'https://example.com/draft', 'space');

    expect(title).toBe('Working draft {"hyper":{"tab":true,"tabIndex":3,"tabToken":"tab-token"}}');
    expect(tabBackingIndex({ title })).toBe(3);
    expect(tabBackingToken({ title })).toBe('tab-token');
    expect(isTabBackingBookmark(node)).toBe(true);
    expect(spaceHasTabUrl({
      id: 'space',
      rootId: 'space',
      title: 'Space',
      index: 0,
      children: [node],
    }, 'https://example.com/draft?mode=edit')).toBe(true);
  });

  it('stores native-window ownership on the backing record itself', () => {
    const title = tabBackingBookmarkTitle(
      'Working draft',
      3,
      'tab-token',
      'space',
      undefined,
      { windowId: 17, installationId: 'local-installation' },
    );

    expect(tabBackingWindowId({ title })).toBe(17);
    expect(tabBackingInstallationId({ title })).toBe('local-installation');
  });

  it('round-trips a visible title and trailing JSON without losing unknown keys', () => {
    const rawTitle = 'Research {notes} {"hyper":{"spaceKey":"work"},"future":3}';

    expect(parseBookmarkTitle(rawTitle)).toEqual({
      title: 'Research {notes}',
      metadata: { hyper: { spaceKey: 'work' }, future: 3 },
    });
    expect(serializeBookmarkTitle('Renamed', parseBookmarkTitle(rawTitle).metadata)).toBe(
      'Renamed {"hyper":{"spaceKey":"work"},"future":3}',
    );
  });

  it('leaves malformed JSON and unseparated braces visible', () => {
    expect(parseBookmarkTitle('Example {not-json}')).toEqual({
      title: 'Example {not-json}',
      metadata: {},
    });
    expect(parseBookmarkTitle('Example{"hidden":true}')).toEqual({
      title: 'Example{"hidden":true}',
      metadata: {},
    });
  });

  it('marks manual names as custom without losing existing metadata', () => {
    const node = bookmark(
      '1',
      'Original {"hyper":{"favouriteSlot":2},"future":3}',
      'https://example.com',
      'favourites',
    );

    expect(bookmarkTitleWithCustomName(node, 'My name')).toBe(
      'My name {"hyper":{"favouriteSlot":2},"future":3,"isCustomName":true}',
    );
  });

  it('recognizes only an exact custom title as a programmatic title echo', () => {
    const custom = { title: 'My name {"isCustomName":true}' };
    expect(customBookmarkTitleMatches(custom, 'My name')).toBe(true);
    expect(customBookmarkTitleMatches(custom, 'Another name')).toBe(false);
    expect(customBookmarkTitleMatches({ title: 'My name' }, 'My name')).toBe(false);
  });

  it('follows page titles only until a bookmark has a custom name', () => {
    const automatic = bookmark(
      '1',
      'Old title {"hyper":{"favouriteSlot":2}}',
      'https://example.com',
      'favourites',
    );
    const custom = {
      ...automatic,
      title: bookmarkTitleWithCustomName(automatic, 'My name'),
    };

    expect(bookmarkTitleFollowingPageTitle(automatic, 'New page title')).toBe(
      'New page title {"hyper":{"favouriteSlot":2}}',
    );
    expect(bookmarkTitleFollowingPageTitle(custom, 'Another title')).toBeUndefined();
    expect(bookmarkTitleFollowingPageTitle(automatic, 'Old title')).toBeUndefined();
  });

  it('updates only matching non-custom bookmarks for a changed page title', () => {
    const matching = bookmark(
      '1',
      'Old title {"hyper":{"favouriteSlot":2}}',
      'https://example.com/page?bookmark=1',
      'favourites',
    );
    const custom = {
      ...bookmark('2', 'Custom', 'https://example.com/page?bookmark=2', 'space'),
      title: 'Custom {"isCustomName":true}',
    };
    const other = bookmark('3', 'Other', 'https://example.com/other', 'space');

    expect(bookmarkTitleUpdatesFollowingPageTitle(
      [folder('root', 'Hyper', undefined, [matching, custom, other])],
      'https://example.com/page?tab=1',
      'New title',
    )).toEqual([{
      id: '1',
      title: 'New title {"hyper":{"favouriteSlot":2}}',
    }]);
  });
});

const favourite = (id: string, title: string, index?: number) =>
  bookmark(id, title, `https://${id}.test`, 'favourites', index);
/** `length` favourites in bar order, the one at `index` titled `title(index)`. */
const favouriteRow = (length: number, title: (index: number) => string = (index) => `Bookmark ${index}`) =>
  Array.from({ length }, (_, index) => favourite(String(index), title(index), index));

describe('favourite slots', () => {
  it('assigns and clears slots without losing other metadata', () => {
    const node = favourite('1', 'First {"hyper":{"favouriteSlot":3,"pinned":true},"other":"value"}');

    expect(bookmarkTitleWithFavouriteSlot(node, 5)).toBe(
      'First {"hyper":{"favouriteSlot":5,"pinned":true},"other":"value"}',
    );
    expect(bookmarkTitleWithFavouriteSlot(node)).toBe('First {"hyper":{"pinned":true},"other":"value"}');
  });

  it('pins legacy slots before replacing an occupied favourite', () => {
    const nodes = favouriteRow(7);
    const plan = planFavouriteSlotReplacement(nodes, nodes[0]!, 3);

    expect(plan.displaced).toBe(nodes[3]);
    expect(plan.titleUpdates.map(({ node, title }) => [node.id, favouriteSlot({
      ...node,
      title,
    })])).toEqual([
      ['1', 1],
      ['2', 2],
      ['4', 4],
      ['5', 5],
      ['6', 6],
      ['3', undefined],
      ['0', 3],
    ]);
  });

  it('preserves legacy bookmark order when no slots are stored', () => {
    const first = favourite('1', 'First');
    const second = favourite('2', 'Second');

    expect(arrangeFavouriteSlots([first, second]).slice(0, 3)).toEqual([
      first,
      second,
      undefined,
    ]);
  });

  it('keeps explicitly selected cells empty or occupied', () => {
    const first = favourite('1', 'First {"hyper":{"favouriteSlot":3}}');
    const second = favourite('2', 'Second');
    const slots = arrangeFavouriteSlots([first, second]);

    expect(slots[0]).toBe(second);
    expect(slots[1]).toBeUndefined();
    expect(slots[3]).toBe(first);
  });

  it('falls conflicting slots back to the first available cell', () => {
    const first = favourite('1', 'First {"hyper":{"favouriteSlot":2}}');
    const second = favourite('2', 'Second {"hyper":{"favouriteSlot":2}}');
    const slots = arrangeFavouriteSlots([first, second]);

    expect(slots[0]).toBe(second);
    expect(slots[2]).toBe(first);
  });

  it('honours an explicit slot beyond the first seven physical bookmarks', () => {
    const nodes = favouriteRow(8, (index) => index === 7 ? 'Eighth {"hyper":{"favouriteSlot":6}}' : `Bookmark ${index}`);

    expect(arrangeFavouriteSlots(nodes)[6]).toBe(nodes[7]);
  });

  it('overflows favourites beyond the bar, keeping those it can place', () => {
    const nodes = favouriteRow(9, (index) => index === 0 ? 'First {"hyper":{"favouriteSlot":7}}' : `Bookmark ${index}`);

    expect(overflowingFavourites(nodes).map((node) => node.id)).toEqual(['0', '8']);
  });
});

const workBookmarksTitle = serializeBookmarkTitle('bookmarks', { hyper: { spaceBookmarks: true, spaceId: '5' } });

describe('deriveSpaces', () => {
  it('uses the marked per-space bookmarks folder as the local root', () => {
    const localBookmark = bookmark('8', 'Runbook', 'https://work.example.com/runbook', '7');
    const bookmarks = folder('7', workBookmarksTitle, '5', [localBookmark]);
    const tree = hyperTree([folder('5', 'Work', '4', [bookmarks])]);

    expect(deriveSpaces(tree)[0]).toMatchObject({
      id: '5',
      rootId: '7',
      children: [localBookmark],
    });
    expect(deriveSpaces(tree)[0]).not.toHaveProperty('colour');
  });

  it('ignores a colour an earlier version kept on the space folder', () => {
    const tree = hyperTree([folder('5', 'Work {"hyper":{"colour":"orange"}}', '4', [])]);

    expect(deriveSpaces(tree)[0]).toMatchObject({ id: '5', title: 'Work' });
    expect(deriveSpaces(tree)[0]).not.toHaveProperty('colour');
  });

  it('flattens nested tab backings without exposing tabs or window folders', () => {
    const backing = bookmark('9', 'Example {"hyper":{"tab":true,"spaceId":"5"}}', 'https://example.com', '8');
    const tabs = folder(
      '7',
      'tabs {"hyper":{"spaceTabs":true,"spaceId":"5"}}',
      '5',
      [folder('8', '1 {"hyper":{"installationId":"local","windowId":1}}', '7', [backing])],
    );
    const tree = hyperTree([folder('5', 'Work', '4', [tabs])]);

    expect(deriveSpaces(tree)[0]?.children).toEqual([backing]);
  });

  it('does not treat an unmarked user folder named tabs as infrastructure', () => {
    const userTabs = folder('7', 'tabs', '6', [
      bookmark('8', 'Saved tab', 'https://saved.example.com', '7'),
    ]);
    const bookmarksRoot = folder('6', workBookmarksTitle, '5', [userTabs]);
    const tree = hyperTree([folder('5', 'Work', '4', [bookmarksRoot])]);

    expect(deriveSpaces(tree)[0]?.children).toEqual([userTabs]);
  });

  it('only projects the Hyper bookmark hierarchy', () => {
    const favourite = bookmark('6', 'Calendar', 'https://calendar.example.com', '3');
    const docs = bookmark('7', 'Docs', 'https://docs.example.com', '10');
    const bookmarksRoot = folder('10', workBookmarksTitle, '5', [docs]);
    const work = folder('5', 'Work', '4', [bookmarksRoot]);
    const unrelated = folder('8', 'Unrelated', '1', [
      bookmark('9', 'Other', 'https://other.example.com', '8'),
    ]);
    const tree = hyperTree([work], [favourite], [unrelated]);

    expect(deriveSpaces(tree)).toEqual([
      {
        id: '5',
        rootId: '10',
        title: 'Work',
        index: 0,
        children: [docs],
      },
    ]);
    expect(deriveBookmarkState(tree).favourites).toEqual([favourite]);
  });

  it('recognises hierarchy folders with hidden settings metadata', () => {
    const hyper = folder('2', 'hyper {"hyper":{"theme":"blush"}}', '1', [
      folder('3', 'favourites {"future":true}', '2', []),
      folder('4', 'spaces {"future":true}', '2', [folder('5', 'Work', '4', [])]),
    ]);
    const tree = [folder('0', '', undefined, [
      folder('1', 'Bookmarks bar', '0', [hyper]),
    ])];

    expect(findHyperBookmarkStructure(tree)?.hyper.id).toBe('2');
    expect(deriveSpaces(tree)[0]?.title).toBe('Work');
  });

  it('ignores a Hyper folder outside the resolved bookmarks bar', () => {
    const wrongHyper = folder('20', 'hyper', '2', [
      folder('21', 'favourites', '20', []),
      folder('22', 'spaces', '20', [folder('23', 'Wrong space', '22', [])]),
    ]);
    const tree = [folder('0', '', undefined, [
      folder('1', 'Bookmarks bar', '0', []),
      folder('2', 'Other bookmarks', '0', [wrongHyper]),
    ])];

    expect(findHyperBookmarkStructure(tree)).toBeNull();
    expect(deriveSpaces(tree)).toEqual([]);
  });
});

describe('deriveBookmarkState', () => {
  it('derives spaces, favourite slots, and the node index together', () => {
    const favourite = bookmark('6', 'Calendar', 'https://calendar.example.com', '3');
    const localChild = bookmark('9', 'Runbook', 'https://work.example.com/runbook', '8');
    const localFolder = folder('8', 'Work bookmarks', '13', [localChild]);
    const localBookmark = bookmark('11', 'Dashboard', 'https://work.example.com/dashboard', '13');
    const tabBacking = bookmark(
      '12',
      tabBackingBookmarkTitle('Open dashboard', 0, 'tab-token'),
      'https://work.example.com/open',
      '10',
    );
    const tabFolder = folder('7', tabFolderBookmarkTitle('Projects'), '5', []);
    const tabsRoot = folder(
      '10',
      serializeBookmarkTitle('tabs', { hyper: { spaceTabs: true } }),
      '5',
      [tabFolder, tabBacking],
    );
    const bookmarksRoot = folder('13', workBookmarksTitle, '5', [localFolder, localBookmark]);
    const work = folder('5', 'Work', '4', [
      tabsRoot,
      bookmarksRoot,
    ]);
    const tree = hyperTree([work], [favourite]);

    const state = deriveBookmarkState(tree);

    expect(state.spaces.map((space) => space.id)).toEqual(['5']);
    expect(state.favourites).toEqual([favourite]);
    expect(state.favouriteSlots[0]).toEqual(favourite);
    expect(state.localBookmarksBySpaceId['5']).toEqual([localFolder, localBookmark]);
    expect(state.localBookmarkSpaceIds).toEqual({ 8: '5', 9: '5', 11: '5' });
    expect(state.nodeMap.get('5')).toEqual(work);
  });
});

describe('findEquivalentVisibleBookmark', () => {
  it('ignores internal tab backings when checking bookmark duplicates', () => {
    const url = 'https://github.com/[REDACTED]-[REDACTED]/netbank-v2/pulls?q=is%3Apr+is%3Aopen';
    const backing = bookmark(
      'backing',
      tabBackingBookmarkTitle('Open pull requests', 0, 'tab-token'),
      url,
      'dev',
    );
    const closedPulls = bookmark(
      'closed',
      'Closed pull requests',
      'https://github.com/[REDACTED]-[REDACTED]/netbank-v2/pulls?q=is%3Apr+is%3Aclosed',
      'dev',
    );

    expect(findEquivalentVisibleBookmark([backing, closedPulls], url)).toBeUndefined();

    const visible = bookmark('visible', 'Open pull requests', url, 'dev');
    expect(findEquivalentVisibleBookmark([backing, closedPulls, visible], url))
      .toBe(visible);
  });
});

describe('withoutBookmarkNode', () => {
  it('removes a nested node while preserving unrelated branches', () => {
    const removed = folder('5', 'Removed', '4', []);
    const retained = folder('6', 'Retained', '4', []);
    const tree = [folder('4', 'Spaces', undefined, [removed, retained])];

    const next = withoutBookmarkNode(tree, removed.id);

    expect(next[0]!.children).toEqual([retained]);
    expect(next[0]).not.toBe(tree[0]);
    expect(withoutBookmarkNode(next, 'missing')).toBe(next);
  });
});

describe('bookmarkTabStatus', () => {
  it('indexes equivalent page URLs and reports active and sleeping tabs', () => {
    const activeTab = { ...tab(1, 'https://example.com/page?one=1'), active: true };
    const sleepingTab = { ...tab(2, 'https://example.com/page?two=2'), discarded: true };
    const frozenTab = { ...tab(3, 'https://frozen.example/page'), frozen: true };
    const index = indexTabsByPageIdentity([activeTab, sleepingTab]);

    expect(bookmarkTabStatus(index, 'https://example.com/page?bookmark=1')).toEqual({
      openTabs: [activeTab, sleepingTab],
      isSleeping: false,
      isActive: true,
    });
    expect(bookmarkTabStatus(indexTabsByPageIdentity([sleepingTab]), 'https://example.com/page').isSleeping).toBe(true);
    expect(bookmarkTabStatus(indexTabsByPageIdentity([frozenTab]), 'https://frozen.example/page').isSleeping).toBe(true);
  });

  it('summarises nested folders\' bookmark counts and open tabs in one pass', () => {
    const openTab = tab(1, 'https://example.com/page?tab=1');
    const openTabs = indexTabsByPageIdentity([openTab]);
    const nested = folder('nested', 'Nested', 'parent', [
      bookmark('match', 'Match', 'https://example.com/page?bookmark=1', 'nested'),
    ]);
    const parent = folder('parent', 'Parent', 'root', [nested]);
    const closed = folder('closed', 'Closed', 'root', [
      bookmark('other', 'Other', 'https://other.example', 'closed'),
    ]);

    const summaries = summariseBookmarkFolders([parent, nested, closed], openTabs);

    expect(summaries.get('parent')).toEqual({ bookmarkCount: 1, hasOpenTab: true });
    expect(summaries.get('nested')).toEqual({ bookmarkCount: 1, hasOpenTab: true });
    expect(summaries.get('closed')).toEqual({ bookmarkCount: 1, hasOpenTab: false });
  });
});

describe('tabSpaceId', () => {
  it('resolves portable and grouped ownership to the exact space', () => {
    const portableTab = tab(1, 'https://portable.example');
    const groupedTab = tab(2, 'https://grouped.example', 1, 42);

    expect(tabSpaceId(portableTab, { 1: 'portable' }, {})).toBe('portable');
    expect(tabSpaceId(groupedTab, {}, { grouped: 42 })).toBe('grouped');
  });

  it('falls back only to the matching active group', () => {
    const groupedTab = tab(2, 'https://grouped.example', 1, 42);

    expect(tabSpaceId(groupedTab, {}, {}, 'active', 42)).toBe('active');
    expect(tabSpaceId(groupedTab, {}, {}, 'active', 7)).toBeUndefined();
  });
});

describe('foremostTabInWindow', () => {
  it('ignores active tabs in background windows', () => {
    const current = { ...tab(1, 'https://current.example', 7), active: true };
    const background = { ...tab(2, 'https://background.example', 8), active: true };

    expect(foremostTabInWindow([background, current], 7, true)).toBe(current);
    expect(foremostTabInWindow([background, current], 7, false)).toBeUndefined();
  });
});

describe('pageIsForemostInSpace', () => {
  it('requires both an equivalent page and the exact indicated space', () => {
    expect(pageIsForemostInSpace(
      'https://example.com/page?tab=1',
      'research',
      pageIdentity('https://example.com/page?tab=2') ?? undefined,
      'research',
    )).toBe(true);
    expect(pageIsForemostInSpace(
      'https://example.com/page',
      'work',
      pageIdentity('https://example.com/page') ?? undefined,
      'research',
    )).toBe(false);
    expect(pageIsForemostInSpace('https://example.com/page', 'research')).toBe(false);
  });
});

describe('bookmarkNodeIdForPage', () => {
  const identity = pageIdentity('https://example.com/docs?view=current') ?? undefined;
  const first = bookmark('first', 'First copy', 'https://example.com/docs?copy=1', 'root');
  const second = bookmark('second', 'Second copy', 'https://example.com/docs?copy=2', 'nested');
  const tree = [folder('root', 'Root', undefined, [
    first,
    folder('nested', 'Nested', 'root', [second]),
  ])];

  it('prefers the clicked bookmark among duplicate URL identities', () => {
    expect(bookmarkNodeIdForPage(tree, identity, second.id)).toBe(second.id);
  });

  it('falls back to the first matching bookmark for a stale selection', () => {
    expect(bookmarkNodeIdForPage(tree, identity, 'other')).toBe(first.id);
  });
});

describe('filterBookmarkTree', () => {
  const target = bookmark('21', 'Incident runbook', 'https://example.com/runbook', '20');
  const tree = [folder('20', 'Operations', '10', [target])];

  it('keeps ancestor folders for matching descendants', () => {
    expect(filterBookmarkTree(tree, 'runbook')).toEqual(tree);
  });

  it('returns no branches when nothing matches', () => {
    expect(filterBookmarkTree(tree, 'design system')).toEqual([]);
  });

  it('detects descendant drops that would create a cycle', () => {
    expect(containsNode(tree[0]!, target.id)).toBe(true);
    expect(containsNode(target, tree[0]!.id)).toBe(false);
  });

  it('finds a query variant and returns the folders needed to reveal it', () => {
    expect(findBookmarkPathByUrl(tree, 'https://example.com/runbook?view=compact')).toEqual([
      tree[0],
      target,
    ]);
  });
});

describe('destructive action helpers', () => {
  it('counts every bookmark and subfolder in a recursive delete, or the bookmarks alone', () => {
    const nested = folder('31', 'Nested', '30', [
      bookmark('32', 'Two', 'https://two.example.com', '31'),
    ]);
    const target = folder('30', 'Target', '10', [
      bookmark('33', 'One', 'https://one.example.com', '30'),
      nested,
    ]);

    expect(descendantItemCount(target)).toBe(3);
    expect(bookmarkCount([target, folder('34', 'Empty', '10', [])])).toBe(2);
  });

  it('uses a pending page URL and rejects extension or internal pages', () => {
    expect(bookmarkableTabUrl(
      testTab({ id: 1, active: true, pendingUrl: 'https://example.com/loading' }),
      'chrome-extension://hyper/',
    )).toBe('https://example.com/loading');
    expect(bookmarkableTabUrl(
      testTab({ id: 2, active: true, url: 'chrome-extension://hyper/sidepanel.html' }),
      'chrome-extension://hyper/',
    )).toBeNull();
    expect(bookmarkableTabUrl(
      testTab({
        id: 4,
        active: true,
        url: 'chrome-extension://another-extension/page.html',
      }),
      'chrome-extension://hyper/',
    )).toBeNull();
    expect(bookmarkableTabUrl(
      testTab({ id: 3, active: true, url: 'chrome://settings' }),
      'chrome-extension://hyper/',
    )).toBeNull();
  });
});

describe('space tab derivation', () => {
  it('uses explicit ownership when native tab groups are unavailable', () => {
    const tabs = [
      tab(1, 'https://one.example.com'),
      tab(2, 'https://two.example.com'),
      tab(3, 'https://other-window.example.com', 2),
    ];

    expect(deriveSpaceTabs(tabs, 1, null, 'work', {
      1: 'work',
      2: 'personal',
      3: 'work',
    })).toEqual([tabs[0]]);
  });

  it('projects marked tab folders and only live current-window backings', () => {
    const live = bookmark(
      'live',
      tabBackingBookmarkTitle('Live tab'),
      'https://live.example.com',
      'nested',
      0,
    );
    const foreign = bookmark(
      'foreign',
      tabBackingBookmarkTitle('Other window'),
      'https://foreign.example.com',
      'tab-folder',
      1,
    );
    const unmarkedLeaf = bookmark(
      'ordinary',
      'Ordinary bookmark',
      'https://ordinary.example.com',
      'tab-folder',
      2,
    );
    const nested = folder('nested', tabFolderBookmarkTitle('Nested'), 'tab-folder', [live]);
    nested.index = 0;
    const tabFolder = folder(
      'tab-folder',
      tabFolderBookmarkTitle('Filed'),
      'tabs-root',
      [nested, foreign, unmarkedLeaf],
    );
    tabFolder.index = 0;
    const empty = folder('empty', tabFolderBookmarkTitle('Empty'), 'tabs-root', []);
    empty.index = 1;
    const ordinaryFolder = folder('ordinary-folder', 'Not a tab folder', 'tabs-root', [
      bookmark(
        'hidden-live',
        tabBackingBookmarkTitle('Hidden live backing'),
        'https://hidden.example.com',
        'ordinary-folder',
      ),
    ]);
    const tabsRoot = folder(
      'tabs-root',
      serializeBookmarkTitle('tabs', { hyper: { spaceTabs: true } }),
      'work',
      [tabFolder, empty, ordinaryFolder],
    );
    const space = folder('work', 'Work', 'spaces', [tabsRoot]);
    const root = folder('root', 'Root', undefined, [space]);

    expect(deriveWindowSpaceTabTree([root], 'work', new Set(['live', 'hidden-live']))).toEqual({
      rootId: 'tabs-root',
      nodes: [
        { ...tabFolder, children: [{ ...nested, children: [live] }] },
        empty,
      ],
    });
  });

  it('returns an empty projection when the active space has no marked tabs root', () => {
    expect(deriveWindowSpaceTabTree([], 'missing', new Set())).toEqual({ nodes: [] });
  });
});

describe('folder opening helpers', () => {
  it('collects each normalized page only once', () => {
    const target = folder('40', 'Folder', '10', [
      bookmark('41', 'Docs compact', 'https://example.com/docs?view=compact', '40'),
      folder('42', 'Nested', '40', [
        bookmark('43', 'Docs full', 'https://example.com/docs?view=full#top', '42'),
        bookmark('44', 'Guide', 'https://example.com/guide', '42'),
      ]),
    ]);

    expect(collectUniqueBookmarkUrls(target)).toEqual([
      'https://example.com/docs?view=compact',
      'https://example.com/guide',
    ]);
  });
});

describe('tab favicon helpers', () => {
  it('prefers an active live favicon, then any available live favicon', () => {
    const withoutIcon = tab(1, 'https://example.com');
    const available = { ...tab(2, 'https://example.com'), favIconUrl: 'available.svg' };
    const active = {
      ...tab(3, 'https://example.com'),
      active: true,
      favIconUrl: 'active.svg',
    };

    expect(bestTabFaviconUrl([withoutIcon, available])).toBe('available.svg');
    expect(bestTabFaviconUrl([withoutIcon, available, active])).toBe('active.svg');
  });
});
