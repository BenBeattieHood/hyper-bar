import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BookmarkNode } from './bookmarks';
import { activeSpaceKey } from './windowState';
import { spaceGroupKey } from './spaceGroupStore';
import { createTabRouter } from './tabRouter';
import { hyperBookmarkTree } from './testBookmarkTree';
import { fakeStorageArea, testTab } from './testFixtures';

const spacesTree = (twoTitle = 'Two') => hyperBookmarkTree([
  { id: 'one', title: 'One', children: [] },
  { id: 'two', title: twoTitle, children: [] },
]);
const tree = spacesTree();

function installBrowser(options: {
  groups?: Browser.tabGroups.TabGroup[];
  session?: Record<string, unknown>;
  tab: Browser.tabs.Tab;
  tree?: BookmarkNode[];
}) {
  const sessionArea = fakeStorageArea(options.session);
  let tab = options.tab;
  const groups = [...(options.groups ?? [])];
  const group = vi.fn(async (request: { createProperties?: { windowId: number }; groupId?: number }) => {
    const groupId = request.groupId ?? 900;
    if (request.groupId === undefined) {
      groups.push({ collapsed: false, id: groupId, windowId: request.createProperties!.windowId } as Browser.tabGroups.TabGroup);
    }
    tab = { ...tab, groupId };
    return groupId;
  });
  const update = vi.fn(async (groupId: number) => groups.find((candidate) => candidate.id === groupId));
  vi.stubGlobal('browser', {
    bookmarks: { getTree: async () => options.tree ?? tree },
    storage: { session: sessionArea },
    tabGroups: {
      get: async (groupId: number) => {
        const found = groups.find((candidate) => candidate.id === groupId);
        if (!found) throw new Error('No group');
        return found;
      },
      query: async ({ windowId }: { windowId?: number }) =>
        groups.filter((candidate) => windowId === undefined || candidate.windowId === windowId),
      update,
    },
    tabs: { get: async () => tab, group, ungroup: vi.fn() },
  });
  return { group, moveTab: (windowId: number) => { tab = { ...tab, windowId }; }, session: sessionArea.values, update };
}

