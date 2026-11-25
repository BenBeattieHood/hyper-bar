import { vi } from 'vitest';
import { tabBackingBookmarkTitle, visibleBookmarkTitle, type BookmarkNode } from './bookmarks';

/** A bookmark node as `getSubTree` answers it, for tests that need no tree behind it. */
export const testBookmark = (id: string, title: string, url: string, parentId?: string, index?: number): BookmarkNode =>
  ({ id, title, url, parentId, ...(index === undefined ? {} : { index }), syncing: false });

export const testFolder = (
  id: string,
  title: string,
  parentId: string | undefined,
  children: BookmarkNode[] = [],
): BookmarkNode => ({ id, title, parentId, children, syncing: false });

/** A bookmark or folder as written in a test, nested as `getSubTree` answers it. */
export interface BookmarkSpec {
  children?: readonly BookmarkSpec[];
  id: string;
  title: string;
  /** Firefox marks a separator this way; Chrome has none. */
  type?: 'separator';
  url?: string;
}

/** A folder's contents by visible title, a folder as its title and its own outline. */
export type BookmarkOutline = Array<string | [string, BookmarkOutline]>;

interface StoredBookmark {
  children?: string[];
  dateAdded?: number;
  id: string;
  parentId?: string;
  title: string;
  type?: 'separator';
  url?: string;
}

/**
 * An in-memory bookmark tree that answers as Chrome's does: an index past the
 * end is refused, a move within one folder counts its index from before the
 * node is taken out, a missing ID is an error, and only an empty folder can be
 * removed without `removeTree`. Its `api` stands in for `browser.bookmarks`.
 */
