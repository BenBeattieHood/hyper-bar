import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isSplitViewFolder,
  splitViewFolderBookmarkTitle,
  tabBackingBookmarkTitle,
  tabFolderBookmarkTitle,
  visibleBookmarkTitle,
  type BookmarkNode,
} from './bookmarks';
import { createBookmarkTree, type BookmarkSpec } from './testBookmarkTree';
import { rebuildTabTree } from './tabTreeRebuild';

const backing = (id: string): BookmarkSpec => ({
  id,
  title: tabBackingBookmarkTitle(id),
  url: `https://example.test/${id}`,
});
const tabFolder = (id: string, children: BookmarkSpec[]): BookmarkSpec => ({
  children,
  id,
  title: tabFolderBookmarkTitle(id),
});
const splitView = (id: string, children: BookmarkSpec[]): BookmarkSpec => ({
  children,
  id,
  title: splitViewFolderBookmarkTitle(),
});
const install = (folders: BookmarkSpec[]) => {
  const tree = createBookmarkTree({ children: folders, id: 'root', title: '' });
  vi.stubGlobal('browser', { bookmarks: tree.api });
  return tree;
};
const copyTitle = (node: BookmarkNode) => tabBackingBookmarkTitle(`${visibleBookmarkTitle(node)} copy`);

afterEach(() => vi.unstubAllGlobals());

describe('rebuildTabTree', () => {
  it('copies the chosen tabs into their folders in order, keeping empty folders when asked', async () => {
    const tree = install([
      {
        children: [
          backing('a'),
          tabFolder('Work', [backing('b'), backing('skipped'), backing('c')]),
          tabFolder('Empty', []),
          tabFolder('Only skipped', [backing('skipped too')]),
          backing('d'),
        ],
        id: 'source',
        title: 'tabs',
      },
      { id: 'copy', title: 'tabs' },
    ]);

    const copies = await rebuildTabTree(tree.subTree('source'), 'copy', {
      backingTitle: (node) => visibleBookmarkTitle(node).startsWith('skipped') ? undefined : copyTitle(node),
      keepEmptyFolders: true,
      present: new Set(),
    });

    expect(tree.outline('copy')).toEqual([
      'a copy',
      ['Work', ['b copy', 'c copy']],
      ['Empty', []],
      ['Only skipped', []],
      'd copy',
    ]);
    expect([...copies.keys()]).toEqual(['a', 'b', 'c', 'd']);
    expect(tree.node(copies.get('c')!)).toMatchObject({ title: copyTitle(tree.node('c')) });
    expect(tree.outline('source')).toEqual(['a', ['Work', ['b', 'skipped', 'c']], ['Empty', []], ['Only skipped', ['skipped too']], 'd']);
  });

  it('leaves out a folder that would hold no tab unless empty folders are kept', async () => {
    const tree = install([
      {
        children: [tabFolder('Empty', []), tabFolder('Only skipped', [backing('skipped')]), backing('a')],
        id: 'source',
        title: 'tabs',
      },
      { id: 'copy', title: 'tabs' },
    ]);

    await rebuildTabTree(tree.subTree('source'), 'copy', {
      backingTitle: (node) => node.id === 'skipped' ? undefined : copyTitle(node),
      keepEmptyFolders: false,
      present: new Set(),
    });

    expect(tree.outline('copy')).toEqual(['a copy']);
  });

  it('puts removed tabs back around those still there, into the folders they left', async () => {
    const tree = install([{
      children: [
        backing('a'),
        tabFolder('Work', [backing('b'), backing('c')]),
        backing('d'),
        backing('kept'),
        backing('other'),
      ],
      id: 'tabs',
      title: 'tabs',
    }]);
    const before = tree.subTree('tabs');
    for (const id of ['a', 'd']) await tree.api.remove(id);
    await tree.api.removeTree('Work');

    const rebuilt = await rebuildTabTree(before, 'tabs', {
      backingTitle: (node) => node.id === 'other' ? undefined : node.title,
      keepEmptyFolders: false,
      present: new Set(['tabs', 'kept', 'other']),
    });

    expect(tree.outline('tabs')).toEqual(['a', ['Work', ['b', 'c']], 'd', 'kept', 'other']);
    expect(rebuilt.get('kept')).toBe('kept');
    expect(rebuilt.has('other')).toBe(false);
    expect(tree.has(rebuilt.get('a')!)).toBe(true);
    expect(rebuilt.get('a')).not.toBe('a');
  });

  it('refills a folder that is still there rather than making a second', async () => {
    const tree = install([{
      children: [tabFolder('Work', [backing('a'), backing('b'), backing('c')])],
      id: 'tabs',
      title: 'tabs',
    }]);
    const before = tree.subTree('tabs');
    for (const id of ['a', 'c']) await tree.api.remove(id);

    await rebuildTabTree(before, 'tabs', {
      backingTitle: (node) => ['a', 'c'].includes(node.id) ? node.title : undefined,
      keepEmptyFolders: false,
      present: new Set(['tabs', 'Work', 'b']),
    });

    expect(tree.outline('tabs')).toEqual([['Work', ['a', 'b', 'c']]]);
    expect(tree.children('tabs').map((node) => node.id)).toEqual(['Work']);
  });

  it('fills a split view before marking it, and gives a lone tab the place of a split it cannot fill', async () => {
    const tree = install([
      {
        children: [
          splitView('pair', [backing('x'), backing('y')]),
          splitView('half', [backing('p'), backing('skipped')]),
          splitView('none', [backing('skipped too'), backing('skipped also')]),
          backing('last'),
        ],
        id: 'source',
        title: 'tabs',
      },
      { id: 'copy', title: 'tabs' },
    ]);

    await rebuildTabTree(tree.subTree('source'), 'copy', {
      backingTitle: (node) => visibleBookmarkTitle(node).startsWith('skipped') ? undefined : copyTitle(node),
      keepEmptyFolders: true,
      present: new Set(),
    });

    expect(tree.outline('copy')).toEqual([['Side by side', ['x copy', 'y copy']], 'p copy', 'last copy']);
    const [pair] = tree.children('copy');
    expect(isSplitViewFolder(pair!)).toBe(true);
    const madeFolders = tree.api.create.mock.calls.flatMap(([details]) => details.url ? [] : [details]);
    expect(madeFolders.every((details) => !isSplitViewFolder({ title: details.title ?? '' }))).toBe(true);
    expect(tree.api.remove).toHaveBeenCalledTimes(1);
  });

  it('unmarks a split view still there while refilling it, then marks it again', async () => {
    const tree = install([{
      children: [splitView('pair', [backing('x'), backing('y')])],
      id: 'tabs',
      title: 'tabs',
    }]);
    const before = tree.subTree('tabs');
    await tree.api.remove('y');

    await rebuildTabTree(before, 'tabs', {
      backingTitle: (node) => node.id === 'y' ? node.title : undefined,
      keepEmptyFolders: false,
      present: new Set(['tabs', 'pair', 'x']),
    });

    expect(tree.outline('tabs')).toEqual([['Side by side', ['x', 'y']]]);
    expect(tree.api.update.mock.calls.map(([id, { title }]) => [id, isSplitViewFolder({ title: title ?? '' })]))
      .toEqual([['pair', false], ['pair', true]]);
  });
});
