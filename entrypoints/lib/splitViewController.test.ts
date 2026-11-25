import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  serializeBookmarkTitle,
  splitViewFolderBookmarkTitle,
  tabBackingBookmarkTitle,
  type BookmarkNode,
} from './bookmarks';
import type { HyperModelSnapshot, HyperModelStore } from './model';
import type { HyperModelPortClient } from './modelPort';
import { createSplitViewController, planSplitViews } from './splitViewController';
import type { TabOwnership } from './tabOwnership';
import { hyperBookmarkTree, spaceTabsFolder, testBookmark, testFolder } from './testBookmarkTree';
import { fakeStorageArea, testTab } from './testFixtures';

const client: HyperModelPortClient = { clientId: 'sidebar', role: 'sidebar', windowId: 3 };

type StubTab = Browser.tabs.Tab & { id: number };

const tab = (id: number, index: number, splitViewId = -1, windowId = 3) =>
  testTab({ groupId: 5, id, index, splitViewId, windowId }) as StubTab;

const backing = (tabId: number): BookmarkNode => testBookmark(
  `backing-${tabId}`,
  tabBackingBookmarkTitle(`Page ${tabId}`, 0, `token-${tabId}`, 'green'),
  `https://example.com/${tabId}`,
  'tabs-root',
);

const splitFolder = (id: string, children: BookmarkNode[]): BookmarkNode => testFolder(
  id,
  splitViewFolderBookmarkTitle(),
  'tabs-root',
  children.map((child) => ({ ...child, parentId: id })),
);

const bookmarkTree = (tabsRoot: BookmarkNode[]) => hyperBookmarkTree([
  { id: 'green', title: 'Green', children: [spaceTabsFolder(undefined, tabsRoot, 'tabs-root')] },
]);

const ownershipsOf = (tabs: readonly StubTab[]): Record<number, TabOwnership> =>
  Object.fromEntries(tabs.map((candidate) =>
    [candidate.id, { backingId: `backing-${candidate.id}`, spaceId: 'green' }]));

const snapshotOf = ({
  capacity = 2,
  ownerships,
  pending = [],
  tabs,
  tabsRoot = [],
}: {
  capacity?: number;
  ownerships?: Record<number, TabOwnership>;
  pending?: string[];
  tabs: StubTab[];
  tabsRoot?: BookmarkNode[];
}) => ({
  browser: { bookmarkTree: bookmarkTree(tabsRoot), tabs },
  commands: pending.length > 0 ? { running: { phase: 'pending', targets: pending } } : {},
  runtime: {
    commandCapabilities: { splitViewTabs: capacity },
    tabOwnerships: ownerships ?? ownershipsOf(tabs),
  },
}) as unknown as HyperModelSnapshot;

const findNode = (nodes: readonly BookmarkNode[], id: string): BookmarkNode | undefined => {
  for (const node of nodes) {
    if (node.id === id) return node;
    const found = findNode(node.children ?? [], id);
    if (found) return found;
  }
  return undefined;
};

