import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createTabIntentHandlers,
  type TabIntentHandlerDependencies,
} from './tabIntentHandlers';
import type { HyperModelPortClient } from './modelPort';

const client: HyperModelPortClient = {
  clientId: 'sidebar-client',
  role: 'sidebar',
  windowId: 3,
};

const queueMutation = <Result,>(operation: () => Promise<Result>) => operation();

const dependencies = (
  overrides: Partial<TabIntentHandlerDependencies> = {},
): TabIntentHandlerDependencies => ({
  activateRemoteTab: vi.fn(async () => undefined),
  adoptTabPositions: vi.fn(async () => undefined),
  closeTabs: vi.fn(async () => undefined),
  closeTabsInSpace: vi.fn(async () => undefined),
  deleteHistory: vi.fn(async () => undefined),
  expectAttachment: vi.fn(),
  getTabOwnership: vi.fn(async () => undefined),
  markIntentionalTab: vi.fn(),
  messages: { offer: vi.fn(() => 'message') },
  moveRemoteTabToWindow: vi.fn(async () => undefined),
  moveTabTreeNodes: vi.fn(async () => undefined),
  openNewTab: vi.fn(async () => undefined),
  queueMutation,
  forgetSearchSelection: vi.fn(async () => undefined),
  recordSearchSelection: vi.fn(async () => undefined),
  releaseSplitViews: vi.fn(async () => undefined),
  restoreSpaceTabs: vi.fn(async () => []),
  routeTab: vi.fn(async () => undefined),
  sharedDragTabIds: vi.fn(() => undefined),
  ...overrides,
});

let deps: TabIntentHandlerDependencies;
/** Handlers over default dependencies, left in `deps` for the test to inspect. */
const handlersWith = (overrides: Partial<TabIntentHandlerDependencies> = {}) =>
  createTabIntentHandlers(deps = dependencies(overrides));

