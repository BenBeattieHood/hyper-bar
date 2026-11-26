import {
  autoTabFolderIdentity,
  projectAutoTabFolders,
  type AutoTabFolderIdentity,
} from './autoTabFolders';
import {
  buildNodeMap,
  deriveWindowSpaceTabTree,
  isSplitViewFolder,
  type BookmarkNode,
  type BrowserTab,
} from './bookmarks';
import type { TabOwnership } from './tabOwnership';

export interface SpaceTabListOrderInput {
  autofolders: boolean;
  bookmarkTree: BookmarkNode[];
  /** Each tab's site as of its last completed navigation, so a loading tab keeps its folder. */
  identities: ReadonlyMap<number, AutoTabFolderIdentity>;
  ownerships: Readonly<Record<number, TabOwnership>>;
  spaceId: string;
  tabs: readonly BrowserTab[];
  windowId: number;
}

const byIndex = (left: BrowserTab, right: BrowserTab) => left.index - right.index;

/**
 * The space's backed tabs in a window, in the order its Tabs list shows them:
 * its tab tree depth first, gathered into site folders when autofolders are on.
 * A tab with no backing yet has no place in the model, so it is left out.
 */
export function spaceTabListOrder({
  autofolders,
  bookmarkTree,
  identities,
  ownerships,
  spaceId,
  tabs,
  windowId,
}: SpaceTabListOrderInput): number[] {
  const tabByBackingId = new Map(tabs
    .filter((tab) => tab.id !== undefined && tab.windowId === windowId &&
      ownerships[tab.id]?.spaceId === spaceId)
    .sort(byIndex)
    .flatMap((tab) => {
      const backingId = ownerships[tab.id!]?.backingId;
      return backingId ? [[backingId, tab] as const] : [];
    }));
  const tree = deriveWindowSpaceTabTree(bookmarkTree, spaceId, new Set(tabByBackingId.keys()));
  if (!tree.rootId) return [];
  const nodes = autofolders
    ? projectAutoTabFolders(tree.nodes, tree.rootId, (node) => {
        const tab = tabByBackingId.get(node.id);
        if (tab?.id === undefined) return undefined;
        return identities.get(tab.id) ?? autoTabFolderIdentity(tab);
      }).nodes
    : tree.nodes;
  const order: number[] = [];
  const visit = (children: readonly BookmarkNode[]) => {
    for (const node of children) {
      const tabId = tabByBackingId.get(node.id)?.id;
      if (tabId !== undefined) order.push(tabId);
      visit(node.children ?? []);
    }
  };
  visit(nodes);
  return order;
}

/** Positions of `values` that form a longest increasing run, which can stay where they are. */
function longestIncreasingRun(values: readonly number[]): Set<number> {
  const tails: number[] = [];
  const previous = new Array<number>(values.length).fill(-1);
  values.forEach((value, position) => {
    let low = 0;
    let high = tails.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (values[tails[middle]!]! < value) low = middle + 1;
      else high = middle;
    }
    if (low > 0) previous[position] = tails[low - 1]!;
    tails[low] = position;
  });
  const kept = new Set<number>();
  for (let position = tails.at(-1) ?? -1; position >= 0; position = previous[position]!) {
    kept.add(position);
  }
  return kept;
}

export interface TabStripMove {
  tabId: number;
  index: number;
}

/**
 * The next single move that brings a window's tab strip closer to `desired`,
 * or nothing when its tabs already sit in that relative order. Other tabs keep
 * their places, and pinned and unpinned tabs are each ordered among themselves.
 * Moving only the tabs outside a longest in-order run keeps the moves fewest.
 */
