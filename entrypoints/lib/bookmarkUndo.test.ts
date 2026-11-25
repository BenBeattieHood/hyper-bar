import { afterEach, describe, expect, it, vi } from 'vitest';
import { recreateTrees, restorePlacements, restoreTabFolder, snapshotPlacements, snapshotTrees } from './bookmarkUndo';
import { createBookmarkTree } from './testBookmarkTree';

/** Top-level folders of the given children, those in `urls` as bookmarks of an example page. */
function installStore(folders: Record<string, string[]>, urls: readonly string[] = []) {
  const tree = createBookmarkTree({
    children: Object.entries(folders).map(([id, children]) => ({
      children: children.map((child) => ({
        id: child,
        title: child,
        ...(urls.includes(child) ? { url: `https://example.test/${child}` } : {}),
      })),
      id,
      title: id,
    })),
    id: 'root',
    title: '',
  });
  vi.stubGlobal('browser', { bookmarks: tree.api });
  return {
    children: (id: string) => tree.children(id).map((node) => node.id),
    move: tree.api.move,
    remove: tree.api.removeTree,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('bookmark undo', () => {
  it('puts several items moved within and across folders back in their order', async () => {
    const store = installStore({ a: ['1', '2', '3', '4', '5'], b: ['x', 'y'] });
    const placements = await snapshotPlacements(['4', '1', 'y']);

    await store.move('4', { index: 0, parentId: 'b' });
    await store.move('1', { index: 1, parentId: 'b' });
    await store.move('y', { index: 3, parentId: 'a' });
    await store.move('2', { index: 3, parentId: 'a' });
    await restorePlacements(placements);

    expect(store.children('a')).toEqual(['1', '2', '3', '4', '5']);
    expect(store.children('b')).toEqual(['x', 'y']);
  });

  it('reorders a folder moved to the end of its own folder', async () => {
    const store = installStore({ a: ['1', '2', '3'] });
    const placements = await snapshotPlacements(['1']);

    await store.move('1', { index: 3, parentId: 'a' });
    expect(store.children('a')).toEqual(['2', '3', '1']);
    await restorePlacements(placements);

    expect(store.children('a')).toEqual(['1', '2', '3']);
  });

  it('refuses an undo once every moved item is gone', async () => {
    const store = installStore({ a: ['1', '2'], b: [] });
    const placements = await snapshotPlacements(['1']);
    await store.move('1', { parentId: 'b' });
    await store.remove('1');

    await expect(restorePlacements(placements)).rejects.toThrow('no longer exist');
  });

  it('rebuilds a removed tab folder around its surviving and reopened tabs', async () => {
    const store = installStore({ space: ['before', 'kept', 'after'] }, ['before', 'kept', 'after']);
    const tree = {
      children: [
        { id: 'closed', parentId: 'folder', title: 'Closed', syncing: false, url: 'https://example.test/closed' },
        { id: 'kept', parentId: 'folder', title: 'Kept', syncing: false, url: 'https://example.test/kept' },
      ],
      id: 'folder',
      index: 1,
      parentId: 'space',
      syncing: false,
      title: 'Folder',
    };
    // The bin moved `kept` up to where the folder was, so it now sits at index 1.
    const reopen = vi.fn(async () => {
      await store.move('before', { parentId: 'space' });
      return 'before';
    });

    await restoreTabFolder(tree, reopen);

    expect(reopen).toHaveBeenCalledWith('https://example.test/closed');
    expect(store.children('space')).toEqual(['created-1', 'after']);
    expect(store.children('created-1')).toEqual(['before', 'kept']);
  });

  it('undoes a run newest first, each undo finding what the newer ones made again', async () => {
    const store = installStore({ a: ['1', '2'], b: ['x'], g: ['3', '4'] }, ['1', '2', '3', '4', 'x']);
    const moved = await snapshotPlacements(['1']);
    await store.move('1', { parentId: 'g' });
    const deletedThree = await snapshotTrees(['3']);
    await store.remove('3');
    const deletedFolder = await snapshotTrees(['g']);
    await store.remove('g');

    const remade = new Map<string, string>();
    await recreateTrees(deletedFolder, remade);
    await recreateTrees(deletedThree, remade);
    await restorePlacements(moved, remade);

    const folder = remade.get('g')!;
    expect(store.children(folder)).toEqual([remade.get('3'), remade.get('4')]);
    expect(store.children('a')).toEqual([remade.get('1'), '2']);
  });
});
