import { describe, expect, it, vi } from 'vitest';
import {
  bookmarkParentIds,
  deleteSpacePostconditionViolations,
  liveGroupIds,
  movedBookmarksFolderTitle,
  moveSpaceBookmarks,
  ownedTabIdsForSpace,
  provisionalSpaceInfrastructureIds,
  recoverDeletedSpaceOperation,
  releaseAndRemoveSpaceGroupMappings,
  releaseMappedGroups,
  spaceGroupMappingsForSpace,
} from './spaceDeletion';
import type { DurableOperation } from './operationJournal';

describe('space deletion helpers', () => {
  it('selects only tabs explicitly owned by the deleted space', () => {
    expect(ownedTabIdsForSpace([
      { ownership: { spaceId: 'delete' }, tab: { id: 1, groupId: 5 } as Browser.tabs.Tab },
      { tab: { id: 2, groupId: 5 } as Browser.tabs.Tab },
      { ownership: { spaceId: 'keep' }, tab: { id: 3, groupId: 5 } as Browser.tabs.Tab },
      {
        ownership: { spaceId: 'delete' },
        tab: { id: 4, groupId: 5, incognito: true } as Browser.tabs.Tab,
      },
    ], 'delete')).toEqual([1]);
  });

  it('finds only valid mappings for the deleted space', () => {
    expect(spaceGroupMappingsForSpace({
      'spaceGroupId:1:delete': 5,
      'spaceGroupId:2:delete': 6,
      'spaceGroupId:1:keep': 7,
      'spaceGroupId:3:delete': 'not-a-group',
    }, 'delete')).toEqual([
      { groupId: 5, key: 'spaceGroupId:1:delete' },
      { groupId: 6, key: 'spaceGroupId:2:delete' },
    ]);
  });

  it('releases all remaining tabs from a still-mapped native group', async () => {
    let tabs = [
      { id: 1, groupId: 5 } as Browser.tabs.Tab,
      { id: 2, groupId: 5 } as Browser.tabs.Tab,
      { id: 3, groupId: 8 } as Browser.tabs.Tab,
    ];
    const ungroup = vi.fn(async (tabIds: readonly number[]) => {
      const ids = new Set(tabIds);
      tabs = tabs.map((tab) => ids.has(tab.id!) ? { ...tab, groupId: -1 } : tab);
    });

    await expect(releaseMappedGroups([5], {
      isMapped: async () => true,
      listTabs: async () => tabs,
      ungroup,
    })).resolves.toEqual([5]);

    expect(ungroup).toHaveBeenCalledWith([1, 2]);
    expect(liveGroupIds(tabs)).toEqual(new Set([8]));
  });

  it('leaves a group alone when its mapping changes before release', async () => {
    const ungroup = vi.fn(async () => undefined);

    await expect(releaseMappedGroups([5], {
      isMapped: async () => false,
      listTabs: async () => [{ id: 1, groupId: 5 } as Browser.tabs.Tab],
      ungroup,
    })).resolves.toEqual([]);

    expect(ungroup).not.toHaveBeenCalled();
  });

  it('names moved bookmarks for their space, numbered past folders already called that', () => {
    const node = (title: string, url?: string) =>
      ({ id: title, title, ...(url ? { url } : { children: [] }) }) as Browser.bookmarks.BookmarkTreeNode;

    expect(movedBookmarksFolderTitle('Work', [node('Home')])).toBe('Work');
    expect(movedBookmarksFolderTitle('Work', [
      node('work'),
      node('Work 2'),
      node('Work 3', 'https://example.test/'),
    ])).toBe('Work 3');
  });

  it('makes no folder for a space with no bookmarks of its own', async () => {
    const dependencies = { createBookmarkFolder: vi.fn(), moveBookmark: vi.fn() };
    const backing = {
      id: 'backing',
      title: 'Tab {"hyper":{"tab":true}}',
      url: 'https://example.test/',
    } as Browser.bookmarks.BookmarkTreeNode;

    await expect(moveSpaceBookmarks(
      { children: [backing], title: 'Work' },
      { children: [], rootId: 'root' },
      dependencies,
    )).resolves.toBeUndefined();
    expect(dependencies.createBookmarkFolder).not.toHaveBeenCalled();
  });

  it('collects every observed bookmark parent for delete postconditions', () => {
    expect(bookmarkParentIds([{
      children: [{ id: 'child', parentId: 'root', title: 'Child' }],
      id: 'root',
      title: 'Root',
    } as Browser.bookmarks.BookmarkTreeNode])).toEqual(new Map([
      ['root', ''],
      ['child', 'root'],
    ]));
  });

  it('accepts only untouched empty provisional infrastructure', async () => {
    const nodes: Record<string, Browser.bookmarks.BookmarkTreeNode> = {
      bookmarks: {
        id: 'bookmarks', parentId: 'space', title: 'Bookmarks',
      } as Browser.bookmarks.BookmarkTreeNode,
      space: { id: 'space', title: 'New space' } as Browser.bookmarks.BookmarkTreeNode,
      tabs: { id: 'tabs', parentId: 'space', title: 'Tabs' } as Browser.bookmarks.BookmarkTreeNode,
    };
    const children: Record<string, Browser.bookmarks.BookmarkTreeNode[]> = {
      bookmarks: [],
      space: [nodes.tabs!, nodes.bookmarks!],
      tabs: [],
    };

    await expect(provisionalSpaceInfrastructureIds('space', 'New space', {
      getBookmark: async (id) => nodes[id],
      getBookmarkChildren: async (id) => children[id] ?? [],
      isInfrastructureFolder: (node) => node.id === 'tabs' || node.id === 'bookmarks',
      visibleTitle: (node) => node.title,
    })).resolves.toEqual(['tabs', 'bookmarks']);

    children.tabs = [{
      id: 'user-bookmark', parentId: 'tabs', title: 'Saved',
    } as Browser.bookmarks.BookmarkTreeNode];
    await expect(provisionalSpaceInfrastructureIds('space', 'New space', {
      getBookmark: async (id) => nodes[id],
      getBookmarkChildren: async (id) => children[id] ?? [],
      isInfrastructureFolder: (node) => node.id === 'tabs' || node.id === 'bookmarks',
      visibleTitle: (node) => node.title,
    })).resolves.toBeUndefined();
  });

  it('releases only current mappings and then removes those exact mapping keys', async () => {
    let tabs = [{ id: 1, groupId: 5 } as Browser.tabs.Tab];
    const session: Record<string, unknown> = { 'spaceGroupId:1:delete': 5 };
    const removeSessionKeys = vi.fn(async (keys: readonly string[]) => {
      for (const key of keys) delete session[key];
    });

    await expect(releaseAndRemoveSpaceGroupMappings([
      { groupId: 5, key: 'spaceGroupId:1:delete' },
    ], {
      listTabs: async () => tabs,
      readSession: async () => session,
      removeSessionKeys,
      ungroup: async (tabIds) => {
        const ids = new Set(tabIds);
        tabs = tabs.map((tab) => ids.has(tab.id!) ? { ...tab, groupId: -1 } : tab);
      },
    })).resolves.toEqual([5]);

    expect(removeSessionKeys).toHaveBeenCalledWith(['spaceGroupId:1:delete']);
    expect(session).toEqual({});
  });

  it('derives deletion postconditions from fresh browser observations', async () => {
    await expect(deleteSpacePostconditionViolations({
      ownedTabIds: [1],
      releasedGroupIds: [5],
      spaceRootId: 'deleted-space',
    }, {
      getBookmarkTree: async () => [{
        id: 'root',
        title: 'Bookmarks',
      } as Browser.bookmarks.BookmarkTreeNode],
      listTabs: async () => [{ id: 2, groupId: -1 } as Browser.tabs.Tab],
      readSession: async () => ({}),
    })).resolves.toEqual([]);
  });

  it('completes recovery only after a deleted space proof still holds', async () => {
    const operation: DurableOperation = {
      completionProof: {
        sourceSpaceId: 'deleted-space',
      },
      id: 'delete-space',
      idempotencyKey: 'delete-space:deleted-space',
      kind: 'delete-space',
      payload: { releasedGroupIds: [5] },
      phase: 'verifying',
      recovery: 'abandon',
      startedAt: 1,
      updatedAt: 1,
    };

    await expect(recoverDeletedSpaceOperation(operation, {
      getBookmark: async () => undefined,
      getTabOwnership: async () => ({ spaceId: 'other-space' }),
      listTabs: async () => [{ id: 1, groupId: -1 } as Browser.tabs.Tab],
      readSession: async () => ({}),
    })).resolves.toEqual({ status: 'completed' });

    await expect(recoverDeletedSpaceOperation(operation, {
      getBookmark: async (id) => id === 'deleted-space'
        ? { id, title: 'Still here' } as Browser.bookmarks.BookmarkTreeNode
        : undefined,
      getTabOwnership: async () => undefined,
      listTabs: async () => [],
      readSession: async () => ({}),
    })).resolves.toMatchObject({ status: 'abandoned' });
  });
});