import { describe, expect, it } from 'vitest';
import {
  eachItem,
  MAX_INTENT_ITEMS,
  optionalBoolean,
  optionalNumber,
  optionalString,
  parseActivateTabPayload,
  parseCloseTabsPayload,
  parseCopyBookmarkPayload,
  parseCreateBookmarkFolderPayload,
  parseCreateBookmarkPayload,
  parseCreateSpacePayload,
  parseCreateTabPayload,
  parseDeleteBookmarkPayload,
  parseDeleteHistoryPayload,
  parseDeleteSpacePayload,
  parseDuplicateSpacePayload,
  parseMoveBookmarkPayload,
  parseMoveSessionTabPayload,
  parseNavigateTabPayload,
  parseMoveTabToWindowPayload,
  parseOpenBookmarkPayload,
  parseOpenFavouritePayload,
  parseForgetSearchSelectionPayload,
  parseRecordSearchSelectionPayload,
  parseSetSpaceArchivedPayload,
  parseSetTabFolderPayload,
  parseSetTabGroupPayload,
  parseSetTabMutedPayload,
  parseSpaceTabsPayload,
  parseSplitTabPayload,
  parseUpdateBookmarkUrlPayload,
  requireNumber,
  requireNumbers,
  requireString,
  requireTitle,
  setTabFolderTargets,
} from './modelIntentPayloads';

/** Expects `parse` to read `payload` back unchanged. */
const expectKept = (parse: (payload: unknown) => unknown, payload: object) =>
  expect(parse(payload)).toEqual(payload);

describe('intent payload readers', () => {
  it('reads one payload or a bounded list of items of the same shape', () => {
    const parse = eachItem((payload) => requireString(payload, 'bookmarkId'));

    expect(parse({ bookmarkId: 'one' })).toEqual({ batch: false, items: ['one'] });
    expect(parse({ items: [{ bookmarkId: 'one' }, { bookmarkId: 'two' }] }))
      .toEqual({ batch: true, items: ['one', 'two'] });
    for (const items of [[], 'one', Array(MAX_INTENT_ITEMS + 1).fill({ bookmarkId: 'x' })]) {
      expect(() => parse({ items })).toThrow('An intent needs a list of items.');
    }
    // One malformed item rejects the whole intent before any effect runs.
    expect(() => parse({ items: [{ bookmarkId: 'one' }, { bookmarkId: '' }] })).toThrow();
  });
  it('rejects a payload that is not an object', () => {
    expect(() => requireString('nonsense', 'spaceId')).toThrow();
    expect(() => requireString(null, 'spaceId')).toThrow();
  });

  it('rejects an empty identifier but accepts an empty title', () => {
    expect(() => requireString({ spaceId: '' }, 'spaceId')).toThrow();
    expect(requireTitle({ title: '' }, 'title')).toBe('');
  });

  it('rejects a non-finite number', () => {
    expect(() => requireNumber({ tabId: Number.NaN }, 'tabId')).toThrow();
    expect(requireNumber({ tabId: 7 }, 'tabId')).toBe(7);
  });

  it('rejects a list holding anything but finite numbers', () => {
    expect(() => requireNumbers({ tabIds: [1, '2'] }, 'tabIds')).toThrow();
    expect(() => requireNumbers({ tabIds: [1, Number.NaN] }, 'tabIds')).toThrow();
    expect(requireNumbers({ tabIds: [1, 2] }, 'tabIds')).toEqual([1, 2]);
  });

  it('distinguishes an absent optional from a wrongly typed one', () => {
    expect(optionalString({}, 'parentId')).toBeUndefined();
    expect(optionalNumber({}, 'index')).toBeUndefined();
    expect(optionalBoolean({}, 'active')).toBeUndefined();
    expect(() => optionalString({ parentId: 3 }, 'parentId')).toThrow();
    expect(() => optionalNumber({ index: '3' }, 'index')).toThrow();
    expect(() => optionalBoolean({ active: 'yes' }, 'active')).toThrow();
  });
});

describe('parseSetSpaceArchivedPayload', () => {
  it('reads the flag and an optional place', () => {
    expectKept(parseSetSpaceArchivedPayload, { archived: true, spaceId: 's' });
    expectKept(parseSetSpaceArchivedPayload, { archived: false, beforeSpaceId: 't', spaceId: 's' });
  });

  it('rejects a missing flag or a space placed before itself', () => {
    expect(() => parseSetSpaceArchivedPayload({ spaceId: 's' })).toThrow();
    expect(() => parseSetSpaceArchivedPayload({ archived: true, beforeSpaceId: 's', spaceId: 's' })).toThrow();
  });
});

