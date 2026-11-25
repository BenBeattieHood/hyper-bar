import { describe, expect, it } from 'vitest';
import {
  serializeBookmarkTitle,
  splitViewFolderBookmarkTitle,
  tabBackingBookmarkTitle,
  tabFolderBookmarkTitle,
  type BookmarkNode,
  type BrowserTab,
} from './bookmarks';
import { testTab } from './testFixtures';
import type { TabOwnership } from './tabOwnership';
import { nextTabStripMove, planTabStripAdoption, spaceTabListOrder } from './tabStripOrder';

type Spec = string | [title: string, children: Spec[]];

/** A space's tab tree, where a string is a backing and a pair is a tab folder. */
function spaceTree(spaceId: string, specs: Spec[]): BookmarkNode[] {
  const build = (spec: Spec, parentId: string, index: number): BookmarkNode => {
    if (typeof spec === 'string') {
      return {
        id: spec,
        index,
        parentId,
        syncing: false,
        title: tabBackingBookmarkTitle(spec),
        url: `https://${spec.replace(/\d+$/, '')}.test/${spec}`,
      };
    }
    const [title, children] = spec;
    return {
      children: children.map((child, childIndex) => build(child, title, childIndex)),
      id: title,
      index,
      parentId,
      syncing: false,
      title: title.startsWith('split') ? splitViewFolderBookmarkTitle() : tabFolderBookmarkTitle(title),
    };
  };
  const tabsRoot: BookmarkNode = {
    children: specs.map((spec, index) => build(spec, 'tabs-root', index)),
    id: 'tabs-root',
    index: 0,
    parentId: spaceId,
    syncing: false,
    title: serializeBookmarkTitle('tabs', { hyper: { spaceTabs: true } }),
  };
  return [{
    children: [{ children: [tabsRoot], id: spaceId, parentId: 'root', syncing: false, title: 'Space' }],
    id: 'root',
    syncing: false,
    title: 'Root',
  }];
}

/** Tabs in strip order, each backed by the bookmark of the same name. */
function strip(names: Array<string | { name: string; pinned?: boolean; space?: string; url?: string }>) {
  const tabs: BrowserTab[] = [];
  const ownerships: Record<number, TabOwnership> = {};
  const ids = new Map<string, number>();
  names.forEach((entry, index) => {
    const { name, pinned = false, space = 'work', url } = typeof entry === 'string' ? { name: entry } : entry;
    const id = index + 1;
    ids.set(name, id);
    tabs.push(testTab({
      id,
      index,
      pinned,
      status: 'complete',
      url: url ?? `https://${name.replace(/\d+$/, '')}.test/${name}`,
    }));
    if (!name.startsWith('unbacked')) ownerships[id] = { backingId: name, spaceId: space };
  });
  const names_ = (tabIds: readonly number[]) =>
    tabIds.map((tabId) => [...ids].find(([, id]) => id === tabId)![0]);
  return { ids, names: names_, ownerships, tabs };
}

const listOrder = (
  bookmarkTree: BookmarkNode[],
  { ownerships, tabs }: ReturnType<typeof strip>,
  autofolders = false,
) => spaceTabListOrder({
  autofolders,
  bookmarkTree,
  identities: new Map(),
  ownerships,
  spaceId: 'work',
  tabs,
  windowId: 1,
});

/** Applies planned moves the way the browser does, until the strip is in order. */
function settle(tabs: BrowserTab[], desired: readonly number[]) {
  let current = [...tabs];
  let moves = 0;
  for (let move = nextTabStripMove(current, desired); move; move = nextTabStripMove(current, desired)) {
    const tab = current.find((candidate) => candidate.id === move!.tabId)!;
    const rest = current.filter((candidate) => candidate !== tab);
    rest.splice(move.index, 0, tab);
    current = rest.map((candidate, index) => ({ ...candidate, index }));
    moves += 1;
    if (moves > 20) throw new Error('The strip never settled');
  }
  return { moves, order: current.map((tab) => tab.id!) };
}

describe('spaceTabListOrder', () => {
  it('lists backed tabs depth first in tree order, leaving out unbacked and other spaces', () => {
    const tree = spaceTree('work', ['b', ['Folder', ['c', 'a']], 'd']);
    const tabs = strip(['a', 'b', { name: 'other', space: 'play' }, 'c', 'unbacked', 'd']);

    expect(tabs.names(listOrder(tree, tabs))).toEqual(['b', 'c', 'a', 'd']);
  });

  it('gathers root tabs into site folders at the first of each site when autofolders are on', () => {
    const tree = spaceTree('work', ['alpha1', 'beta1', 'alpha2', ['Folder', ['alpha3']]]);
    const tabs = strip(['alpha1', 'beta1', 'alpha2', 'alpha3']);

    expect(tabs.names(listOrder(tree, tabs, true))).toEqual(['alpha1', 'alpha2', 'beta1', 'alpha3']);
    expect(tabs.names(listOrder(tree, tabs))).toEqual(['alpha1', 'beta1', 'alpha2', 'alpha3']);
  });

  it('keeps a loading tab in the site folder of its last completed page', () => {
    const tree = spaceTree('work', ['alpha1', 'beta1', 'alpha2']);
    const tabs = strip(['alpha1', 'beta1', 'alpha2']);
    const loading = tabs.tabs.map((tab) => tab.id === 1
      ? { ...tab, pendingUrl: 'https://beta.test/next', status: 'loading' as const, url: 'https://beta.test/next' }
      : tab);
    const order = (identities: Parameters<typeof spaceTabListOrder>[0]['identities']) =>
      tabs.names(spaceTabListOrder({
        autofolders: true,
        bookmarkTree: tree,
        identities,
        ownerships: tabs.ownerships,
        spaceId: 'work',
        tabs: loading,
        windowId: 1,
      }));

    expect(order(new Map([[1, { key: 'host:alpha.test', title: 'alpha.test' }]])))
      .toEqual(['alpha1', 'alpha2', 'beta1']);
    expect(order(new Map())).toEqual(['alpha1', 'beta1', 'alpha2']);
  });
});