export function createBookmarkTree(root: BookmarkSpec) {
  const nodes = new Map<string, StoredBookmark>();
  let created = 0;
  const add = (spec: BookmarkSpec, parentId?: string) => {
    nodes.set(spec.id, {
      id: spec.id,
      ...(parentId ? { parentId } : {}),
      title: spec.title,
      ...(spec.type ? { type: spec.type } : {}),
      ...(spec.url ? { url: spec.url } : { children: (spec.children ?? []).map((child) => child.id) }),
    });
    for (const child of spec.children ?? []) add(child, spec.id);
  };
  add(root);

  const stored = (id: string) => {
    const node = nodes.get(id);
    if (!node) throw new Error("Can't find bookmark for id.");
    return node;
  };
  const folder = (id: string) => {
    const node = stored(id);
    if (!node.children) throw new Error("Can't add a bookmark to a bookmark.");
    return { ...node, children: node.children };
  };
  const siblings = (node: StoredBookmark) => node.parentId ? folder(node.parentId).children : [];
  const view = (node: StoredBookmark): Browser.bookmarks.BookmarkTreeNode => ({
    ...(node.dateAdded === undefined ? {} : { dateAdded: node.dateAdded }),
    id: node.id,
    ...(node.parentId ? { index: siblings(node).indexOf(node.id), parentId: node.parentId } : {}),
    syncing: false,
    title: node.title,
    ...(node.type ? { type: node.type } : {}),
    ...(node.url ? { url: node.url } : {}),
  });
  const subTree = (node: StoredBookmark): Browser.bookmarks.BookmarkTreeNode => ({
    ...view(node),
    ...(node.children ? { children: node.children.map((id) => subTree(stored(id))) } : {}),
  });
  const checkedIndex = (children: readonly string[], index: number | undefined) => {
    if (index !== undefined && (index < 0 || index > children.length)) throw new Error('Index out of bounds.');
    return index ?? children.length;
  };
  const detach = (node: StoredBookmark) => {
    const from = siblings(node);
    from.splice(from.indexOf(node.id), 1);
  };

  const api = {
    create: vi.fn(async ({ index, parentId, title = '', url }: Browser.bookmarks.CreateDetails) => {
      const parent = folder(parentId ?? root.id);
      const at = checkedIndex(parent.children, index);
      const id = `created-${created += 1}`;
      nodes.set(id, { id, parentId: parent.id, title, ...(url ? { url } : { children: [] }) });
      parent.children.splice(at, 0, id);
      return view(stored(id));
    }),
    get: vi.fn(async (id: string) => [view(stored(id))]),
    getChildren: vi.fn(async (id: string) => (stored(id).children ?? []).map((child) => view(stored(child)))),
    getSubTree: vi.fn(async (id: string) => [subTree(stored(id))]),
    getTree: vi.fn(async () => [subTree(stored(root.id))]),
    move: vi.fn(async (id: string, { index, parentId }: { index?: number; parentId?: string }) => {
      const node = stored(id);
      const target = folder(parentId ?? node.parentId ?? root.id);
      for (let ancestor: StoredBookmark | undefined = target; ancestor;) {
        if (ancestor.id === id) throw new Error("Can't move a folder into itself.");
        ancestor = ancestor.parentId ? stored(ancestor.parentId) : undefined;
      }
      const requested = checkedIndex(target.children, index);
      const from = siblings(node).indexOf(id);
      const sameParent = node.parentId === target.id;
      detach(node);
      target.children.splice(sameParent && requested > from ? requested - 1 : requested, 0, id);
      node.parentId = target.id;
      return view(node);
    }),
    remove: vi.fn(async (id: string) => {
      const node = stored(id);
      if (node.children?.length) throw new Error("Can't remove non-empty folder (use recursive to force).");
      detach(node);
      nodes.delete(id);
    }),
    removeTree: vi.fn(async (id: string) => {
      const node = stored(id);
      const forget = (current: StoredBookmark) => {
        for (const child of current.children ?? []) forget(stored(child));
        nodes.delete(current.id);
      };
      detach(node);
      forget(node);
    }),
    update: vi.fn(async (id: string, { title, url }: { title?: string; url?: string }) => {
      const node = stored(id);
      if (title !== undefined) node.title = title;
      if (url !== undefined && node.url) node.url = url;
      return view(node);
    }),
  };

  const outline = (id: string): BookmarkOutline => folder(id).children.map((childId) => {
    const child = stored(childId);
    const title = visibleBookmarkTitle(child);
    return child.children ? [title, outline(child.id)] : title;
  });

  return {
    api,
    /** The node's children as `getChildren` answers them. */
    children: (id: string) => folder(id).children.map((child) => view(stored(child))),
    has: (id: string) => nodes.has(id),
    /** Backdates a node, which the API can only read. */
    setDateAdded: (id: string, dateAdded: number) => {
      stored(id).dateAdded = dateAdded;
    },
    node: (id: string) => view(stored(id)),
    outline,
    subTree: (id: string) => subTree(stored(id)),
  };
}

export type BookmarkTree = ReturnType<typeof createBookmarkTree>;

/** A bookmark tree whose Hyper root holds the given space folders and favourites. */
export function hyperBookmarkTree(spaces: readonly object[], favourites: readonly object[] = []): BookmarkNode[] {
  return [{ id: '0', title: '', children: [{ id: '1', title: 'Bookmarks bar', children: [
    { id: 'hyper', title: 'hyper', children: [
      { id: 'favourites', title: 'favourites', children: favourites },
      { id: 'spaces', title: 'spaces', children: spaces },
    ] },
  ] }] }] as unknown as BookmarkNode[];
}

/** The folder of a space's tabs, holding `children`; a legacy one names no space. */
export function spaceTabsFolder<Child extends object>(spaceId: string | undefined, children: readonly Child[], id = 'tabs') {
  return { id, title: `tabs ${JSON.stringify({ hyper: { spaceTabs: true, spaceId } })}`, children };
}

/** The bookmark backing a tab owned through `token` in space-1. */
export function testBacking(id: string, token: string) {
  return {
    id,
    title: tabBackingBookmarkTitle('Page', 0, token, 'space-1'),
    url: `https://example.com/${id}`,
  };
}