function router() {
  const dependencies = {
    activateSpaceGroup: vi.fn(async () => undefined),
    beginProgrammaticGroupUpdate: vi.fn(),
    endProgrammaticGroupUpdate: vi.fn(async () => undefined),
    ensureStructure: vi.fn(async () => undefined),
    syncTabBacking: vi.fn(async () => undefined),
  };
  return { dependencies, router: createTabRouter(dependencies) };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const dragging = () => new Error('Tabs cannot be edited right now (user may be dragging a tab).');

describe('tab router', () => {
  it('leaves a tab moved from another window to the move that carried it', async () => {
    const { group } = installBrowser({
      session: { 'tabSpaceId:5': { spaceId: 'one', windowId: 1 } },
      tab: testTab({ id: 5, windowId: 2 }),
    });
    const { dependencies, router: tabRouter } = router();

    await tabRouter.route(5, true);

    expect(group).not.toHaveBeenCalled();
    expect(dependencies.syncTabBacking).not.toHaveBeenCalled();
  });

  it('never pulls back a tab the browser moves to another window mid-route', async () => {
    const { group, moveTab } = installBrowser({
      groups: [{ collapsed: false, id: 40, windowId: 2 } as Browser.tabGroups.TabGroup],
      session: {
        [spaceGroupKey('one', 2)]: 40,
        'tabSpaceId:5': { spaceId: 'one', windowId: 2 },
      },
      tab: testTab({ id: 5, windowId: 2 }),
    });
    const tabGroups = (globalThis as unknown as {
      browser: { tabGroups: { get: (groupId: number) => Promise<Browser.tabGroups.TabGroup> } };
    }).browser.tabGroups;
    const getGroup = tabGroups.get;
    tabGroups.get = async (groupId) => {
      moveTab(3);
      return getGroup(groupId);
    };
    const { dependencies, router: tabRouter } = router();

    await tabRouter.route(5, true);

    // Joining the old window's group would carry the tab back there; its attach places it instead.
    expect(group).not.toHaveBeenCalled();
    expect(dependencies.syncTabBacking).not.toHaveBeenCalled();
  });

  it('creates a missing space group in the tab’s own window', async () => {
    const { group, session } = installBrowser({
      session: { [activeSpaceKey(2)]: 'two' },
      tab: testTab({ active: true, id: 5, windowId: 2 }),
    });
    const { dependencies, router: tabRouter } = router();

    await tabRouter.route(5, true);

    expect(group).toHaveBeenCalledWith({ createProperties: { windowId: 2 }, tabIds: 5 });
    expect(session.get(spaceGroupKey('two', 2))).toBe(900);
    expect(dependencies.syncTabBacking).toHaveBeenCalledWith(expect.objectContaining({ id: 5 }), 'two');
    expect(dependencies.activateSpaceGroup).toHaveBeenCalledWith(expect.objectContaining({ id: 900 }), 5);
  });

  it('gives a group it creates the colour the space wears in another window, not one from its id', async () => {
    const { update } = installBrowser({
      groups: [{ collapsed: false, color: 'purple', id: 40, windowId: 1 } as Browser.tabGroups.TabGroup],
      session: { [activeSpaceKey(2)]: 'two', [spaceGroupKey('two', 1)]: 40 },
      tab: testTab({ active: true, id: 5, windowId: 2 }),
    });
    const { router: tabRouter } = router();

    await tabRouter.route(5, true);

    expect(update).toHaveBeenCalledWith(900, expect.objectContaining({ color: 'purple' }));
  });

  it('joins the group the window already shows the space in', async () => {
    const { group } = installBrowser({
      groups: [{ collapsed: false, id: 40, title: 'other', windowId: 2 } as Browser.tabGroups.TabGroup],
      session: { [spaceGroupKey('one', 2)]: 40 },
      tab: testTab({ id: 5, windowId: 2 }),
    });
    const { dependencies, router: tabRouter } = router();

    await tabRouter.route(5, false, 'one');

    expect(group).toHaveBeenCalledWith({ groupId: 40, tabIds: 5 });
    expect(dependencies.syncTabBacking).toHaveBeenCalledWith(expect.objectContaining({ id: 5 }), 'one');
    expect(dependencies.activateSpaceGroup).not.toHaveBeenCalled();
  });
});

describe('placing a tab the browser moved between windows', () => {
  it('joins the space its new window shows', async () => {
    const { group } = installBrowser({
      session: { [activeSpaceKey(2)]: 'one', 'tabSpaceId:5': { spaceId: 'two', windowId: 1 } },
      tab: testTab({ id: 5, windowId: 2 }),
    });
    const { dependencies, router: tabRouter } = router();

    await tabRouter.placeAttached(5, 2);

    expect(group).toHaveBeenCalledWith({ createProperties: { windowId: 2 }, tabIds: 5 });
    expect(dependencies.syncTabBacking).toHaveBeenCalledWith(expect.objectContaining({ id: 5 }), 'one');
  });

  it('keeps its own space in a new window, which shows it once the drag lets go', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const { group } = installBrowser({
      session: { 'tabSpaceId:5': { spaceId: 'two', windowId: 1 } },
      tab: testTab({ active: true, id: 5, windowId: 2 }),
    });
    group.mockRejectedValueOnce(dragging()).mockRejectedValueOnce(dragging());
    const { dependencies, router: tabRouter } = router();

    const placed = tabRouter.placeAttached(5, 2);
    await vi.advanceTimersByTimeAsync(500);
    await placed;

    expect(group).toHaveBeenCalledTimes(3);
    expect(group).toHaveBeenLastCalledWith({ createProperties: { windowId: 2 }, tabIds: 5 });
    expect(dependencies.syncTabBacking).toHaveBeenCalledWith(expect.objectContaining({ id: 5 }), 'two');
    expect(dependencies.activateSpaceGroup).toHaveBeenCalledWith(expect.objectContaining({ id: 900 }), 5);
  });

  it('leaves a tab the drag carried on to its next attach', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const { group, moveTab } = installBrowser({
      session: { 'tabSpaceId:5': { spaceId: 'two', windowId: 1 } },
      tab: testTab({ id: 5, windowId: 2 }),
    });
    group.mockImplementationOnce(async () => {
      moveTab(3);
      throw dragging();
    });
    const { dependencies, router: tabRouter } = router();

    const placed = tabRouter.placeAttached(5, 2);
    await vi.advanceTimersByTimeAsync(250);
    await placed;

    expect(group).toHaveBeenCalledTimes(1);
    expect(dependencies.syncTabBacking).not.toHaveBeenCalled();
  });

  it('gives up on anything but a drag', async () => {
    const { group } = installBrowser({
      session: { 'tabSpaceId:5': { spaceId: 'two', windowId: 1 } },
      tab: testTab({ id: 5, windowId: 2 }),
    });
    group.mockRejectedValueOnce(new Error('No window with id: 2.'));
    const { router: tabRouter } = router();

    await expect(tabRouter.placeAttached(5, 2)).rejects.toThrow('No window with id: 2.');
    expect(group).toHaveBeenCalledTimes(1);
  });
});
