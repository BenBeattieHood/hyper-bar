import { isSpaceTabsFolder, visibleBookmarkTitle } from './bookmarks';
import { bookmarkById } from './bookmarkStorage';
import type { RemadeBookmarks, UndoSeries } from './timedMessages';

type BookmarkTreeNode = Browser.bookmarks.BookmarkTreeNode;

/**
 * Where moved items came from: each item's original parent, and every such
 * parent's children in their original order.
 */
export interface BookmarkPlacements {
  orders: ReadonlyMap<string, readonly string[]>;
  parents: ReadonlyMap<string, string>;
}

/** Read before a move, so the move can be undone. */
export async function snapshotPlacements(ids: readonly string[]): Promise<BookmarkPlacements> {
  const orders = new Map<string, string[]>();
  const parents = new Map<string, string>();
  for (const id of ids) {
    const node = await bookmarkById(id);
    if (!node?.parentId) continue;
    parents.set(id, node.parentId);
    if (!orders.has(node.parentId)) {
      orders.set(node.parentId, (await browser.bookmarks.getChildren(node.parentId)).map((child) => child.id));
    }
  }
  return { orders, parents };
}

/** An item's ID now: its own, or the one an undo earlier in the series gave it when it made it again. */
const currentId = (remade: RemadeBookmarks, id: string) => remade.get(id) ?? id;

/**
 * Puts moved items back. Each goes home first, then every parent is ordered
 * from the front, so each step moves an item towards the front of its own
 * folder: the one move whose index means the same in every browser.
 */
export async function restorePlacements(
  { orders, parents: recorded }: BookmarkPlacements,
  remade: RemadeBookmarks = new Map(),
): Promise<void> {
  const parents = new Map([...recorded].map(([id, parentId]) => [currentId(remade, id), currentId(remade, parentId)]));
  if (!(await Promise.all([...parents.keys()].map(bookmarkById))).some(Boolean)) {
    throw new Error('Those items no longer exist.');
  }
  for (const [id, parentId] of parents) {
    const node = await bookmarkById(id);
    if (node && node.parentId !== parentId && await bookmarkById(parentId)) {
      await browser.bookmarks.move(id, { parentId });
    }
  }
  for (const [recordedParentId, order] of orders) {
    const parentId = currentId(remade, recordedParentId);
    const children = (await browser.bookmarks.getChildren(parentId).catch(() => undefined))
      ?.map((child) => child.id);
    if (!children) continue;
    const present = new Set(children);
    const desired = order.map((id) => currentId(remade, id)).filter((id) => present.has(id));
    for (const [index, id] of desired.entries()) {
      if (children[index] === id) continue;
      await browser.bookmarks.move(id, { index, parentId });
      children.splice(children.indexOf(id), 1);
      children.splice(index, 0, id);
    }
  }
}

/**
 * Whether anything has left the place a snapshot recorded: a different parent,
 * or a different order among the items that are still in a recorded parent.
 */
export async function placementsChanged({ orders, parents }: BookmarkPlacements): Promise<boolean> {
  for (const [id, parentId] of parents) {
    const node = await bookmarkById(id);
    if (node && node.parentId !== parentId) return true;
  }
  for (const [parentId, order] of orders) {
    const children = (await browser.bookmarks.getChildren(parentId).catch(() => []))
      .map((child) => child.id);
    const present = new Set(children);
    const recorded = order.filter((id) => present.has(id));
    const current = children.filter((id) => recorded.includes(id));
    if (current.some((id, index) => recorded[index] !== id)) return true;
  }
  return false;
}

/** The space whose tab tree holds a node: the parent of the tabs folder above it. */
export async function tabTreeSpaceId(nodeId: string): Promise<string | undefined> {
  let node = await bookmarkById(nodeId);
  while (node?.parentId) {
    const parent = await bookmarkById(node.parentId);
    if (parent && isSpaceTabsFolder(parent)) return parent.parentId;
    node = parent;
  }
  return undefined;
}

/** Read before a delete, so the deleted items can be made again. */
export async function snapshotTrees(ids: readonly string[]): Promise<BookmarkTreeNode[]> {
  const trees: BookmarkTreeNode[] = [];
  for (const id of ids) {
    const [tree] = await browser.bookmarks.getSubTree(id).catch(() => []);
    if (tree?.parentId) trees.push(tree);
  }
  return trees;
}

