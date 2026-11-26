import { afterEach, describe, expect, it, vi } from 'vitest';
import { deriveSpaces, type BookmarkNode } from './bookmarks';
import { createSpaceGroupOrder } from './spaceGroupOrder';
import { spaceGroupKey } from './spaceGroupStore';
import { hyperGroupTitle } from './tabGroups';
import { hyperBookmarkTree } from './testBookmarkTree';
import { fakeStorageArea } from './testFixtures';

const WINDOW_ID = 1;

interface FakeTab {
  groupId: number;
  id: number;
  index: number;
  windowId: number;
}

function spaceTree(spaceIds: readonly string[]): BookmarkNode[] {
  return hyperBookmarkTree(spaceIds.map((id) => ({ id, title: id, children: [] })));
}

/** A window whose groups each hold one tab, laid out in the given group order. */
function installBrowser(options: {
  groupOrder: readonly number[];
  groupBySpace: Record<string, number>;
  spaceIds: readonly string[];
  titles?: Record<number, string>;
}) {
  let spaceIds = [...options.spaceIds];
  let tabs: FakeTab[] = options.groupOrder.map((groupId, index) => ({
    groupId,
    id: 100 + groupId,
    index,
    windowId: WINDOW_ID,
  }));
  const titles = new Map(Object.entries(options.titles ?? {}).map(([id, title]) => [Number(id), title]));
  const session = Object.fromEntries(Object.entries(options.groupBySpace)
    .map(([spaceId, groupId]) => [spaceGroupKey(spaceId, WINDOW_ID), groupId]));
  const move = vi.fn(async (groupId: number, { index }: { index: number }) => {
    const moving = tabs.filter((tab) => tab.groupId === groupId);
    const rest = tabs.filter((tab) => tab.groupId !== groupId);
    rest.splice(index, 0, ...moving);
    tabs = rest.map((tab, position) => ({ ...tab, index: position }));
  });
  const update = vi.fn(async (groupId: number, { title }: { title: string }) => {
    titles.set(groupId, title);
  });
  const bookmarkMove = vi.fn(async (id: string, { index }: { index: number }) => {
    const sourceIndex = spaceIds.indexOf(id);
    spaceIds.splice(sourceIndex, 1);
    spaceIds.splice(sourceIndex < index ? index - 1 : index, 0, id);
  });
  vi.stubGlobal('browser', {
    bookmarks: { getTree: async () => spaceTree(spaceIds), move: bookmarkMove },
    storage: { session: fakeStorageArea(session) },
    tabGroups: {
      move,
      query: async () => [...new Set(tabs.map((tab) => tab.groupId))]
        .map((id) => ({ id, title: titles.get(id), windowId: WINDOW_ID })),
      update,
    },
    tabs: { query: async () => tabs },
    windows: { getAll: async () => [{ id: WINDOW_ID }] },
  });
  return {
    bookmarkMove,
    groupOrder: () => [...new Set(tabs.map((tab) => tab.groupId))],
    spaceIds: () => spaceIds,
    titles,
    update,
  };
}

function groupOrder() {
  const dependencies = {
    beginProgrammaticGroupUpdate: vi.fn(),
    endProgrammaticGroupUpdate: vi.fn(async () => undefined),
  };
  return { dependencies, order: createSpaceGroupOrder(dependencies) };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('space group order', () => {
  it('moves groups into space order and titles them by position', async () => {
    const browser = installBrowser({
      groupOrder: [30, 10, 20],
      groupBySpace: { one: 10, three: 30, two: 20 },
      spaceIds: ['one', 'two', 'three'],
    });
    const { dependencies, order } = groupOrder();

    await order.reconcileAll(deriveSpaces(spaceTree(['one', 'two', 'three'])));

    expect(browser.groupOrder()).toEqual([10, 20, 30]);
    expect([10, 20, 30].map((groupId) => browser.titles.get(groupId)))
      .toEqual([hyperGroupTitle(0), hyperGroupTitle(1), hyperGroupTitle(2)]);
    expect(dependencies.beginProgrammaticGroupUpdate).toHaveBeenCalledTimes(3);
    expect(dependencies.endProgrammaticGroupUpdate).toHaveBeenCalledTimes(3);
  });

  it('leaves groups that already match alone', async () => {
    const browser = installBrowser({
      groupOrder: [10, 20],
      groupBySpace: { one: 10, two: 20 },
      spaceIds: ['one', 'two'],
      titles: { 10: hyperGroupTitle(0), 20: hyperGroupTitle(1) },
    });
    const { dependencies, order } = groupOrder();

    await order.reconcileAll(deriveSpaces(spaceTree(['one', 'two'])));

    expect(browser.update).not.toHaveBeenCalled();
    expect(dependencies.beginProgrammaticGroupUpdate).not.toHaveBeenCalled();
  });

  it('reorders spaces to follow a group the user dragged', async () => {
    const browser = installBrowser({
      groupOrder: [20, 10],
      groupBySpace: { one: 10, two: 20 },
      spaceIds: ['one', 'two'],
    });
    const { order } = groupOrder();

    await order.reorderSpacesFromWindow(WINDOW_ID);

    expect(browser.spaceIds()).toEqual(['two', 'one']);
    expect(browser.titles.get(20)).toBe(hyperGroupTitle(0));
    expect(browser.titles.get(10)).toBe(hyperGroupTitle(1));
  });

  it('keeps space order when the groups already follow it', async () => {
    const browser = installBrowser({
      groupOrder: [10, 20],
      groupBySpace: { one: 10, two: 20 },
      spaceIds: ['one', 'two'],
    });

    await groupOrder().order.reorderSpacesFromWindow(WINDOW_ID);

    expect(browser.bookmarkMove).not.toHaveBeenCalled();
  });
});
