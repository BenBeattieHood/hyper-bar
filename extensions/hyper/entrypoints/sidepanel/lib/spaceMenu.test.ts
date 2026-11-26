import type { MouseEvent } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { BookmarkNode, BrowserTab, Space } from '../../lib/bookmarks';
import type { ContextMenuEntry } from '../components/ContextMenu';
import {
  createSpaceMenuOpener,
  spaceMenuEntries,
  spaceTabCounts,
  type SpaceMenuActions,
  type SpaceMenuDependencies,
} from './spaceMenu';

const ORIGIN = 'chrome-extension://hyper/';

const tab = (id: number, url: string, extra: Partial<BrowserTab> = {}) =>
  ({ id, index: id, url, windowId: 1, ...extra }) as BrowserTab;

const WORK_TABS: BrowserTab[] = [
  tab(1, 'https://one.test/'),
  tab(2, 'https://two.test/', { discarded: true }),
  tab(3, 'about:blank', { pendingUrl: 'https://three.test/' }),
  tab(4, 'https://pinned.test/', { pinned: true }),
  tab(5, `${ORIGIN}newtab.html`),
  tab(6, 'edge://newtab/'),
  tab(7, 'https://other-window.test/', { windowId: 2 }),
  tab(8, 'https://home.test/'),
];
const TAB_SPACE_IDS: Record<number, string> = { 1: 'work', 2: 'work', 3: 'work', 4: 'work', 5: 'work', 6: 'work', 7: 'work', 8: 'home' };

const actions = (): SpaceMenuActions => ({
  close: vi.fn(),
  delete: vi.fn(),
  duplicate: vi.fn(),
  reload: vi.fn(),
  rename: vi.fn(),
});

const summary = (entries: readonly ContextMenuEntry[]) => entries.map((entry) =>
  `${entry.separated ? '| ' : ''}${entry.label}${entry.danger ? ' (danger)' : ''}`);

describe('spaceTabCounts', () => {
  it('counts the pages in the space in this window, as closing them all would close them', () => {
    expect(spaceTabCounts(WORK_TABS, {
      newTabUrl: `${ORIGIN}newtab.html`,
      spaceId: 'work',
      tabSpaceIds: TAB_SPACE_IDS,
      windowId: 1,
    })).toEqual({ closable: 3, reloadable: 2 });
  });

  it('counts nothing before the window is known', () => {
    expect(spaceTabCounts(WORK_TABS, {
      newTabUrl: `${ORIGIN}newtab.html`,
      spaceId: 'work',
      tabSpaceIds: TAB_SPACE_IDS,
      windowId: null,
    })).toEqual({ closable: 0, reloadable: 0 });
  });

  it('offers to reload only tabs holding their page, as one without loads it afresh when shown', () => {
    expect(spaceTabCounts([
      tab(1, 'https://loaded.test/'),
      tab(2, 'https://discarded.test/', { discarded: true }),
      tab(3, 'https://restored.test/', { status: 'unloaded' }),
      tab(4, 'https://frozen.test/', { frozen: true }),
    ], {
      newTabUrl: `${ORIGIN}newtab.html`,
      spaceId: 'work',
      tabSpaceIds: { 1: 'work', 2: 'work', 3: 'work', 4: 'work' },
      windowId: 1,
    })).toEqual({ closable: 4, reloadable: 2 });
  });
});

describe('spaceMenuEntries', () => {
  it('offers the tab actions with their counts, and deletion last', () => {
    expect(summary(spaceMenuEntries({ closable: 3, reloadable: 2 }, actions()))).toEqual([
      'Rename',
      '| Duplicate',
      'Duplicate with tabs',
      '| Reload 2 tabs',
      '| Close 3 tabs',
      'Delete space (danger)',
    ]);
  });

  it('names a single tab', () => {
    expect(summary(spaceMenuEntries({ closable: 1, reloadable: 1 }, actions()))).toContain('| Reload tab');
    expect(summary(spaceMenuEntries({ closable: 1, reloadable: 1 }, actions()))).toContain('| Close tab');
  });

  it('leaves out what has nothing to act on: tabs for an empty space, deletion for the only one', () => {
    const { delete: _delete, ...onlySpace } = actions();
    expect(summary(spaceMenuEntries({ closable: 0, reloadable: 0 }, onlySpace))).toEqual(['Rename', '| Duplicate']);
    expect(summary(spaceMenuEntries({ closable: 2, reloadable: 0 }, actions()))).toEqual([
      'Rename',
      '| Duplicate',
      'Duplicate with tabs',
      '| Close 2 tabs',
      'Delete space (danger)',
    ]);
  });

  it('duplicates with or without the tabs', () => {
    const chosen = actions();
    const entries = spaceMenuEntries({ closable: 1, reloadable: 1 }, chosen);
    entries.find((entry) => entry.id === 'duplicate')?.onSelect();
    entries.find((entry) => entry.id === 'duplicate-with-tabs')?.onSelect();
    expect(vi.mocked(chosen.duplicate).mock.calls).toEqual([[false], [true]]);
  });
});

