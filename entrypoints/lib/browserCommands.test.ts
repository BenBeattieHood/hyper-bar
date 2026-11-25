import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  browserCommandActions,
  browserCommandSearchCommands,
  type BrowserCommandIntent,
} from './browserCommands';
import type { BrowserCommandCapabilities } from './browserCommandCapabilities';

const capabilities: BrowserCommandCapabilities = {
  available: true,
  duplicateTab: true,
  navigateBack: true,
  navigateForward: true,
  restoreClosedTab: true,
  splitViewTabs: 2,
  tabZoom: true,
};

const currentTab = {
  id: 7,
  index: 1,
  mutedInfo: { muted: false },
  title: 'Current page',
  url: 'https://current.example',
  windowId: 3,
} as Browser.tabs.Tab;

const adjacentTab = {
  id: 8,
  index: 2,
  pinned: false,
  title: 'Next page',
  url: 'https://next.example',
  windowId: 3,
} as Browser.tabs.Tab;

afterEach(() => vi.unstubAllGlobals());

function commandsFor(options: Partial<{
  capabilities: BrowserCommandCapabilities;
  currentTab: Browser.tabs.Tab | undefined;
  tabs: Browser.tabs.Tab[];
}> = {}) {
  const intents: BrowserCommandIntent[] = [];
  const onActiveTabChange = vi.fn();
  const onError = vi.fn();
  const commands = browserCommandActions({
    capabilities: options.capabilities ?? capabilities,
    currentTab: 'currentTab' in options ? options.currentTab : currentTab,
    onActiveTabChange,
    onError,
    submitIntent: async (intent) => { intents.push(intent); },
    tabs: options.tabs ?? [
      { ...currentTab, index: 1 },
      { id: 6, index: 0, pinned: false, windowId: 3 } as Browser.tabs.Tab,
      adjacentTab,
      { id: 9, index: 3, pinned: true, windowId: 3 } as Browser.tabs.Tab,
      { id: 10, index: 0, pinned: false, windowId: 4 } as Browser.tabs.Tab,
    ],
  });
  const command = (id: string) => {
    const match = commands.find((candidate) => candidate.id === id);
    if (!match) throw new Error(`Missing command: ${id}`);
    return match;
  };
  return { command, commands, intents, onActiveTabChange, onError };
}

describe('browser command actions', () => {
  it('uses projected tabs to submit explicit model intents for browser mutations', async () => {
    const { command, intents, onActiveTabChange } = commandsFor();

    for (const id of [
      'new-tab', 'new-window', 'new-private-window', 'restore-tab', 'duplicate-tab', 'toggle-pin',
      'toggle-mute', 'close-tab', 'close-other-tabs', 'previous-tab', 'next-tab', 'detach-tab',
      'reload', 'back', 'forward', 'zoom-in', 'zoom-out', 'zoom-reset', 'toggle-fullscreen',
    ]) await command(id).run();

    expect(intents).toEqual([
      { kind: 'createTab', payload: {} },
      { kind: 'createWindow', payload: { incognito: false } },
      { kind: 'createWindow', payload: { incognito: true } },
      { kind: 'restoreClosedTab', payload: {} },
      { kind: 'duplicateTab', payload: { tabId: 7 } },
      { kind: 'setTabPinned', payload: { pinned: true, tabId: 7 } },
      { kind: 'setTabMuted', payload: { muted: true, tabId: 7 } },
      { kind: 'closeTabs', payload: { tabIds: [7] } },
      {
        kind: 'closeTabs',
        payload: {
          condition: 'other-unpinned',
          keepTabId: 7,
          tabIds: [6, 8],
          windowId: 3,
        },
      },
      { kind: 'activateTab', payload: { tabId: 6 } },
      { kind: 'activateTab', payload: { tabId: 8 } },
      { kind: 'detachTab', payload: { tabId: 7 } },
      { kind: 'reloadTab', payload: { tabId: 7 } },
      { kind: 'navigateTabHistory', payload: { direction: 'back', tabId: 7 } },
      { kind: 'navigateTabHistory', payload: { direction: 'forward', tabId: 7 } },
      { kind: 'setTabZoom', payload: { mode: 'in', tabId: 7 } },
      { kind: 'setTabZoom', payload: { mode: 'out', tabId: 7 } },
      { kind: 'setTabZoom', payload: { mode: 'reset', tabId: 7 } },
      { kind: 'toggleWindowFullscreen', payload: {} },
    ]);
    expect(onActiveTabChange).toHaveBeenCalledTimes(5);
  });

  it('keeps clipboard output local while reading its value from the projection', async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText }, platform: 'MacIntel' });
    const { command, intents } = commandsFor();

    await command('copy-url').run();
    await command('copy-markdown').run();

    expect(writeText).toHaveBeenNthCalledWith(1, 'https://current.example');
    expect(writeText).toHaveBeenNthCalledWith(
      2,
      '[Current page](https://current.example)',
    );
    expect(intents).toEqual([]);
  });

  it('hides commands the model reports as unsupported', () => {
    const unavailable: BrowserCommandCapabilities = {
      ...capabilities,
      available: false,
    };
    expect(commandsFor({ capabilities: unavailable }).commands).toEqual([]);

    const limited = commandsFor({
      capabilities: {
        ...capabilities,
        duplicateTab: false,
        navigateBack: false,
        navigateForward: false,
        restoreClosedTab: false,
        tabZoom: false,
      },
    }).commands.map((command) => command.id);
    expect(limited).not.toContain('duplicate-tab');
    expect(limited).not.toContain('restore-tab');
    expect(limited).not.toContain('back');
    expect(limited).not.toContain('forward');
    expect(limited).not.toContain('zoom-in');
  });

  it('reports an unavailable projected active tab through the command error channel', async () => {
    const { command, onError } = commandsFor({ currentTab: undefined });

    await command('reload').run();

    expect(onError).toHaveBeenCalledWith('The active tab is unavailable.');
  });

  it('builds background search descriptors without executable browser effects', () => {
    const commands = browserCommandSearchCommands(capabilities);

    expect(commands.find((command) => command.id === 'reload')).toMatchObject({
      label: 'Reload current tab',
    });
    expect(commands.every((command) => !('run' in command))).toBe(true);
  });
});