export function nextTabStripMove(
  windowTabs: readonly BrowserTab[],
  desired: readonly number[],
): TabStripMove | undefined {
  const tabsById = new Map(windowTabs.flatMap((tab) =>
    tab.id === undefined ? [] : [[tab.id, tab] as const]));
  for (const pinned of [true, false]) {
    const wanted = desired.filter((tabId) => tabsById.get(tabId)?.pinned === pinned);
    if (wanted.length < 2) continue;
    const rank = new Map(wanted.map((tabId, position) => [tabId, position]));
    const current = wanted.map((tabId) => tabsById.get(tabId)!).sort(byIndex);
    const kept = longestIncreasingRun(current.map((tab) => rank.get(tab.id!)!));
    if (kept.size === wanted.length) continue;
    const keptIds = new Set([...kept].map((position) => current[position]!.id!));
    const position = wanted.findIndex((tabId) => !keptIds.has(tabId));
    const tab = tabsById.get(wanted[position]!)!;
    if (position > 0) {
      const after = tabsById.get(wanted[position - 1]!)!;
      return { tabId: tab.id!, index: tab.index < after.index ? after.index : after.index + 1 };
    }
    // The first tab out of place goes before the first tab that is already in place.
    const before = tabsById.get(wanted.find((tabId) => keptIds.has(tabId))!)!;
    return { tabId: tab.id!, index: tab.index < before.index ? before.index - 1 : before.index };
  }
  return undefined;
}

export interface TabStripAdoption {
  nodeId: string;
  destination: { parentId: string; index: number };
}

/**
 * Where a tab's tree node goes so the list takes the place the tab was given
 * in the tab strip: beside the tabs now either side of it, preferring to stay
 * in its own folder. Nothing, when those neighbours already match the list.
 */
export function planTabStripAdoption(
  tabId: number,
  windowTabs: readonly BrowserTab[],
  ownerships: Readonly<Record<number, TabOwnership>>,
  desired: readonly number[],
  bookmarkTree: BookmarkNode[],
  /** Tabs moving with this one that are still to be placed, so are no neighbours yet. */
  unplaced: ReadonlySet<number> = new Set(),
): TabStripAdoption | undefined {
  const nodes = buildNodeMap(bookmarkTree);
  const ownership = ownerships[tabId];
  const tab = windowTabs.find((candidate) => candidate.id === tabId);
  const backing = ownership?.backingId ? nodes.get(ownership.backingId) : undefined;
  if (!tab || !backing) return undefined;
  // A split view's tabs move as their folder, which never splits.
  const unitOf = (node: BookmarkNode) => {
    const parent = node.parentId ? nodes.get(node.parentId) : undefined;
    return parent && isSplitViewFolder(parent) ? parent : node;
  };
  const unit = unitOf(backing);
  const unitOfTab = (candidateId: number | undefined) => {
    const backingId = candidateId === undefined ? undefined : ownerships[candidateId]?.backingId;
    const node = backingId ? nodes.get(backingId) : undefined;
    return node ? unitOf(node) : undefined;
  };
  const listed = new Set(desired);
  const pinnedById = new Map(windowTabs.map((windowTab) => [windowTab.id, windowTab.pinned]));
  const neighbour = (candidateId: number) => !unplaced.has(candidateId) &&
    pinnedById.get(candidateId) === tab.pinned && unitOfTab(candidateId)?.id !== unit.id;
  const neighbours = (order: readonly number[]) => {
    const at = order.indexOf(tabId);
    return [
      unitOfTab(order.slice(0, at).findLast(neighbour)),
      unitOfTab(order.slice(at + 1).find(neighbour)),
    ] as const;
  };
  const strip = [...windowTabs].sort(byIndex)
    .flatMap((candidate) => candidate.id !== undefined && listed.has(candidate.id) ? [candidate.id] : []);
  if (!strip.includes(tabId) || !desired.includes(tabId)) return undefined;
  const [previous, next] = neighbours(strip);
  const [wantedPrevious, wantedNext] = neighbours(desired);
  if (previous?.id === wantedPrevious?.id && next?.id === wantedNext?.id) return undefined;

  const inUnitParent = (node: BookmarkNode | undefined) => {
    for (let current = node; current; current = current.parentId ? nodes.get(current.parentId) : undefined) {
      if (current.parentId === unit.parentId) return current;
    }
    return undefined;
  };
  const after = (node: BookmarkNode) => ({ parentId: node.parentId!, index: node.index! + 1 });
  const before = (node: BookmarkNode) => ({ parentId: node.parentId!, index: node.index! });
  const previousHere = inUnitParent(previous);
  const nextHere = inUnitParent(next);
  const destination = previous && next && previous.parentId === next.parentId
    ? before(next)
    : previousHere
      ? after(previousHere)
      : nextHere
        ? before(nextHere)
        : previous
          ? after(previous)
          : next
            ? before(next)
            : undefined;
  return destination && unit.parentId ? { nodeId: unit.id, destination } : undefined;
}
