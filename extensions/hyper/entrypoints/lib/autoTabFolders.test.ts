import { describe, expect, it } from 'vitest';
import {
  autoTabFolderIdentity,
  projectAutoTabFolders,
  realAutoTabFolderDestination,
  settleAutoTabFolderIdentities,
} from './autoTabFolders';
import { splitViewFolderBookmarkTitle } from './bookmarks';
import { testBookmark, testFolder } from './testBookmarkTree';
import { testTab } from './testFixtures';

const tab = (id: number, url: string): Browser.tabs.Tab => testTab({
  id,
  url,
  title: url,
  index: id - 1,
});

describe('autoTabFolderIdentity', () => {
  it('normalises the common www hostname prefix', () => {
    expect(autoTabFolderIdentity(tab(1, 'https://www.example.com/a')))
      .toEqual({ key: 'host:example.com', title: 'example.com' });
  });

  it('groups hostless browser URLs by protocol', () => {
    expect(autoTabFolderIdentity(tab(1, 'about:blank')))
      .toEqual({ key: 'protocol:about', title: 'about:' });
  });
});

describe('projectAutoTabFolders', () => {
  const leaf = (id: string, url: string, index: number, parentId = 'root') =>
    testBookmark(id, id, url, parentId, index);
  const nodes = [
    leaf('a1', 'https://one.test/a', 0),
    { ...testFolder('folder', 'Folder', 'root', [leaf('f1', 'https://one.test/f', 0, 'folder')]), index: 1 },
    leaf('b1', 'https://two.test/a', 2),
    leaf('a2', 'https://www.one.test/b', 3),
  ];
  const project = () => projectAutoTabFolders(nodes, 'root', (node) =>
    node.url ? autoTabFolderIdentity(testTab({ url: node.url })) : undefined);

  it('groups only root-level tabs, placing each folder at its first tab', () => {
    const tree = project();

    expect(tree.nodes.map((node) => [node.id, node.index])).toEqual([
      ['auto-tab-folder:host%3Aone.test', 0],
      ['folder', 1],
      ['auto-tab-folder:host%3Atwo.test', 2],
    ]);
    expect(tree.nodes[0]!.children?.map((node) => [node.id, node.parentId, node.index]))
      .toEqual([
        ['a1', 'auto-tab-folder:host%3Aone.test', 0],
        ['a2', 'auto-tab-folder:host%3Aone.test', 1],
      ]);
    expect(tree.nodes[1]!.children?.map((node) => node.id)).toEqual(['f1']);
  });

  it('maps displayed drop positions back to real root indexes', () => {
    const tree = project();
    const realIndexes = new Map(nodes.map((node) => [node.id, node.index!]));
    const oneFolder = 'auto-tab-folder:host%3Aone.test';

    expect(realAutoTabFolderDestination(tree, 'root', realIndexes, { parentId: oneFolder, index: 1 }))
      .toEqual({ parentId: 'root', index: 3 });
    expect(realAutoTabFolderDestination(tree, 'root', realIndexes, { parentId: oneFolder, index: 2 }))
      .toEqual({ parentId: 'root', index: 4 });
    expect(realAutoTabFolderDestination(tree, 'root', realIndexes, { parentId: 'root', index: 2 }))
      .toEqual({ parentId: 'root', index: 2 });
    expect(realAutoTabFolderDestination(tree, 'root', realIndexes, { parentId: 'root', index: 3 }))
      .toEqual({ parentId: 'root' });
    expect(realAutoTabFolderDestination(tree, 'root', realIndexes, { parentId: 'folder', index: 0 }))
      .toEqual({ parentId: 'folder', index: 0 });
  });

  it('gathers a split view into the folder of its first pane', () => {
    const split = {
      ...testFolder('split', splitViewFolderBookmarkTitle(), 'root', [
        leaf('s1', 'https://one.test/s', 0, 'split'),
        leaf('s2', 'https://two.test/s', 1, 'split'),
      ]),
      index: 1,
    };
    const tree = projectAutoTabFolders(
      [leaf('b1', 'https://two.test/a', 0), split],
      'root',
      (node) => node.url ? autoTabFolderIdentity(testTab({ url: node.url })) : undefined,
    );

    expect(tree.nodes.map((node) => [node.id, node.children?.map((child) => child.id)])).toEqual([
      ['auto-tab-folder:host%3Atwo.test', ['b1']],
      ['auto-tab-folder:host%3Aone.test', ['split']],
    ]);
  });
});

describe('settleAutoTabFolderIdentities', () => {
  it('keeps a navigating tab in its settled folder until loading completes', () => {
    const settledTab = { ...tab(1, 'https://one.test/start'), status: 'complete' as const };
    const settled = settleAutoTabFolderIdentities([settledTab], new Map());
    const loadingTab = {
      ...settledTab,
      pendingUrl: 'https://two.test/next',
      status: 'loading' as const,
    };
    const loading = settleAutoTabFolderIdentities([loadingTab], settled);
    expect(loading.get(1)?.key).toBe('host:one.test');

    const completedTab = {
      ...loadingTab,
      url: loadingTab.pendingUrl,
      pendingUrl: undefined,
      status: 'complete' as const,
    };
    expect(settleAutoTabFolderIdentities([completedTab], loading).get(1)?.key)
      .toBe('host:two.test');
  });
});