/** A browser whose tab moves the test watches; `get` reads one tab. */
function stubTabMoves(get: (tabId: number) => Promise<unknown>, extra: Record<string, unknown> = {}) {
  const move = vi.fn(async () => undefined);
  vi.stubGlobal('browser', {
    ...extra,
    tabs: { get, move, query: async () => [], update: async () => undefined },
  });
  return move;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('tab intent handlers', () => {
  it('routes only unpinned tabs from the requesting window into an explicit space', async () => {
    const query = vi.fn(async () => [
      { id: 7, pinned: false },
      { id: 8, pinned: true },
      { id: 9, pinned: false },
    ]);
    vi.stubGlobal('browser', { tabs: { query } });
    const handler = handlersWith().setTabGroup!;

    await handler.run({ spaceId: 'personal', tabIds: [7, 8, 7, 9] }, client);

    expect(query).toHaveBeenCalledWith({ windowId: 3 });
    expect(deps.releaseSplitViews).toHaveBeenCalledWith([7, 9]);
    expect(deps.routeTab).toHaveBeenCalledTimes(2);
    expect(deps.routeTab).toHaveBeenNthCalledWith(1, 7, 'personal');
    expect(deps.routeTab).toHaveBeenNthCalledWith(2, 9, 'personal');
    expect(handler.targets({ spaceId: 'personal', tabIds: [7, 9] }, client)).toEqual([
      'tab:7',
      'tab:9',
      'space:personal',
      'window:3',
    ]);
  });

  it('routes a created tab through the active-space path before returning it', async () => {
    const created = { id: 11, windowId: 3 };
    const get = vi.fn(async () => ({ ...created, title: 'New tab' }));
    const create = vi.fn(async () => created);
    const markIntentionalTab = vi.fn();
    const routeTab = vi.fn(async () => undefined);
    vi.stubGlobal('browser', { tabs: { create, get } });
    const handler = createTabIntentHandlers(
      dependencies({ markIntentionalTab, routeTab }),
    ).createTab!;

    await expect(handler.run({}, client)).resolves.toEqual({ ...created, title: 'New tab' });
    expect(create).toHaveBeenCalledWith({ active: true, windowId: 3 });
    expect(markIntentionalTab).toHaveBeenCalledWith(11);
    expect(routeTab).toHaveBeenCalledWith(11);
  });

  it('focuses only a tab from the client window and delegates mute and history deletion', async () => {
    const get = vi.fn(async () => ({ id: 12, windowId: 3 }));
    const update = vi.fn(async () => undefined);
    const focusWindow = vi.fn(async () => undefined);
    vi.stubGlobal('browser', {
      tabs: { get, update },
      windows: { update: focusWindow },
    });
    const handlers = handlersWith();

    await handlers.activateTab!.run({ tabId: 12 }, client);
    await handlers.setTabMuted!.run({ muted: true, tabId: 12 }, client);
    await handlers.deleteHistory!.run({ url: 'https://example.test' }, client);

    expect(update).toHaveBeenNthCalledWith(1, 12, { active: true });
    expect(focusWindow).not.toHaveBeenCalled();
    expect(update).toHaveBeenNthCalledWith(2, 12, { muted: true });
    expect(deps.deleteHistory).toHaveBeenCalledWith('https://example.test');
  });

  it.each([
    { label: 'another window', tab: { id: 12, windowId: 4 } },
    { label: 'an incognito window', tab: { id: 12, incognito: true, windowId: 3 } },
  ])('mutes no tab in $label', async ({ tab }) => {
    const update = vi.fn(async () => undefined);
    vi.stubGlobal('browser', { tabs: { get: vi.fn(async () => tab), update } });
    const handlers = createTabIntentHandlers(dependencies());

    await expect(handlers.setTabMuted!.run({ muted: true, tabId: 12 }, client))
      .rejects.toThrow('The tab is not visible in this client window.');
    expect(update).not.toHaveBeenCalled();
  });

  it('closes the new tab page that hands the user to an open tab', async () => {
    const removed = new Set<number>();
    const get = vi.fn(async (tabId: number) => {
      if (removed.has(tabId)) throw new Error('No tab');
      return { id: tabId, windowId: 3 };
    });
    const remove = vi.fn(async (tabId: number) => void removed.add(tabId));
    const update = vi.fn(async () => undefined);
    vi.stubGlobal('browser', {
      tabs: { get, query: vi.fn(async () => [{ id: 12 }, { id: 20 }]), remove, update },
      windows: { update: vi.fn(async () => undefined) },
    });
    const handlers = createTabIntentHandlers(dependencies());
    const newTabClient = { ...client, role: 'newtab' as const, tabId: 20 };

    await handlers.activateTab!.run({ tabId: 12 }, newTabClient);
    await handlers.activateTab!.run({ tabId: 12 }, client);

    expect(update).toHaveBeenCalledWith(12, { active: true });
    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith(20);
    expect(handlers.activateTab!.targets({ tabId: 12 }, newTabClient))
      .toEqual(['tab:12', 'window:3', 'tab:20']);
    expect(handlers.activateTab!.targets({ tabId: 20 }, newTabClient))
      .toEqual(['tab:20', 'window:3']);
  });

  it('delegates selection recording without assigning a domain target', async () => {
    const handlers = handlersWith();

    await handlers.recordSearchSelection!.run({
      query: 'design',
      resultId: 'command:open-design',
    }, client);

    expect(deps.recordSearchSelection).toHaveBeenCalledWith('design', 'command:open-design');
    expect(handlers.recordSearchSelection!.targets({
      query: 'design',
      resultId: 'command:open-design',
    }, client)).toEqual([]);
  });

  it('delegates forgetting a search selection without assigning a domain target', async () => {
    const handlers = handlersWith();

    await handlers.forgetSearchSelection!.run({ resultId: 'tab:https://mail.example/' }, client);

    expect(deps.forgetSearchSelection).toHaveBeenCalledWith('tab:https://mail.example/');
    expect(handlers.forgetSearchSelection!.targets({ resultId: 'tab:https://mail.example/' }, client))
      .toEqual([]);
  });

  it('navigates the client tab and routes URL navigations through the model lane', async () => {
    const update = vi.fn(async () => undefined);
    const query = vi.fn(async () => undefined);
    vi.stubGlobal('browser', { search: { query }, tabs: { update } });
    const handlers = handlersWith();
    const newTabClient = { ...client, role: 'newtab' as const, tabId: 12 };

    await handlers.navigateTab!.run({ kind: 'url', url: 'https://example.test' }, newTabClient);
    await handlers.navigateTab!.run({ kind: 'search', query: 'weather tomorrow' }, newTabClient);
    await handlers.navigateTab!.run(
      { kind: 'url', newTab: true, url: 'https://example.test/copy' },
      newTabClient,
    );

    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith(12, { url: 'https://example.test' });
    expect(deps.openNewTab).toHaveBeenCalledWith('https://example.test/copy', 3);
    expect(deps.routeTab).toHaveBeenCalledWith(12);
    expect(query).toHaveBeenCalledWith({ tabId: 12, text: 'weather tomorrow' });
    expect(handlers.navigateTab!.targets({ kind: 'url', url: 'https://example.test' }, newTabClient))
      .toEqual(['tab:12', 'window:3']);
  });

  it('sends a tab elsewhere at once, however much upkeep is queued ahead of it', async () => {
    const update = vi.fn(async () => undefined);
    const query = vi.fn(async () => undefined);
    vi.stubGlobal('browser', { search: { query }, tabs: { update } });
    const handlers = createTabIntentHandlers(dependencies({
      queueMutation: () => new Promise(() => undefined),
    }));
    const newTabClient = { ...client, role: 'newtab' as const, tabId: 12 };

    await handlers.navigateTab!.run({ kind: 'search', query: 'weather tomorrow' }, newTabClient);
    void handlers.navigateTab!.run({ kind: 'url', url: 'https://example.test' }, newTabClient);

    expect(query).toHaveBeenCalledWith({ tabId: 12, text: 'weather tomorrow' });
    await vi.waitFor(() => expect(update).toHaveBeenCalledWith(12, { url: 'https://example.test' }));
  });

  it('opens a search in a new tab as one intent and closes the tab if the search fails', async () => {
    const create = vi.fn(async () => ({ id: 21, windowId: 3 }));
    const get = vi.fn(async () => ({ id: 21, windowId: 3 }));
    const remove = vi.fn(async () => undefined);
    const query = vi.fn(async () => undefined);
    vi.stubGlobal('browser', { search: { query }, tabs: { create, get, remove } });
    const handlers = handlersWith();
    const search = { kind: 'search' as const, newTab: true, query: 'weather tomorrow' };

    await handlers.navigateTab!.run(search, client);
    expect(create).toHaveBeenCalledWith({ active: true, windowId: 3 });
    expect(deps.routeTab).toHaveBeenCalledWith(21);
    expect(query).toHaveBeenCalledWith({ tabId: 21, text: 'weather tomorrow' });
    expect(handlers.navigateTab!.targets(search, client)).toEqual(['window:3']);

    query.mockRejectedValueOnce(new Error('No search engine'));
    await expect(handlers.navigateTab!.run(search, client)).rejects.toThrow('No search engine');
    expect(remove).toHaveBeenCalledWith(21);
  });

  it('delegates opaque remote operations only for a sidebar client', async () => {
    const activateRemoteTab = vi.fn(async () => undefined);
    const moveRemoteTabToWindow = vi.fn(async () => undefined);
    const handlers = createTabIntentHandlers(
      dependencies({ activateRemoteTab, moveRemoteTabToWindow }),
    );
    const payload = { source: { kind: 'tab' as const, tabId: 12 }, spaceId: 'two' };
    const effects = { check: vi.fn(), extend: vi.fn(), step: vi.fn() };

    await handlers.activateTab!.run({ operation: 'remote', ...payload }, client, effects);
    await handlers.moveTabToWindow!.run(payload, client, effects);

    expect(activateRemoteTab).toHaveBeenCalledWith(
      payload,
      client,
      effects,
    );
    expect(moveRemoteTabToWindow).toHaveBeenCalledWith(payload, client, effects);
    await expect(handlers.activateTab!.run(
      { operation: 'remote', ...payload },
      { ...client, role: 'page-search' },
      effects,
    )).rejects.toThrow(/sidebar/);
  });

  it('closes named tabs, or a page wherever a space has it open for any Search', async () => {
    vi.stubGlobal('browser', { tabs: { get: async () => { throw new Error('No tab.'); } } });
    const handler = handlersWith().closeTabs!;
    const inSpace = {
      condition: 'page-in-space' as const,
      source: { kind: 'tab' as const, tabId: 12 },
      spaceId: 'two',
    };
    const effects = { check: vi.fn(), extend: vi.fn(), step: vi.fn() };
    const pageSearch = { ...client, role: 'page-search' as const };

    await handler.run({ tabIds: [7, 8] }, client);
    await handler.run(inSpace, client, effects);
    await handler.run(inSpace, pageSearch, effects);

    expect(deps.closeTabs).toHaveBeenCalledWith([7, 8]);
    expect(deps.closeTabsInSpace).toHaveBeenCalledWith(inSpace, client, effects);
    expect(deps.closeTabsInSpace).toHaveBeenCalledWith(inSpace, pageSearch, effects);
    expect(handler.targets({ tabIds: [7, 8] }, client)).toEqual(['tab:7', 'tab:8']);
    expect(handler.targets(inSpace, client)).toEqual(['tab:12', 'space:two', 'window:3']);
    await expect(handler.run(inSpace, client)).rejects.toThrow();
    expect(deps.closeTabsInSpace).toHaveBeenCalledTimes(2);
  });

  it('brings tabs from another window into a space, where they were dropped', async () => {
    const tabs = [{ id: 7, index: 0, windowId: 1 }, { id: 8, index: 4, windowId: 3 }];
    const move = stubTabMoves(async (tabId) => tabs.find((tab) => tab.id === tabId));
    const getTabOwnership = vi.fn(async (tabId: number) => tabId === 7
      ? { backingId: 'backing-7', spaceId: 'personal' }
      : { spaceId: 'personal' });
    const handler = handlersWith({
      getTabOwnership,
    }).moveTabs!;
    const payload = {
      index: 2,
      tabIds: [7, 8],
      tree: { index: 1, parentId: 'folder', spaceId: 'personal' },
      windowId: 3,
    };

    await handler.run(payload, client);

    expect(deps.expectAttachment).toHaveBeenCalledExactlyOnceWith(7, 3);
    expect(move).toHaveBeenCalledWith([7, 8], { index: 2, windowId: 3 });
    expect(deps.routeTab).toHaveBeenNthCalledWith(1, 7, 'personal');
    expect(deps.routeTab).toHaveBeenNthCalledWith(2, 8, 'personal');
    expect(deps.moveTabTreeNodes).toHaveBeenCalledWith('personal', ['backing-7'], {
      index: 1,
      parentId: 'folder',
    });
    expect(deps.adoptTabPositions).not.toHaveBeenCalled();
    expect(handler.targets(payload, client)).toEqual(['tab:7', 'tab:8', 'window:3', 'space:personal']);

    // A tab strip move with no place in the tree gives the list the strip's order.
    await handler.run({ index: 0, tabIds: [8], windowId: 3 }, client);
    expect(deps.routeTab).toHaveBeenCalledTimes(2);
    expect(deps.adoptTabPositions).toHaveBeenCalledExactlyOnceWith([8]);
    expect(() => handler.targets({ index: 0, tabIds: [8], tree: { parentId: '' }, windowId: 3 }, client))
      .toThrow();
  });

  it('moves the dragged tabs that still exist when one closed during the drag', async () => {
    const move = stubTabMoves(async (tabId) => {
      if (tabId === 8) throw new Error('No tab with id: 8.');
      return { id: tabId, index: 0, windowId: 3 };
    });
    const handler = handlersWith().moveTabs!;

    await handler.run({ index: 1, tabIds: [7, 8], windowId: 3 }, client);

    expect(move).toHaveBeenCalledWith([7], { index: 1, windowId: 3 });
    expect(deps.adoptTabPositions).toHaveBeenCalledExactlyOnceWith([7]);
    move.mockClear();
    await handler.run({ index: 1, tabIds: [8], windowId: 3 }, client);
    expect(move).not.toHaveBeenCalled();
  });

  it('takes a drag shared from another window by its token, only into the sidebar\'s own window', async () => {
    const move = stubTabMoves(async (tabId) => ({ id: tabId, index: 0, windowId: 1 }));
    const sharedDragTabIds = vi.fn((token: string, windowId: number) =>
      token === 'drag-1' && windowId === 3 ? [7, 8] : undefined);
    const handler = handlersWith({ sharedDragTabIds }).moveTabs!;
    const payload = { index: 1, sharedDrag: 'drag-1', tree: { spaceId: 'personal' }, windowId: 3 };

    expect(handler.targets(payload, client)).toEqual(['tab:7', 'tab:8', 'window:3', 'space:personal']);
    await handler.run(payload, client);
    expect(move).toHaveBeenCalledWith([7, 8], { index: 1, windowId: 3 });
    expect(deps.adoptTabPositions).toHaveBeenCalledExactlyOnceWith([7, 8]);
    expect(() => handler.targets({ ...payload, windowId: 4 }, client)).toThrow();
    expect(() => handler.targets({ ...payload, sharedDrag: 'drag-2' }, client)).toThrow();
  });

  it('offers to undo a tab move within its window by putting its backing back', async () => {
    const children: Record<string, string[]> = { tabs: ['a', 'b', 'c'] };
    const parentOf = (id: string) => Object.keys(children).find((parentId) => children[parentId]!.includes(id));
    const moveBacking = (id: string, { index, parentId }: { index?: number; parentId: string }) => {
      const from = children[parentOf(id)!]!;
      from.splice(from.indexOf(id), 1);
      const to = children[parentId]!;
      to.splice(index ?? to.length, 0, id);
    };
    stubTabMoves(async (tabId) => ({ id: tabId, index: 0, windowId: 3 }), {
      bookmarks: {
        get: async (id: string) => {
          const parentId = parentOf(id);
          return parentId ? [{ id, parentId, title: `Tab ${id}`, url: `https://${id}.test/` }] : [];
        },
        getChildren: async (parentId: string) => (children[parentId] ?? []).map((id) => ({ id, parentId })),
        move: async (id: string, destination: { index?: number; parentId: string }) => moveBacking(id, destination),
      },
    });
    const offer = vi.fn((_windowId: number, _offer: { act(remade: Map<string, string>): Promise<void>; kind: string; text: string }) => 'message');
    // The strip's new position is taken into the list by moving the tab's backing.
    const adoptTabPositions = vi.fn(async () => moveBacking('a', { parentId: 'tabs' }));
    const handler = createTabIntentHandlers(dependencies({
      adoptTabPositions,
      getTabOwnership: vi.fn(async (tabId: number) => ({ backingId: tabId === 7 ? 'a' : 'z', spaceId: 'personal' })),
      messages: { offer },
    })).moveTabs!;

    await handler.run({ index: 5, tabIds: [7], windowId: 3 }, client);

    expect(children.tabs).toEqual(['b', 'c', 'a']);
    expect(offer).toHaveBeenCalledExactlyOnceWith(3, expect.objectContaining({
      detail: 'Tab a',
      kind: 'undo',
      text: 'Moved tab',
    }));
    await offer.mock.calls[0]![1].act(new Map());
    expect(children.tabs).toEqual(['a', 'b', 'c']);

    // A move that leaves the list as it was has nothing to undo.
    offer.mockClear();
    adoptTabPositions.mockImplementation(async () => undefined);
    await handler.run({ index: 0, tabIds: [7], windowId: 3 }, client);
    expect(offer).not.toHaveBeenCalled();
  });

  it('offers no undo for tabs brought from another window', async () => {
    stubTabMoves(async (tabId) => ({ id: tabId, index: 0, windowId: 1 }));
    const offer = vi.fn(() => 'message');
    const getTabOwnership = vi.fn(async () => ({ backingId: 'a', spaceId: 'personal' }));
    const handler = createTabIntentHandlers(dependencies({ getTabOwnership, messages: { offer } })).moveTabs!;

    await handler.run({ index: 0, tabIds: [7], tree: { spaceId: 'personal' }, windowId: 3 }, client);

    expect(offer).not.toHaveBeenCalled();
  });
});