describe('nextTabStripMove', () => {
  it('moves only the tabs out of place, leaving other spaces\' tabs where they are', () => {
    const tabs = strip(['a', 'b', { name: 'other', space: 'play' }, 'c', 'd']);
    const [a, b, other, c, d] = [1, 2, 3, 4, 5];

    expect(settle(tabs.tabs, [b, c, d, a])).toEqual({ moves: 1, order: [b, other, c, d, a] });
    expect(settle(tabs.tabs, [d, a, b, c])).toEqual({ moves: 1, order: [d, a, b, other, c] });
    expect(settle(tabs.tabs, [d, c, b, a]).order.filter((id) => id !== other)).toEqual([d, c, b, a]);
    expect(nextTabStripMove(tabs.tabs, [a, b, c, d])).toBeUndefined();
  });

  it('orders pinned and unpinned tabs each among themselves', () => {
    const tabs = strip([{ name: 'p1', pinned: true }, { name: 'p2', pinned: true }, 'a', 'b']);

    expect(settle(tabs.tabs, [4, 2, 3, 1]).order).toEqual([2, 1, 4, 3]);
  });
});

describe('planTabStripAdoption', () => {
  const adopt = (
    tree: BookmarkNode[],
    tabs: ReturnType<typeof strip>,
    name: string,
    unplaced: string[] = [],
  ) => planTabStripAdoption(
    tabs.ids.get(name)!,
    tabs.tabs,
    tabs.ownerships,
    listOrder(tree, tabs),
    tree,
    new Set(unplaced.map((other) => tabs.ids.get(other)!)),
  );

  it('does nothing when the tab already sits between its list neighbours', () => {
    const tree = spaceTree('work', ['a', 'b', 'c']);
    expect(adopt(tree, strip(['a', { name: 'x', space: 'play' }, 'b', 'c']), 'b')).toBeUndefined();
  });

  it('puts a tab before its new strip neighbour in its own folder', () => {
    const tree = spaceTree('work', ['a', 'b', 'c']);
    expect(adopt(tree, strip(['b', 'c', 'a']), 'a'))
      .toEqual({ nodeId: 'a', destination: { parentId: 'tabs-root', index: 3 } });
    expect(adopt(tree, strip(['c', 'a', 'b']), 'c'))
      .toEqual({ nodeId: 'c', destination: { parentId: 'tabs-root', index: 0 } });
  });

  it('files a tab dropped between two tabs of a folder into that folder', () => {
    const tree = spaceTree('work', ['a', ['Folder', ['f1', 'f2']], 'b']);
    expect(adopt(tree, strip(['f1', 'a', 'f2', 'b']), 'a'))
      .toEqual({ nodeId: 'a', destination: { parentId: 'Folder', index: 1 } });
  });

  it('keeps a tab dropped at a folder\'s edge in its own folder, beside the folder', () => {
    const tree = spaceTree('work', ['a', ['Folder', ['f1', 'f2']], 'b']);
    expect(adopt(tree, strip(['f1', 'f2', 'b', 'a']), 'a'))
      .toEqual({ nodeId: 'a', destination: { parentId: 'tabs-root', index: 3 } });
    expect(adopt(tree, strip(['f1', 'f2', 'a', 'b']), 'a'))
      .toEqual({ nodeId: 'a', destination: { parentId: 'tabs-root', index: 2 } });
  });

  it('moves a split view tab as its whole split view folder', () => {
    const tree = spaceTree('work', ['a', ['split', ['s1', 's2']], 'b']);
    expect(adopt(tree, strip(['s1', 's2', 'a', 'b']), 's1'))
      .toEqual({ nodeId: 'split', destination: { parentId: 'tabs-root', index: 0 } });
  });

  it('places tabs moved together each after the last, so they stay together', () => {
    const tree = spaceTree('work', ['a', 'b', 'c', 'd']);
    const tabs = strip(['c', 'a', 'b', 'd']);
    expect(adopt(tree, tabs, 'a', ['b']))
      .toEqual({ nodeId: 'a', destination: { parentId: 'tabs-root', index: 3 } });
  });
});
