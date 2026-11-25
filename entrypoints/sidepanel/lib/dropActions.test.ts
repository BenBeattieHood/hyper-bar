import { describe, expect, it, vi } from 'vitest';
import type { BrowserTab, Space } from '../../lib/bookmarks';
import type { DragItemData } from '../types';
import { createDropActions, type DropActionDependencies } from './dropActions';

const homeTab = { id: 1, index: 0, windowId: 7 } as BrowserTab;
const workTab = { id: 2, index: 1, windowId: 7 } as BrowserTab;
const tabItem = (tab: BrowserTab): Extract<DragItemData, { kind: 'tab' }> => ({
  bookmarkable: true, index: tab.index, kind: 'tab', tabId: tab.id!, title: 'Tab', windowId: tab.windowId,
});

function actions() {
  const browserState = {
    currentWindowId: 7,
    groupTabsInSpace: vi.fn(async () => undefined),
    moveTab: vi.fn(async () => undefined),
    moveTabsIntoTree: vi.fn(async () => true),
    submitSelection: vi.fn(async () => []),
  };
  const moveTabTreeNodes = vi.fn(async () => undefined);
  const dependencies = {
    activeSpace: { id: 'work' } as Space,
    browserState,
    favouriteSlots: [],
    favourites: [],
    moveTabTreeNodes,
    nodeMap: new Map(),
    realTabTreeDestination: (destination: { parentId: string; index?: number }) => destination,
    showNotice: vi.fn(),
    spaceDeletion: { request: vi.fn() },
    spaceTabs: [workTab],
    spaces: [{ id: 'home' } as Space, { id: 'work' } as Space],
    tabIdsByFolderId: {},
    tabTreeRootId: 'work-tabs',
  } as unknown as DropActionDependencies;
  return { browserState, moveTabTreeNodes, perform: createDropActions(dependencies).perform };
}

describe('drop actions', () => {
  it('moves a tab from another space into the active space at the drop', async () => {
    const { browserState, moveTabTreeNodes, perform } = actions();
    const source = tabItem(homeTab);
    await perform({
      copiesBookmark: false, modifierActive: false, selectedSources: [source], source,
      target: { index: 0, kind: 'tabs-zone', parentId: 'work-tabs' },
    });
    expect(browserState.moveTabsIntoTree).toHaveBeenCalledWith([1], 7, 2, {
      index: 0, parentId: 'work-tabs', spaceId: 'work',
    });
    expect(moveTabTreeNodes).not.toHaveBeenCalled();
  });

  it('still sends a tab from another space dropped on a space button to that space', async () => {
    const { browserState, perform } = actions();
    const source = tabItem(homeTab);
    await perform({
      copiesBookmark: false, modifierActive: false, selectedSources: [source], source,
      target: { kind: 'space', spaceId: 'home' },
    });
    expect(browserState.groupTabsInSpace).toHaveBeenCalledWith([1], 'home');
    expect(browserState.moveTabsIntoTree).not.toHaveBeenCalled();
  });

  it('reorders a tab already in the active space without moving it between spaces', async () => {
    const { browserState, perform } = actions();
    const source = tabItem(workTab);
    await perform({
      copiesBookmark: false, modifierActive: false, selectedSources: [source], source,
      target: { kind: 'tabs-zone', parentId: 'work-tabs' },
    });
    expect(browserState.moveTabsIntoTree).not.toHaveBeenCalled();
  });

  describe('another session\u2019s tabs', () => {
    const remote = (nodeId: string): Extract<DragItemData, { kind: 'session-tab' }> => ({
      installationId: 'laptop', kind: 'session-tab', nodeId, title: nodeId,
    });

    it('close together on the bin, as one intent', async () => {
      const { browserState, perform } = actions();
      const selected = [remote('r1'), remote('r2')];
      await perform({
        copiesBookmark: false, modifierActive: false, selectedSources: selected, source: selected[1]!,
        target: { kind: 'trash' },
      });
      expect(browserState.submitSelection).toHaveBeenCalledOnce();
      expect(browserState.submitSelection).toHaveBeenCalledWith('deleteBookmark', [{ bookmarkId: 'r1' }, { bookmarkId: 'r2' }]);
    });

    it('become bookmarks where they land in the bookmarks', async () => {
      const { browserState, perform } = actions();
      const source = remote('r1');
      await perform({
        copiesBookmark: false, modifierActive: true, selectedSources: [], source,
        target: { index: 2, kind: 'tree-zone', parentId: 'reading' },
      });
      expect(browserState.submitSelection).toHaveBeenCalledWith('moveSessionTab', [{
        copy: true, destination: { bookmarks: { index: 2, parentId: 'reading' } }, source: { backingId: 'r1' },
      }]);
    });
  });
});
