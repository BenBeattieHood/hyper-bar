import type { BookmarkNode, BrowserTab } from '../../lib/bookmarks';
import { clamp } from '../../lib/collections';

export interface BookmarkMoveDestination {
  parentId?: string;
  index?: number;
}

export function activateTabOptimistically(
  tabs: BrowserTab[],
  tabId: number,
): BrowserTab[] {
  const target = tabs.find((tab) => tab.id === tabId);
  if (!target) return tabs;
  return tabs.map((tab) => tab.windowId === target.windowId
    ? { ...tab, active: tab.id === tabId }
    : tab);
}

export function removeTabsOptimistically(
  tabs: BrowserTab[],
  tabIds: readonly number[],
): BrowserTab[] {
  const selectedIds = new Set(tabIds);
  const removedIndexes = new Map<number, number[]>();
  tabs.forEach((tab) => {
    if (tab.id === undefined || !selectedIds.has(tab.id)) return;
    const indexes = removedIndexes.get(tab.windowId) ?? [];
    indexes.push(tab.index);
    removedIndexes.set(tab.windowId, indexes);
  });
  if (removedIndexes.size === 0) return tabs;
  return tabs
    .filter((tab) => tab.id === undefined || !selectedIds.has(tab.id))
    .map((tab) => {
      const indexes = removedIndexes.get(tab.windowId);
      if (!indexes) return tab;
      const removedBefore = indexes.filter((index) => index < tab.index).length;
      return removedBefore > 0 ? { ...tab, index: tab.index - removedBefore } : tab;
    });
}

export function moveTabsOptimistically(
  tabs: BrowserTab[],
  tabIds: readonly number[],
  windowId: number,
  index: number,
): BrowserTab[] {
  const selected = tabIds.flatMap((tabId) => {
    const tab = tabs.find((candidate) => candidate.id === tabId);
    return tab ? [tab] : [];
  });
  if (selected.length === 0) return tabs;
  const selectedIds = new Set(selected.map((tab) => tab.id));
  const byWindow = new Map<number, BrowserTab[]>();
  tabs.forEach((tab) => {
    if (selectedIds.has(tab.id)) return;
    const windowTabs = byWindow.get(tab.windowId) ?? [];
    windowTabs.push(tab);
    byWindow.set(tab.windowId, windowTabs);
  });
  for (const windowTabs of byWindow.values()) {
    windowTabs.sort((left, right) => left.index - right.index);
  }
  const destinationTabs = byWindow.get(windowId) ?? [];
  destinationTabs.splice(
    clamp(index, 0, destinationTabs.length),
    0,
    ...selected.map((tab) => ({ ...tab, windowId })),
  );
  byWindow.set(windowId, destinationTabs);

  const updates = new Map<number, BrowserTab>();
  for (const [targetWindowId, windowTabs] of byWindow) {
    windowTabs.forEach((tab, targetIndex) => {
      if (tab.id !== undefined) {
        updates.set(tab.id, { ...tab, windowId: targetWindowId, index: targetIndex });
      }
    });
  }
  return tabs.map((tab) => tab.id === undefined ? tab : updates.get(tab.id) ?? tab);
}

function normalizeBookmarkSiblings(
  nodes: BookmarkNode[],
  parentId: string,
): BookmarkNode[] {
  return nodes.map((node, index) => ({ ...node, parentId, index }));
}

function detachBookmarkNode(
  nodes: BookmarkNode[],
  nodeId: string,
): {
  nodes: BookmarkNode[];
  detached?: BookmarkNode;
  parentId?: string;
  index?: number;
} {
  const directIndex = nodes.findIndex((node) => node.id === nodeId);
  const directNode = nodes[directIndex];
  if (directNode) {
    const parentId = directNode.parentId;
    const remaining = nodes.filter((_, index) => index !== directIndex);
    return {
      nodes: parentId ? normalizeBookmarkSiblings(remaining, parentId) : remaining,
      detached: directNode,
      parentId,
      index: directIndex,
    };
  }

  for (const [index, node] of nodes.entries()) {
    const result = detachBookmarkNode(node.children ?? [], nodeId);
    if (!result.detached) continue;
    return {
      ...result,
      nodes: nodes.map((candidate, candidateIndex) => candidateIndex === index
        ? { ...candidate, children: result.nodes }
        : candidate),
    };
  }
  return { nodes };
}

function insertBookmarkNode(
  nodes: BookmarkNode[],
  parentId: string,
  node: BookmarkNode,
  index: number,
): { nodes: BookmarkNode[]; inserted: boolean } {
  for (const [nodeIndex, candidate] of nodes.entries()) {
    if (candidate.id === parentId) {
      const children = [...(candidate.children ?? [])];
      children.splice(clamp(index, 0, children.length), 0, node);
      return {
        inserted: true,
        nodes: nodes.map((sibling, siblingIndex) => siblingIndex === nodeIndex
          ? { ...candidate, children: normalizeBookmarkSiblings(children, parentId) }
          : sibling),
      };
    }
    const childResult = insertBookmarkNode(
      candidate.children ?? [],
      parentId,
      node,
      index,
    );
    if (!childResult.inserted) continue;
    return {
      inserted: true,
      nodes: nodes.map((sibling, siblingIndex) => siblingIndex === nodeIndex
        ? { ...candidate, children: childResult.nodes }
        : sibling),
    };
  }
  return { nodes, inserted: false };
}

export function moveBookmarkOptimistically(
  tree: BookmarkNode[],
  nodeId: string,
  destination: BookmarkMoveDestination,
): BookmarkNode[] {
  const detached = detachBookmarkNode(tree, nodeId);
  if (!detached.detached || !detached.parentId || detached.index === undefined) {
    return tree;
  }
  const parentId = destination.parentId ?? detached.parentId;
  const destinationIndex = destination.index ?? Number.MAX_SAFE_INTEGER;
  const insertionIndex = parentId === detached.parentId &&
    destinationIndex > detached.index
    ? destinationIndex - 1
    : destinationIndex;
  const inserted = insertBookmarkNode(
    detached.nodes,
    parentId,
    detached.detached,
    insertionIndex,
  );
  return inserted.inserted ? inserted.nodes : tree;
}

export function removeBookmarkOptimistically(
  tree: BookmarkNode[],
  nodeId: string,
): BookmarkNode[] {
  const detached = detachBookmarkNode(tree, nodeId);
  return detached.detached ? detached.nodes : tree;
}

export function updateBookmarkOptimistically(
  tree: BookmarkNode[],
  nodeId: string,
  update: Pick<BookmarkNode, 'title'> & { url?: string },
): BookmarkNode[] {
  const visit = (nodes: BookmarkNode[]): BookmarkNode[] => {
    for (const [index, node] of nodes.entries()) {
      if (node.id === nodeId) {
        const updated = [...nodes];
        updated[index] = { ...node, ...update };
        return updated;
      }
      if (!node.children) continue;
      const children = visit(node.children);
      if (children === node.children) continue;
      const updated = [...nodes];
      updated[index] = { ...node, children };
      return updated;
    }
    return nodes;
  };
  return visit(tree);
}