describe('createSpaceMenuOpener', () => {
  const WORK: Space = { id: 'work', rootId: 'work-root', title: 'Work' } as Space;
  const HOME: Space = { id: 'home', rootId: 'home-root', title: 'Home' } as Space;
  const WORK_NODE = { id: 'work', parentId: 'spaces', title: 'Work' } as BookmarkNode;

  const open = (overrides: Partial<Omit<SpaceMenuDependencies, 'openMenu'>> = {}, space: Space = WORK) => {
    const openMenu = vi.fn<SpaceMenuDependencies['openMenu']>();
    const dependencies = {
      browserState: {
        closeSpaceTabs: vi.fn(async () => undefined),
        currentWindowId: 1,
        reloadSpaceTabs: vi.fn(async () => undefined),
        setSpaceArchived: vi.fn(async () => undefined),
        tabSpaceIds: TAB_SPACE_IDS,
        tabs: WORK_TABS,
      },
      duplicateSpace: vi.fn(),
      extensionOrigin: ORIGIN,
      nodeMap: new Map([['work', WORK_NODE]]),
      openMenu,
      renameSpace: vi.fn(),
      requestDeletion: vi.fn(async () => undefined),
      showNotice: vi.fn(),
      spaces: [WORK, HOME],
      ...overrides,
    } satisfies SpaceMenuDependencies;
    const dot = { dataset: { spaceId: 'work' } } as unknown as HTMLElement;
    const event = { currentTarget: dot } as MouseEvent<HTMLElement>;
    createSpaceMenuOpener(dependencies)(event, space);
    const [openedEvent, label, entries] = openMenu.mock.calls[0] ?? [];
    if (!entries) throw new Error('The menu did not open');
    const select = (id: string) => {
      const entry = entries.find((candidate) => candidate.id === id);
      if (!entry) throw new Error(`No ${id} entry`);
      entry.onSelect();
    };
    return { dependencies, dot, entries, event, label, openedEvent, select };
  };

  it('opens the space\'s menu on its dot, counting this window\'s pages in it', () => {
    const { entries, event, label, openedEvent } = open();
    expect(openedEvent).toBe(event);
    expect(label).toBe('Actions for Work');
    expect(summary(entries)).toContain('| Close 3 tabs');
    expect(summary(entries)).toContain('| Reload 2 tabs');
  });

  it('hands the dot to the dialogs it opens, so focus goes back to it rather than to the closed menu', () => {
    const { dependencies, dot, select } = open();
    select('rename');
    select('duplicate-with-tabs');
    expect(dependencies.renameSpace).toHaveBeenCalledWith('work', dot);
    expect(dependencies.duplicateSpace).toHaveBeenCalledWith('work', true, dot);
  });

  it('closes, reloads and deletes the space it opened on', () => {
    const { dependencies, select } = open();
    select('close');
    select('reload');
    select('delete');
    expect(dependencies.browserState.closeSpaceTabs).toHaveBeenCalledWith('work');
    expect(dependencies.browserState.reloadSpaceTabs).toHaveBeenCalledWith('work');
    expect(dependencies.requestDeletion).toHaveBeenCalledWith(WORK_NODE);
  });

  it('reports a failure, with the reason the model gave when it gave one', async () => {
    const closeSpaceTabs = vi.fn(async () => {
      throw new Error('This window is gone.');
    });
    const reloadSpaceTabs = vi.fn(() => Promise.reject('refused'));
    const { dependencies, select } = open({
      browserState: {
        closeSpaceTabs,
        currentWindowId: 1,
        reloadSpaceTabs,
        setSpaceArchived: vi.fn(async () => undefined),
        tabSpaceIds: TAB_SPACE_IDS,
        tabs: WORK_TABS,
      },
    });
    select('close');
    select('reload');
    await vi.waitFor(() => expect(dependencies.showNotice).toHaveBeenCalledTimes(2));
    expect(vi.mocked(dependencies.showNotice).mock.calls).toEqual([
      ['This window is gone.'],
      ['These tabs could not be reloaded'],
    ]);
  });

  it('offers no deletion for the only space, or for one the sidebar cannot find', () => {
    expect(open({ spaces: [WORK] }).entries.map((entry) => entry.id)).not.toContain('delete');
    expect(open({ nodeMap: new Map() }).entries.map((entry) => entry.id)).not.toContain('delete');
  });

  it('archives a space just before deleting it, but never the only shown one', () => {
    const { dependencies, entries, select } = open();
    expect(summary(entries).slice(-3)).toEqual(['| Close 3 tabs', 'Archive', 'Delete space (danger)']);
    select('archive');
    expect(dependencies.browserState.setSpaceArchived).toHaveBeenCalledWith('work', true);
    expect(open({ spaces: [WORK] }).entries.map((entry) => entry.id)).not.toContain('archive');
  });

  it('offers an archived space only unarchiving, renaming and deleting, even beside one shown space', () => {
    const { dependencies, entries, select } = open({ spaces: [HOME] }, { ...WORK, archived: true });
    expect(summary(entries)).toEqual(['Unarchive', 'Rename', '| Delete space (danger)']);
    select('unarchive');
    expect(dependencies.browserState.setSpaceArchived).toHaveBeenCalledWith('work', false);
  });
});
