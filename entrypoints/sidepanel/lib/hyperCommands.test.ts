import { describe, expect, it } from 'vitest';
import type { Space } from '../../lib/bookmarks';
import { browserCommandActions } from '../../lib/browserCommands';
import type { BrowserCommandCapabilities } from '../../lib/browserCommandCapabilities';
import { SHORTCUT_IDS, SHORTCUTS, shortcutLabel } from '../../lib/shortcuts';
import { hyperCommandActions } from './hyperCommands';

const capabilities: BrowserCommandCapabilities = {
  available: true,
  duplicateTab: true,
  navigateBack: true,
  navigateForward: true,
  restoreClosedTab: true,
  splitViewTabs: 2,
  tabZoom: true,
};

const spaces = Array.from({ length: 10 }, (_, index) => ({
  id: `space-${index}`,
  rootId: `root-${index}`,
  title: `Space ${index + 1}`,
} as Space));
const firstSpace = spaces[0] as Space;

type CommandBrowserState = Parameters<typeof hyperCommandActions>[0]['browserState'];

const browserState = (favouritesFolderId: string | undefined): CommandBrowserState => ({
  currentWindowId: 3,
  favouritesFolderId,
  mediaControlAvailable: false,
  mediaRetainedTabId: undefined,
  mediaTarget: undefined,
  setTabMediaPlayback: async () => undefined,
  setTabMuted: async () => undefined,
  tabs: [],
} as unknown as CommandBrowserState);

const allActions = Object.fromEntries(SHORTCUT_IDS.map((id) => [id, () => undefined]));

const searchRows = () => [
  ...hyperCommandActions({
    actions: allActions,
    activeSpace: firstSpace,
    activeWindowTab: undefined,
    browserState: browserState('favourites'),
    focusAudibleTab: async () => undefined,
    selectSpace: async () => true,
    showNotice: () => undefined,
    spaces,
  }),
  ...browserCommandActions({
    capabilities,
    currentTab: { id: 7, index: 0, title: 'Page', url: 'https://example.com', windowId: 3 } as never,
    onError: () => undefined,
    submitIntent: async () => undefined,
    tabs: [],
  }),
];

describe('Search command shortcuts', () => {
  it('shows each Search row the key that runs it', () => {
    const rows = new Map(searchRows().map((row) => [row.id, row]));
    const missing: string[] = [];
    for (const id of SHORTCUT_IDS) {
      const commandId = SHORTCUTS[id].command;
      // The new tab page shows the manifest key on its own row.
      if (!commandId || SHORTCUTS[id].owner === 'manifest') continue;
      const row = rows.get(commandId);
      if (row?.shortcut !== shortcutLabel(id)) missing.push(`${id}: ${commandId} shows ${row?.shortcut}`);
    }

    expect(missing).toEqual([]);
  });

  it('shows the space keys on the first nine space rows', () => {
    const rows = searchRows();

    expect(rows.find((row) => row.id === 'space:space-0')?.shortcut).toBe(shortcutLabel('space1'));
    expect(rows.find((row) => row.id === 'space:space-8')?.shortcut).toBe(shortcutLabel('space9'));
    expect(rows.find((row) => row.id === 'space:space-9')?.shortcut).toBeUndefined();
  });

  it('runs the same action as the key', () => {
    let ran: string | undefined;
    const rows = hyperCommandActions({
      actions: { createTabFolder: () => { ran = 'createTabFolder'; } },
      activeSpace: firstSpace,
      activeWindowTab: undefined,
      browserState: browserState(undefined),
      focusAudibleTab: async () => undefined,
      selectSpace: async () => true,
      showNotice: () => undefined,
      spaces: spaces.slice(0, 1),
    });

    void rows.find((row) => row.id === 'create-tab-folder')?.run();
    expect(ran).toBe('createTabFolder');
    expect(rows.some((row) => row.id === 'show-tabs')).toBe(false);
    expect(rows.some((row) => row.id === 'next-space')).toBe(false);
  });
});