describe('parseSetTabFolderPayload', () => {
  it('reads each operation', () => {
    expectKept(parseSetTabFolderPayload, { folderId: 'f1', operation: 'remove' });
    expectKept(parseSetTabFolderPayload, { folderId: 'f1', operation: 'remove', withTabs: true });
    expectKept(parseSetTabFolderPayload, { folderId: 'f1', operation: 'rename', title: 'Work' });
    expect(parseSetTabFolderPayload({ operation: 'create', spaceId: 's1' }))
      .toEqual({ operation: 'create', parentId: undefined, spaceId: 's1', title: undefined });
  });

  it('rejects an unknown operation', () => {
    expect(() => parseSetTabFolderPayload({ operation: 'destroy' })).toThrow();
  });

  it('rejects a move index that is not a whole, non-negative position', () => {
    const move = { nodeIds: ['n1'], operation: 'move', parentId: 'p1', spaceId: 's1' };
    expect(() => parseSetTabFolderPayload({ ...move, index: -1 })).toThrow();
    expect(() => parseSetTabFolderPayload({ ...move, index: 1.5 })).toThrow();
    expectKept(parseSetTabFolderPayload, { ...move, index: 2 });
  });

  it('requires the identifiers a move depends on', () => {
    expect(() => parseSetTabFolderPayload({ nodeIds: ['n1'], operation: 'move', spaceId: 's1' }))
      .toThrow();
    expect(() => parseSetTabFolderPayload({
      nodeIds: [], operation: 'move', parentId: 'p1', spaceId: 's1',
    })).toThrow();
  });
});

