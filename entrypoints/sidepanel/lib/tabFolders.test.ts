import { describe, expect, it } from 'vitest';
import {
  duplicateTabIds,
  duplicateTabIdsByFolder,
  tabIdsByFolder,
} from './tabFolders';
import { testTab } from '../../lib/testFixtures';

const tab = (id: number, url: string): Browser.tabs.Tab => testTab({
  id,
  url,
  title: url,
  index: id - 1,
});

describe('duplicateTabIds', () => {
  it('keeps the active copy of each page, or else its first', () => {
    expect(duplicateTabIds([
      tab(1, 'https://one.test/a#top'),
      { ...tab(2, 'https://one.test/a'), active: true },
      tab(3, 'https://one.test/b'),
      tab(4, 'https://one.test/b'),
      tab(5, 'https://one.test/c'),
    ])).toEqual([1, 4]);
    expect(duplicateTabIds([tab(1, 'https://one.test/a'), tab(2, 'https://one.test/b')]))
      .toEqual([]);
  });

  it('counts a different query as a different page', () => {
    expect(duplicateTabIds([
      tab(1, 'https://figma.test/xyz/?node-id=1'),
      tab(2, 'https://figma.test/xyz/?node-id=2'),
      tab(3, 'https://figma.test/xyz?node-id=1#frame'),
    ])).toEqual([3]);
  });
});

describe('duplicateTabIdsByFolder', () => {
  it('finds the extra copies in any folder, counting its subfolders', () => {
    const leaf = (id: string, parentId: string, index: number) =>
      ({ id, title: id, url: `https://one.test/${id}`, parentId, index, syncing: false });
    const autofolder = 'auto-tab-folder:host%3Atwo.test';
    const nodes = [
      { id: 'outer', title: 'Outer', parentId: 'root', index: 0, syncing: false, children: [
        leaf('a', 'outer', 0),
        { id: 'inner', title: 'Inner', parentId: 'outer', index: 1, syncing: false, children: [
          leaf('b', 'inner', 0),
          leaf('c', 'inner', 1),
        ] },
      ] },
      { id: autofolder, title: 'two.test', parentId: 'root', index: 1, syncing: false, children: [
        leaf('d', autofolder, 0),
        leaf('e', autofolder, 1),
      ] },
    ];

    expect(duplicateTabIdsByFolder(nodes, {
      a: tab(1, 'https://one.test/page'),
      b: { ...tab(2, 'https://one.test/page'), active: true },
      c: tab(3, 'https://one.test/other'),
      d: tab(4, 'https://two.test/page'),
      e: tab(5, 'https://two.test/page'),
    })).toEqual({ [autofolder]: [5], inner: [], outer: [1] });
  });
});

describe('tabIdsByFolder', () => {
  it('collects live tabs through nested folders in tree order', () => {
    const first = tab(1, 'https://one.test');
    const second = tab(2, 'https://two.test');
    const nodes = [{
      id: 'folder',
      title: 'Folder',
      syncing: false,
      children: [
        { id: 'one', title: 'One', url: first.url, syncing: false },
        {
          id: 'nested',
          title: 'Nested',
          syncing: false,
          children: [
            { id: 'two', title: 'Two', url: second.url, syncing: false },
            {
              id: 'closed',
              title: 'Closed',
              url: 'https://closed.test',
              syncing: false,
            },
          ],
        },
      ],
    }];

    expect(tabIdsByFolder(nodes, { one: first, two: second })).toEqual({
      nested: [2],
      folder: [1, 2],
    });
  });
});