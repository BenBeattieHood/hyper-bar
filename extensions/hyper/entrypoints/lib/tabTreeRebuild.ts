import {
  isSplitViewFolder,
  isTabBackingBookmark,
  isTabFolder,
  tabFolderTitleWithSplitView,
  type BookmarkNode,
} from './bookmarks';

export interface TabTreeRebuildOptions {
  /** The title a backing takes where it is made, or undefined to leave it out. */
  backingTitle(node: BookmarkNode): string | undefined;
  /** Copies a tab folder even when it ends up holding nothing, as the user made it. */
  keepEmptyFolders: boolean;
  /** Nodes the destination still holds, which stay where they are rather than being made again. */
  present: ReadonlySet<string>;
  /**
   * New IDs of nodes an earlier undo made again, keyed by the originals' IDs.
   * A node found here counts as present under its new ID, and each node made
   * here is added.
   */
  remade?: Map<string, string>;
}

/**
 * Makes a tabs tree, as read in `source`, again under `destinationId`: each
 * backing `backingTitle` names, in the tab folders and split views that held
 * it, in the same order. Answers each made or kept backing's ID, keyed by its
 * source's.
 *
 * A split view is filled while unmarked, because the split planner dissolves
 * one holding a single tab, and is marked again only once it holds what it
 * held; one left holding a single tab gives that tab its place instead.
 */
export async function rebuildTabTree(
  source: BookmarkNode,
  destinationId: string,
  options: TabTreeRebuildOptions,
): Promise<Map<string, string>> {
  const rebuilt = new Map<string, string>();
  const included = new Map<string, boolean>();
  const includes = (node: BookmarkNode): boolean => {
    const known = included.get(node.id);
    if (known !== undefined) return known;
    const result = isTabBackingBookmark(node)
      ? options.backingTitle(node) !== undefined
      : isTabFolder(node) && (
        (options.keepEmptyFolders && !isSplitViewFolder(node)) ||
        (node.children ?? []).some(includes)
      );
    included.set(node.id, result);
    return result;
  };
  const create = async (
    parentId: string,
    index: number | undefined,
    title: string,
    url?: string,
  ): Promise<BookmarkNode> => {
    const count = (await browser.bookmarks.getChildren(parentId)).length;
    return browser.bookmarks.create({
      index: Math.min(index ?? count, count),
      parentId,
      title,
      ...(url ? { url } : {}),
    });
  };
  const fill = async (folder: BookmarkNode, parentId: string): Promise<void> => {
    for (const child of folder.children ?? []) {
      if (!includes(child)) continue;
      const id = options.remade?.get(child.id) ?? child.id;
      if (isTabBackingBookmark(child)) {
        if (options.present.has(id)) {
          rebuilt.set(child.id, id);
          continue;
        }
        const title = options.backingTitle(child);
        if (title === undefined) continue;
        const made = await create(parentId, child.index, title, child.url);
        rebuilt.set(child.id, made.id);
        options.remade?.set(child.id, made.id);
        continue;
      }
      const split = isSplitViewFolder(child);
      let target: BookmarkNode;
      if (options.present.has(id)) {
        const [current] = await browser.bookmarks.get(id);
        if (!current) throw new Error('A tab folder no longer exists.');
        target = split
          ? await browser.bookmarks.update(id, { title: tabFolderTitleWithSplitView(current.title, false) })
          : current;
      } else {
        target = await create(
          parentId,
          child.index,
          split ? tabFolderTitleWithSplitView(child.title, false) : child.title,
        );
        options.remade?.set(child.id, target.id);
      }
      await fill(child, target.id);
      if (split) await settleSplitView(target.id);
    }
  };
  await fill(source, destinationId);
  return rebuilt;
}

/** Marks a filled split view again, or gives a lone tab the split's place. */
async function settleSplitView(folderId: string): Promise<void> {
  const [folder] = await browser.bookmarks.get(folderId);
  if (!folder?.parentId) return;
  const children = await browser.bookmarks.getChildren(folderId);
  if (children.length >= 2 || children.some((child) => !child.url)) {
    await browser.bookmarks.update(folderId, { title: tabFolderTitleWithSplitView(folder.title, true) });
    return;
  }
  const [only] = children;
  if (only) await browser.bookmarks.move(only.id, { index: folder.index, parentId: folder.parentId });
  await browser.bookmarks.remove(folderId);
}