describe('bookmark intent payloads', () => {
  it('parses bookmark creation and copy requests', () => {
    expectKept(parseCreateBookmarkPayload, { index: 2, parentId: 'parent', tabId: 7 });
    expect(parseCreateBookmarkPayload({ parentId: 'parent' }))
      .toEqual({ index: undefined, parentId: 'parent', tabId: undefined });
    expect(parseCreateBookmarkPayload({
      page: { title: ' Docs ', url: 'https://example.test/docs' },
      parentId: 'parent',
    })).toEqual({ page: { title: 'Docs', url: 'https://example.test/docs' }, parentId: 'parent' });
    expect(parseCopyBookmarkPayload({
      bookmarkId: 'source',
      index: 3,
      parentId: 'destination',
      skipExisting: true,
    })).toEqual({
      bookmarkId: 'source',
      index: 3,
      parentId: 'destination',
      skipExisting: true,
    });
  });

  it('rejects invalid bookmark insertion positions before an effect can run', () => {
    expect(() => parseCreateBookmarkPayload({
      page: { title: 'Run', url: 'javascript:alert(1)' },
      parentId: 'parent',
    })).toThrow();
    expect(() => parseCreateBookmarkPayload({
      page: { title: 'Both', url: 'https://example.test/' },
      parentId: 'parent',
      tabId: 7,
    })).toThrow();
    expect(() => parseCreateBookmarkPayload({ page: 'https://example.test/', parentId: 'parent' }))
      .toThrow();
    expect(() => parseCreateBookmarkPayload({ index: -1, parentId: 'parent' })).toThrow();
    expect(() => parseCopyBookmarkPayload({
      bookmarkId: 'source',
      index: 1.5,
      parentId: 'destination',
    })).toThrow();
    expect(() => parseMoveBookmarkPayload({ bookmarkId: 'source', index: -1 })).toThrow();
    expect(parseMoveBookmarkPayload({ bookmarkId: 'source', index: 2 }))
      .toEqual({ bookmarkId: 'source', index: 2, parentId: undefined });
    expect(parseMoveBookmarkPayload({ bookmarkId: 'source', offset: -1 }))
      .toEqual({ bookmarkId: 'source', offset: -1 });
    expect(() => parseMoveBookmarkPayload({ bookmarkId: 'source', offset: 2 })).toThrow();
    expect(() => parseMoveBookmarkPayload({ bookmarkId: 'source', index: 0, offset: 1 })).toThrow();
  });

  it('parses folder, space, open, and URL-update requests', () => {
    expectKept(parseCreateBookmarkFolderPayload, { parentId: 'parent' });
    expectKept(parseCreateSpacePayload, { spacesFolderId: 'spaces' });
    expect(parseDuplicateSpacePayload({ spaceId: 'space' }))
      .toEqual({ spaceId: 'space', withTabs: false });
    expectKept(parseDuplicateSpacePayload, { spaceId: 'space', withTabs: true });
    expectKept(parseSpaceTabsPayload, { spaceId: 'space' });
    expect(parseDeleteBookmarkPayload({
      bookmarkId: 'folder',
      expectedProvisionalTitle: 'New folder',
    })).toEqual({ bookmarkId: 'folder', expectedProvisionalTitle: 'New folder' });
    expect(parseDeleteSpacePayload({ moveBookmarks: true, spaceId: 'space' }))
      .toEqual({ expectedProvisionalTitle: undefined, moveBookmarks: true, spaceId: 'space' });
    expect(parseOpenBookmarkPayload({
      active: false,
      destinationSpaceId: 'space',
      forceNew: true,
      reuse: 'browser',
      url: 'https://example.test',
    })).toEqual({
      active: false,
      destinationSpaceId: 'space',
      forceNew: true,
      reuse: 'browser',
      url: 'https://example.test',
    });
    expect(parseOpenBookmarkPayload({ url: 'https://example.test' })).toEqual({
      active: true,
      destinationSpaceId: undefined,
      forceNew: false,
      reuse: 'window',
      url: 'https://example.test',
    });
    expect(parseOpenFavouritePayload({
      activeSpaceId: 'space',
      forceNew: true,
      url: 'https://example.test',
    })).toEqual({ activeSpaceId: 'space', forceNew: true, url: 'https://example.test' });
    expectKept(parseUpdateBookmarkUrlPayload, { bookmarkId: 'bookmark', url: 'https://example.test' });
  });

  it('rejects malformed bookmark operation identifiers and flags', () => {
    expect(() => parseCreateBookmarkFolderPayload({ parentId: '' })).toThrow();
    expect(() => parseCreateSpacePayload({ spacesFolderId: '' })).toThrow();
    expect(() => parseDuplicateSpacePayload({ spaceId: '' })).toThrow();
    expect(() => parseDuplicateSpacePayload({ spaceId: 'space', withTabs: 'yes' })).toThrow();
    expect(() => parseSpaceTabsPayload({ spaceId: '' })).toThrow();
    expect(() => parseSpaceTabsPayload({})).toThrow();
    expect(() => parseDeleteBookmarkPayload({ bookmarkId: '' })).toThrow();
    expect(() => parseDeleteBookmarkPayload({ bookmarkId: 'folder', expectedProvisionalTitle: 3 }))
      .toThrow();
    expect(() => parseDeleteBookmarkPayload({ bookmarkId: 'bookmark', unpin: 'yes' })).toThrow();
    expect(() => parseDeleteSpacePayload({ spaceId: '' })).toThrow();
    expect(() => parseDeleteSpacePayload({ moveBookmarks: 'yes', spaceId: 'space' })).toThrow();
    expect(() => parseOpenBookmarkPayload({ reuse: 'profile', url: 'https://example.test' }))
      .toThrow();
    expect(() => parseOpenFavouritePayload({ forceNew: 'yes', url: 'https://example.test' }))
      .toThrow();
    expect(() => parseUpdateBookmarkUrlPayload({ bookmarkId: 'bookmark', url: '' })).toThrow();
  });

  it('parses unpin bookmark deletions', () => {
    expect(parseDeleteBookmarkPayload({ bookmarkId: 'bookmark', unpin: true }))
      .toEqual({ bookmarkId: 'bookmark', expectedProvisionalTitle: undefined, unpin: true });
  });
});