const install = (
  tabs: StubTab[],
  {
    seen = [],
    splitApi = true,
    tabsRoot = [],
  }: { seen?: number[]; splitApi?: boolean; tabsRoot?: BookmarkNode[] } = {},
) => {
  const order = () => [...tabs].sort((left, right) => left.index - right.index);
  const move = vi.fn(async (tabId: number, { index }: { index: number }) => {
    const moved = tabs.find((candidate) => candidate.id === tabId)!;
    const rest = order().filter((candidate) => candidate !== moved);
    rest.splice(index, 0, moved);
    rest.forEach((candidate, position) => { candidate.index = position; });
  });
  const createSplit = vi.fn(async () => 9);
  const unsplit = vi.fn(async (splitViewId: number) => {
    for (const candidate of tabs) {
      if (candidate.splitViewId === splitViewId) candidate.splitViewId = -1;
    }
  });
  const group = vi.fn(async () => 5);
  const ungroup = vi.fn(async () => undefined);
  vi.stubGlobal('browser', {
    bookmarks: {
      get: async (id: string) =>
        [findNode(tabsRoot, id) ?? { id, index: 4, parentId: 'tabs-root', title: id }],
      getChildren: async (id: string) => findNode(tabsRoot, id)?.children ?? [],
    },
    storage: { session: fakeStorageArea({ hyperSplitViewTabIds: seen }) },
    tabs: {
      get: async (tabId: number) => ({ ...tabs.find((candidate) => candidate.id === tabId)! }),
      group,
      move,
      query: async ({ splitViewId }: { splitViewId: number }) =>
        tabs.filter((candidate) => candidate.splitViewId === splitViewId),
      ungroup,
      ...(splitApi ? { createSplit, unsplit } : {}),
    },
  });
  const ownerships = ownershipsOf(tabs);
  const dissolveSplitViewFolder = vi.fn(async () => undefined);
  const gatherSplitViewFolder = vi.fn(async () => undefined);
  const openTabInSpace = vi.fn(async () => {
    const opened = tab(20, tabs.length);
    tabs.push(opened);
    ownerships[20] = { backingId: 'backing-20', spaceId: 'green' };
    return { tab: opened };
  });
  const store = {
    get: () => snapshotOf({ ownerships, tabs, tabsRoot }),
    sub: () => () => undefined,
  } as unknown as HyperModelStore;
  const controller = createSplitViewController({
    browserSettled: async () => undefined,
    dissolveSplitViewFolder,
    gatherSplitViewFolder,
    getTabOwnership: async (tabId) => ownerships[tabId],
    openTabInSpace,
    queueMutation: (operation) => operation(),
    store,
  });
  return {
    controller,
    createSplit,
    dissolveSplitViewFolder,
    gatherSplitViewFolder,
    group,
    move,
    openTabInSpace,
    ungroup,
    unsplit,
  };
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('split view controller', () => {
  it('moves a tab beside another, splits them, and stores them together in pane order', async () => {
    const tabs = [tab(1, 0), tab(2, 1), tab(4, 2)];
    const { controller, createSplit, gatherSplitViewFolder, group, move } = install(tabs);

    await controller.handlers.splitTab!.run({ tabId: 1, withTabId: 4 }, client);

    expect(move).toHaveBeenCalledWith(4, { index: 1 });
    expect(group).not.toHaveBeenCalled();
    expect(createSplit).toHaveBeenCalledWith([1, 4]);
    expect(gatherSplitViewFolder).toHaveBeenCalledWith('green', ['backing-1', 'backing-4']);
  });

  it('takes a tab out of its own split first, and never adds to a full one', async () => {
    const tabs = [tab(1, 0), tab(2, 1, 7), tab(3, 2, 7), tab(4, 3, 8), tab(5, 4, 8)];
    const { controller, createSplit, unsplit } = install(tabs);

    await controller.handlers.splitTab!.run({ tabId: 1, withTabId: 3 }, client);

    expect(unsplit).toHaveBeenCalledWith(7);
    expect(unsplit.mock.invocationCallOrder[0]!)
      .toBeLessThan(createSplit.mock.invocationCallOrder[0]!);
    await expect(controller.handlers.splitTab!.run({ tabId: 4, withTabId: 2 }, client))
      .rejects.toThrow('already split');
    await expect(controller.handlers.splitTab!.run({ tabId: 1, withTabId: 1 }, client))
      .rejects.toThrow('beside itself');
  });

  it('opens a bookmark beside a tab and stores the two together', async () => {
    const tabs = [tab(1, 0), tab(2, 1)];
    const { controller, gatherSplitViewFolder, openTabInSpace } = install(tabs);

    await controller.handlers.splitTab!.run({ tabId: 2, url: 'https://example.com/' }, client);

    expect(openTabInSpace).toHaveBeenCalledWith({
      active: false,
      destinationSpaceId: 'green',
      forceNew: true,
      reuse: 'window',
      splitWith: expect.objectContaining({ id: 2 }),
      url: 'https://example.com/',
      windowId: 3,
    });
    expect(gatherSplitViewFolder).toHaveBeenCalledWith('green', ['backing-2', 'backing-20']);
  });

  it('unsplits only a split that a move takes part of', async () => {
    const tabs = [tab(1, 0, 7), tab(2, 1, 7), tab(3, 2)];
    const { controller, unsplit } = install(tabs);

    await controller.releaseDeparting([1, 2, 3]);
    expect(unsplit).not.toHaveBeenCalled();

    await controller.releaseDepartingBackings(['backing-2']);
    expect(unsplit).toHaveBeenCalledExactlyOnceWith(7);
  });

  it('leaves a browser that cannot split tabs alone', async () => {
    const { controller, unsplit } = install([tab(1, 0), tab(2, 1)], { splitApi: false });

    await controller.releaseDeparting([1]);
    expect(unsplit).not.toHaveBeenCalled();
    await expect(controller.handlers.splitTab!.run({ tabId: 1, withTabId: 2 }, client))
      .rejects.toThrow('cannot show tabs side by side');
    expect(controller.handlers.splitTab!.targets({ tabId: 1, withTabId: 2 }, client))
      .toEqual(['tab:1', 'tab:2', 'window:3']);
  });
});

describe('split view plans', () => {
  const none = { dissolve: [], resplit: [], store: [] };

  it('stores a split made in the browser until its tabs are stored together', () => {
    const tabs = [tab(1, 0, 7), tab(2, 1, 7), tab(3, 2)];

    expect(planSplitViews(snapshotOf({ tabs, tabsRoot: [backing(1), backing(2), backing(3)] }), new Set()))
      .toEqual({
        ...none,
        store: [{ backingIds: ['backing-1', 'backing-2'], spaceId: 'green', tabIds: [1, 2] }],
      });
    expect(planSplitViews(snapshotOf({
      tabs,
      tabsRoot: [splitFolder('pair', [backing(1), backing(2)]), backing(3)],
    }), new Set([1, 2]))).toEqual(none);
  });

  it('splits a stored pair open apart again, unless it was taken apart', () => {
    const tabsRoot = [splitFolder('pair', [backing(2), backing(1)])];
    const tabs = [tab(1, 0), tab(2, 1)];
    const dissolved = { ...none, dissolve: [{ folderId: 'pair', spaceId: 'green' }] };

    expect(planSplitViews(snapshotOf({ tabs, tabsRoot }), new Set())).toEqual({
      ...none,
      resplit: [{ folderId: 'pair', spaceId: 'green', tabIds: [2, 1] }],
    });
    expect(planSplitViews(snapshotOf({ tabs, tabsRoot }), new Set([1]))).toEqual(dissolved);
    expect(planSplitViews(snapshotOf({ tabs: [tab(1, 0), tab(2, 0, -1, 4)], tabsRoot }), new Set()))
      .toEqual(dissolved);
  });

  it('waits while a split\'s tabs are closed or busy, and dissolves one left with a single tab', () => {
    const tabsRoot = [splitFolder('pair', [backing(1), backing(2)])];

    expect(planSplitViews(snapshotOf({ tabs: [tab(1, 0)], tabsRoot }), new Set())).toEqual(none);
    expect(planSplitViews(snapshotOf({
      pending: ['tab:2'],
      tabs: [tab(1, 0), tab(2, 1)],
      tabsRoot,
    }), new Set())).toEqual(none);
    expect(planSplitViews(snapshotOf({
      pending: ['space:green'],
      tabs: [tab(1, 0, 7), tab(2, 1, 7)],
      tabsRoot: [backing(1), backing(2)],
    }), new Set())).toEqual(none);
    expect(planSplitViews(snapshotOf({
      tabs: [tab(1, 0)],
      tabsRoot: [splitFolder('pair', [backing(1)])],
    }), new Set())).toEqual({ ...none, dissolve: [{ folderId: 'pair', spaceId: 'green' }] });
  });

  it('leaves a folder no split can show as a folder', () => {
    const tabs = [tab(1, 0), tab(2, 1), tab(3, 2)];
    const inner: BookmarkNode = {
      ...splitFolder('inner', [backing(2)]),
      title: serializeBookmarkTitle('Inner', { hyper: { tabFolder: true } }),
    };

    expect(planSplitViews(snapshotOf({
      tabs,
      tabsRoot: [splitFolder('pair', [backing(1), backing(2), backing(3)])],
    }), new Set())).toEqual(none);
    expect(planSplitViews(snapshotOf({
      tabs,
      tabsRoot: [splitFolder('pair', [backing(1), inner])],
    }), new Set())).toEqual(none);
    expect(planSplitViews(snapshotOf({
      capacity: 0,
      tabs,
      tabsRoot: [splitFolder('pair', [backing(1), backing(2)])],
    }), new Set())).toEqual(none);
  });
});

describe('split view maintenance', () => {
  it('stores a split made in the browser', async () => {
    const { controller, gatherSplitViewFolder } = install([tab(1, 0, 7), tab(2, 1, 7)], {
      tabsRoot: [backing(1), backing(2)],
    });

    controller.start();

    await vi.waitFor(() =>
      expect(gatherSplitViewFolder).toHaveBeenCalledWith('green', ['backing-1', 'backing-2']));
  });

  it('puts a stored pair opened apart back side by side', async () => {
    const { controller, createSplit, move } = install([tab(1, 0), tab(3, 1), tab(2, 2)], {
      tabsRoot: [splitFolder('pair', [backing(1), backing(2)]), backing(3)],
    });

    controller.start();

    await vi.waitFor(() => expect(createSplit).toHaveBeenCalledWith([1, 2]));
    expect(move).toHaveBeenCalledWith(2, { index: 1 });
  });

  it('lets a stored pair go once its tabs are taken apart', async () => {
    const { controller, createSplit, dissolveSplitViewFolder } = install([tab(1, 0), tab(2, 1)], {
      seen: [1, 2],
      tabsRoot: [splitFolder('pair', [backing(1), backing(2)])],
    });

    controller.start();

    await vi.waitFor(() => expect(dissolveSplitViewFolder).toHaveBeenCalledWith('green', 'pair'));
    expect(createSplit).not.toHaveBeenCalled();
  });
});