async function createTree(
  node: BookmarkTreeNode,
  parentId: string,
  recreated: Map<string, BookmarkTreeNode>,
  remade: RemadeBookmarks,
  index?: number,
): Promise<void> {
  const created = await browser.bookmarks.create({
    ...(index === undefined ? {} : { index }),
    parentId,
    title: node.title,
    ...(node.url ? { url: node.url } : {}),
  });
  recreated.set(node.id, created);
  remade.set(node.id, created.id);
  for (const child of node.children ?? []) await createTree(child, created.id, recreated, remade);
}

/** Every ID in the given trees, folders and their contents alike. */
export function treeIds(trees: readonly BookmarkTreeNode[]): Set<string> {
  const ids = new Set<string>();
  const visit = (node: BookmarkTreeNode) => {
    ids.add(node.id);
    for (const child of node.children ?? []) visit(child);
  };
  for (const tree of trees) visit(tree);
  return ids;
}

/**
 * Makes deleted items again where they were. The copies have new IDs, so this
 * answers each original's copy, keyed by the original's ID, for anything that
 * pointed at the originals to follow.
 */
export async function recreateTrees(
  trees: readonly BookmarkTreeNode[],
  remade: RemadeBookmarks = new Map(),
): Promise<Map<string, BookmarkTreeNode>> {
  const recreated = new Map<string, BookmarkTreeNode>();
  const ordered = [...trees].sort((left, right) => (left.index ?? 0) - (right.index ?? 0));
  for (const tree of ordered) {
    const parentId = tree.parentId && currentId(remade, tree.parentId);
    if (!(await bookmarkById(parentId))) throw new Error('The folder these were in no longer exists.');
    await createTree(tree, parentId as string, recreated, remade, tree.index);
  }
  return recreated;
}

/**
 * Makes a removed tab folder again where it was, gathering back what it held:
 * backings that survived the removal move home, and each backing that left
 * with its closed tab comes back by reopening that tab, which `reopen`
 * answers with the reopened tab's backing.
 */
export async function restoreTabFolder(
  tree: BookmarkTreeNode,
  reopen: (url: string) => Promise<string | undefined>,
  remade: RemadeBookmarks = new Map(),
): Promise<void> {
  const parentId = tree.parentId && currentId(remade, tree.parentId);
  if (!parentId || !(await bookmarkById(parentId))) {
    throw new Error('The folder this was in no longer exists.');
  }
  const restore = async (node: BookmarkTreeNode, parentId: string, index?: number) => {
    const folder = await browser.bookmarks.create({
      ...(index === undefined ? {} : { index }),
      parentId,
      title: node.title,
    });
    remade.set(node.id, folder.id);
    for (const child of node.children ?? []) {
      if (!child.url) {
        await restore(child, folder.id);
        continue;
      }
      const survivor = currentId(remade, child.id);
      const backingId = await bookmarkById(survivor) ? survivor : await reopen(child.url);
      if (backingId) await browser.bookmarks.move(backingId, { parentId: folder.id });
    }
  };
  await restore(tree, parentId, tree.index);
}

/**
 * Undos of the same kind in a row join into one message, "`verb` N `noun`",
 * counting every item any of them did something to.
 */
export const undoSeries = (
  key: string,
  verb: string,
  items: readonly Pick<BookmarkTreeNode, 'id'>[],
  noun = 'items',
): UndoSeries => ({ items: items.map((item) => item.id), key, summary: (count) => `${verb} ${count} ${noun}` });

/** Names what an undo message is about: the item itself, or how many. */
export function undoMessageText(
  verb: string,
  items: readonly Pick<BookmarkTreeNode, 'title' | 'url'>[],
  noun: { folder: string; leaf: string },
): { detail?: string; text: string } {
  const [only] = items;
  if (items.length !== 1 || !only) return { text: `${verb} ${items.length} items` };
  const title = visibleBookmarkTitle(only);
  return {
    ...(title ? { detail: title } : {}),
    text: `${verb} ${only.url ? noun.leaf : noun.folder}`,
  };
}