describe('tab and history intent payloads', () => {
  it('parses tab creation, navigation, grouping, mute, and history deletion requests', () => {
    expectKept(parseCreateTabPayload, {});
    expect(parseActivateTabPayload({ tabId: 7 }))
      .toEqual({ operation: 'local', tabId: 7 });
    expect(parseActivateTabPayload({
      operation: 'remote',
      source: { kind: 'tab', tabId: 7 },
      spaceId: 'space-1',
    })).toEqual({
      operation: 'remote',
      source: { kind: 'tab', tabId: 7 },
      spaceId: 'space-1',
    });
    expect(parseMoveTabToWindowPayload({
      source: { bookmarkId: 'bookmark-1', kind: 'bookmark' },
      spaceId: 'space-1',
    })).toEqual({
      source: { bookmarkId: 'bookmark-1', kind: 'bookmark' },
      spaceId: 'space-1',
    });
    expectKept(parseCloseTabsPayload, { tabIds: [7] });
    expect(parseCloseTabsPayload({
      condition: 'other-unpinned',
      keepTabId: 7,
      tabIds: [6, 8],
      windowId: 3,
    })).toEqual({
      condition: 'other-unpinned',
      keepTabId: 7,
      tabIds: [6, 8],
      windowId: 3,
    });
    expect(parseCloseTabsPayload({
      condition: 'page-in-space',
      source: { kind: 'tab', tabId: 7 },
      spaceId: 'space-1',
      tabIds: [99],
    })).toEqual({
      condition: 'page-in-space',
      source: { kind: 'tab', tabId: 7 },
      spaceId: 'space-1',
    });
    expectKept(parseNavigateTabPayload, { kind: 'url', tabId: 7, url: 'https://example.test' });
    expect(parseNavigateTabPayload({ kind: 'search', query: 'weather tomorrow' }))
      .toEqual({ kind: 'search', query: 'weather tomorrow', tabId: undefined });
    expectKept(parseSetTabGroupPayload, { spaceId: 'space-1', tabIds: [7, 8] });
    expectKept(parseSetTabMutedPayload, { muted: true, tabId: 7 });
    expectKept(parseDeleteHistoryPayload, { url: 'https://example.test' });
    expectKept(parseRecordSearchSelectionPayload, { query: 'design', resultId: 'bookmark:design' });
    expectKept(parseRecordSearchSelectionPayload, { query: 'constructor', resultId: 'command:prototype' });
    expectKept(parseForgetSearchSelectionPayload, { resultId: 'navigate:search:weather' });
  });

  it('rejects malformed tab creation, navigation, grouping, mute, and history deletion requests', () => {
    expect(() => parseCreateTabPayload(undefined)).toThrow();
    expect(() => parseActivateTabPayload({ operation: 'remote', spaceId: 'space-1' })).toThrow();
    expect(() => parseActivateTabPayload({
      operation: 'remote',
      source: { kind: 'tab', tabId: -1 },
      spaceId: 'space-1',
    })).toThrow();
    expect(() => parseMoveTabToWindowPayload({
      source: { bookmarkId: 'x'.repeat(513), kind: 'bookmark' },
      spaceId: 'space-1',
    })).toThrow();
    expect(() => parseCloseTabsPayload({ condition: 'all', tabIds: [7] })).toThrow();
    expect(() => parseCloseTabsPayload({ condition: 'page-in-space', tabIds: [7] })).toThrow();
    expect(() => parseNavigateTabPayload({ kind: 'url', url: '' })).toThrow();
    expect(() => parseNavigateTabPayload({ kind: 'search', query: 'news', tabId: -1 })).toThrow();
    expect(() => parseNavigateTabPayload({ kind: 'unknown', url: 'https://example.test' })).toThrow();
    expect(() => parseSetTabGroupPayload({ spaceId: '', tabIds: [7] })).toThrow();
    expect(() => parseSetTabGroupPayload({ spaceId: 'space-1', tabIds: [Number.NaN] }))
      .toThrow();
    expect(() => parseSetTabMutedPayload({ muted: 'yes', tabId: 7 })).toThrow();
    expect(() => parseSetTabMutedPayload({ muted: false, tabId: Number.NaN })).toThrow();
    expect(() => parseDeleteHistoryPayload({ url: '' })).toThrow();
    expect(() => parseRecordSearchSelectionPayload({ query: ' ', resultId: 'bookmark:design' }))
      .toThrow();
    expect(() => parseRecordSearchSelectionPayload({ query: 'design', resultId: '__proto__' }))
      .toThrow();
    expect(() => parseRecordSearchSelectionPayload({
      query: 'design',
      resultId: `bookmark:${'x'.repeat(1_025)}`,
    })).toThrow();
    expect(() => parseForgetSearchSelectionPayload({ resultId: 'constructor' })).toThrow();
    expect(() => parseForgetSearchSelectionPayload({ resultId: `tab:${'x'.repeat(1_025)}` }))
      .toThrow();
  });

  it('splits a tab with exactly one other tab or one page', () => {
    expectKept(parseSplitTabPayload, { tabId: 7, withTabId: 8 });
    expectKept(parseSplitTabPayload, { tabId: 7, url: 'https://example.test' });
    expect(() => parseSplitTabPayload({ tabId: 7 })).toThrow();
    expect(() => parseSplitTabPayload({ tabId: 7, url: 'https://example.test', withTabId: 8 }))
      .toThrow();
    expect(() => parseSplitTabPayload({ tabId: 7, url: '' })).toThrow();
    expect(() => parseSplitTabPayload({ tabId: 7, withTabId: '8' })).toThrow();
  });

  it('moves one tab between sessions, to one session, one place in this window, or a bookmark folder', () => {
    expect(parseMoveSessionTabPayload({
      destination: { installationId: 'laptop' },
      source: { tabId: 7 },
    })).toEqual({ copy: false, destination: { installationId: 'laptop' }, source: { tabId: 7 } });
    expect(parseMoveSessionTabPayload({
      copy: true,
      destination: { index: 3, tree: { index: 0, parentId: 'tabs', spaceId: 'green' } },
      source: { backingId: 'b1' },
    })).toEqual({
      copy: true,
      destination: { index: 3, tree: { index: 0, parentId: 'tabs', spaceId: 'green' } },
      source: { backingId: 'b1' },
    });
    expect(parseMoveSessionTabPayload({
      copy: true,
      destination: { bookmarks: { index: 2, parentId: 'reading' } },
      source: { backingId: 'b1' },
    })).toEqual({ copy: true, destination: { bookmarks: { index: 2, parentId: 'reading' } }, source: { backingId: 'b1' } });
    expect(parseMoveSessionTabPayload({
      destination: { bookmarks: { parentId: 'reading' } },
      source: { backingId: 'b1' },
    })).toEqual({ copy: false, destination: { bookmarks: { parentId: 'reading' } }, source: { backingId: 'b1' } });
    for (const payload of [
      // Only another session's tab is bookmarked this way: this window's tabs have their own intent.
      { destination: { bookmarks: { parentId: 'reading' } }, source: { tabId: 7 } },
      { destination: { bookmarks: {} }, source: { backingId: 'b1' } },
      { destination: { bookmarks: { parentId: 'reading' }, installationId: 'laptop' }, source: { backingId: 'b1' } },
      { destination: { installationId: 'laptop' }, source: { backingId: 'b1', tabId: 7 } },
      { destination: { installationId: 'laptop' }, source: {} },
      { destination: { installationId: 'laptop', tree: { spaceId: 'green' } }, source: { tabId: 7 } },
      { destination: {}, source: { tabId: 7 } },
      { destination: { installationId: '' }, source: { tabId: 7 } },
      { destination: { installationId: 'x'.repeat(129) }, source: { tabId: 7 } },
      { destination: { tree: { spaceId: 'green' } }, source: { backingId: 'b1' } },
      { copy: 'yes', destination: { installationId: 'laptop' }, source: { tabId: 7 } },
    ]) expect(() => parseMoveSessionTabPayload(payload)).toThrow();
  });
});

describe('setTabFolderTargets', () => {
  it('declares the space and the destination a create touches', () => {
    expect(setTabFolderTargets({ operation: 'create', spaceId: 's1' }))
      .toEqual(['space:s1']);
    expect(setTabFolderTargets({ operation: 'create', parentId: 'p1', spaceId: 's1' }))
      .toEqual(['bookmark:p1', 'space:s1']);
  });

  it('declares both ends of a move', () => {
    expect(setTabFolderTargets({
      nodeIds: ['n1', 'n2'],
      operation: 'move',
      parentId: 'p1',
      spaceId: 's1',
    })).toEqual(['bookmark:n1', 'bookmark:n2', 'bookmark:p1', 'space:s1']);
  });

  it('declares the folder a rename or remove touches', () => {
    expect(setTabFolderTargets({ folderId: 'f1', operation: 'remove' }))
      .toEqual(['bookmark:f1']);
    expect(setTabFolderTargets({ folderId: 'f1', operation: 'rename', title: 'Work' }))
      .toEqual(['bookmark:f1']);
  });
});
