import type { BrowserCommandCapabilities } from './browserCommandCapabilities';
import type { BrowserTab } from './bookmarks';
import type { CommandAction, CommandIcon } from './commandBar';
import type { CloseTabsPayload } from './modelIntentPayloads';
import { shortcutLabel, type ShortcutId } from './shortcuts';

type EmptyPayload = Record<string, never>;

export type BrowserCommandIntent =
  | { kind: 'activateTab'; payload: { tabId: number } }
  | { kind: 'closeTabs'; payload: Exclude<CloseTabsPayload, { condition: 'page-in-space' }> }
  | { kind: 'createTab'; payload: EmptyPayload }
  | { kind: 'createWindow'; payload: { incognito: boolean } }
  | { kind: 'detachTab'; payload: { tabId: number } }
  | { kind: 'duplicateTab'; payload: { tabId: number } }
  | { kind: 'navigateTabHistory'; payload: { direction: 'back' | 'forward'; tabId: number } }
  | { kind: 'reloadTab'; payload: { tabId: number } }
  | { kind: 'restoreClosedTab'; payload: { sessionId?: string } }
  | { kind: 'setTabMuted'; payload: { muted: boolean; tabId: number } }
  | { kind: 'setTabPinned'; payload: { pinned: boolean; tabId: number } }
  | { kind: 'setTabZoom'; payload: { mode: 'in' | 'out' | 'reset'; tabId: number } }
  | { kind: 'toggleWindowFullscreen'; payload: EmptyPayload };

interface BrowserCommandOptions {
  capabilities: BrowserCommandCapabilities;
  currentTab?: BrowserTab;
  onActiveTabChange?: () => void;
  onError: (message: string) => void;
  submitIntent: (intent: BrowserCommandIntent) => Promise<void>;
  tabs: readonly BrowserTab[];
}

async function writeClipboard(value: string): Promise<void> {
  if (!navigator.clipboard?.writeText) {
    throw new Error('Clipboard access is unavailable.');
  }
  await navigator.clipboard.writeText(value);
}

function adjacentTab(
  tabs: readonly BrowserTab[],
  active: BrowserTab,
  direction: -1 | 1,
): BrowserTab | undefined {
  const windowTabs = tabs
    .filter((tab) => tab.windowId === active.windowId)
    .sort((left, right) => left.index - right.index);
  const currentIndex = windowTabs.findIndex((tab) => tab.id === active.id);
  if (currentIndex < 0 || windowTabs.length === 0) return undefined;
  return windowTabs[(currentIndex + direction + windowTabs.length) % windowTabs.length];
}

type CommandDetail = 'Page' | 'Tabs' | 'Window';
type OptionalCapability = Exclude<keyof BrowserCommandCapabilities, 'available' | 'splitViewTabs'>;

/** Runs a command; `active` reads the current tab and throws when there is none. */
type CommandRun = (active: () => BrowserTab & { id: number }, options: BrowserCommandOptions) => Promise<unknown>;

/** One command as data: [id, label, detail, icon, keywords, run, extras]. */
type CommandSpec = readonly [
  id: string,
  label: string,
  detail: CommandDetail,
  icon: CommandIcon,
  keywords: string[],
  run: CommandRun,
  extras?: {
    /** The browser API it needs, when not every browser has it. */
    capability?: OptionalCapability;
    /** It moves the user to another tab, so the host must follow. */
    changesActiveTab?: boolean;
    shortcut?: ShortcutId;
  },
];

const submit = (intent: BrowserCommandIntent): CommandRun => (_active, options) => options.submitIntent(intent);
const submitForTab = (intent: (tab: BrowserTab & { id: number }) => BrowserCommandIntent): CommandRun =>
  (active, options) => options.submitIntent(intent(active()));
const tabId = (kind: 'detachTab' | 'duplicateTab' | 'reloadTab') =>
  submitForTab((tab) => ({ kind, payload: { tabId: tab.id } }));
const switchTab = (direction: -1 | 1): CommandRun => async (active, options) => {
  const target = adjacentTab(options.tabs, active(), direction);
  if (target?.id !== undefined) {
    await options.submitIntent({ kind: 'activateTab', payload: { tabId: target.id } });
  }
};
const navigate = (direction: 'back' | 'forward') =>
  submitForTab((tab) => ({ kind: 'navigateTabHistory', payload: { direction, tabId: tab.id } }));
const zoom = (mode: 'in' | 'out' | 'reset') =>
  submitForTab((tab) => ({ kind: 'setTabZoom', payload: { mode, tabId: tab.id } }));
const ZOOM_KEYWORDS = ['page size', 'scale'];

const COMMANDS: readonly CommandSpec[] = [
  ['new-tab', 'Open new tab', 'Tabs', 'new-tab', ['create tab'],
    submit({ kind: 'createTab', payload: {} }), { changesActiveTab: true, shortcut: 'newTab' }],
  ['new-window', 'Open new window', 'Window', 'new-window', ['create window'],
    submit({ kind: 'createWindow', payload: { incognito: false } }), { shortcut: 'newWindow' }],
  ['new-private-window', 'Open new private window', 'Window', 'private', ['incognito window'],
    submit({ kind: 'createWindow', payload: { incognito: true } }), { shortcut: 'newPrivateWindow' }],
  ['restore-tab', 'Reopen closed tab', 'Tabs', 'restore', ['restore tab', 'undo close'],
    submit({ kind: 'restoreClosedTab', payload: {} }),
    { capability: 'restoreClosedTab', changesActiveTab: true, shortcut: 'restoreTab' }],
  ['duplicate-tab', 'Duplicate current tab', 'Tabs', 'duplicate', ['copy tab', 'clone tab'],
    tabId('duplicateTab'), { capability: 'duplicateTab', changesActiveTab: true }],
  ['toggle-pin', 'Pin or unpin current tab', 'Tabs', 'pin', ['favourite tab', 'pinned'],
    submitForTab((tab) => ({ kind: 'setTabPinned', payload: { pinned: !tab.pinned, tabId: tab.id } }))],
  ['toggle-mute', 'Mute or unmute current tab', 'Tabs', 'mute', ['audio', 'sound'],
    submitForTab((tab) => ({ kind: 'setTabMuted', payload: { muted: !tab.mutedInfo?.muted, tabId: tab.id } }))],
  ['close-tab', 'Close current tab', 'Tabs', 'close', ['remove tab'],
    submitForTab((tab) => ({ kind: 'closeTabs', payload: { tabIds: [tab.id] } })), { shortcut: 'closeTab' }],
  ['close-other-tabs', 'Close other unpinned tabs', 'Tabs', 'close', ['clear tabs', 'close unpinned tabs'],
    async (active, options) => {
      const current = active();
      const tabIds = options.tabs.flatMap((tab) =>
        tab.id !== undefined && tab.id !== current.id && tab.windowId === current.windowId && !tab.pinned
          ? [tab.id]
          : []);
      if (tabIds.length > 0) {
        await options.submitIntent({
          kind: 'closeTabs',
          payload: { condition: 'other-unpinned', keepTabId: current.id, tabIds, windowId: current.windowId },
        });
      }
    }],
  ['previous-tab', 'Switch to previous tab', 'Tabs', 'tab', ['tab left'], switchTab(-1), { changesActiveTab: true }],
  ['next-tab', 'Switch to next tab', 'Tabs', 'tab', ['tab right'], switchTab(1), { changesActiveTab: true }],
  ['detach-tab', 'Move current tab to a new window', 'Window', 'move-window', ['detach tab'], tabId('detachTab')],
  ['copy-url', 'Copy current page URL', 'Page', 'copy', ['copy link', 'address'],
    async (active) => {
      const tab = active();
      return writeClipboard(tab.url ?? tab.pendingUrl ?? '');
    }, { shortcut: 'copyUrl' }],
  ['copy-markdown', 'Copy current page as Markdown', 'Page', 'copy', ['copy markdown link'],
    async (active) => {
      const tab = active();
      const url = tab.url ?? tab.pendingUrl;
      if (!url) throw new Error('The current page has no URL to copy.');
      return writeClipboard(`[${tab.title || url}](${url})`);
    }],
  ['reload', 'Reload current tab', 'Page', 'reload', ['refresh page'], tabId('reloadTab'), { shortcut: 'reload' }],
  ['back', 'Go back', 'Page', 'back', ['previous page'], navigate('back'), { capability: 'navigateBack' }],
  ['forward', 'Go forward', 'Page', 'forward', ['next page'], navigate('forward'), { capability: 'navigateForward' }],
  ['zoom-in', 'Zoom in', 'Page', 'zoom-in', ZOOM_KEYWORDS, zoom('in'), { capability: 'tabZoom', shortcut: 'zoomIn' }],
  ['zoom-out', 'Zoom out', 'Page', 'zoom-out', ZOOM_KEYWORDS, zoom('out'), { capability: 'tabZoom', shortcut: 'zoomOut' }],
  ['zoom-reset', 'Reset zoom', 'Page', 'zoom-reset', ZOOM_KEYWORDS, zoom('reset'),
    { capability: 'tabZoom', shortcut: 'zoomReset' }],
  ['toggle-fullscreen', 'Toggle full screen', 'Window', 'fullscreen', ['fullscreen'],
    submit({ kind: 'toggleWindowFullscreen', payload: {} })],
];

export const browserCommandActionKinds: readonly BrowserCommandIntent['kind'][] = [
  'activateTab',
  'closeTabs',
  'createTab',
  'createWindow',
  'detachTab',
  'duplicateTab',
  'navigateTabHistory',
  'reloadTab',
  'restoreClosedTab',
  'setTabMuted',
  'setTabPinned',
  'setTabZoom',
  'toggleWindowFullscreen',
];

/**
 * Builds view-safe command descriptors from the model projection. Browser
 * effects travel through the explicit intent union; clipboard access is local
 * presentation capability rather than browser-domain state.
 */
export function browserCommandActions(options: BrowserCommandOptions): CommandAction[] {
  if (!options.capabilities.available) return [];
  const active = () => {
    const tab = options.currentTab;
    if (tab?.id === undefined) throw new Error('The active tab is unavailable.');
    return tab as BrowserTab & { id: number };
  };
  return COMMANDS
    .filter(([, , , , , , extras]) => !extras?.capability || options.capabilities[extras.capability])
    .map(([id, label, detail, icon, keywords, run, extras]) => ({
      id,
      label,
      detail,
      icon,
      ...(extras?.shortcut ? { shortcut: shortcutLabel(extras.shortcut) } : {}),
      keywords,
      run: async () => {
        try {
          await run(active, options);
          if (extras?.changesActiveTab) options.onActiveTabChange?.();
        } catch (error) {
          options.onError(error instanceof Error ? error.message : `${label} could not be completed.`);
        }
      },
    }));
}

export function browserCommandSearchCommands(
  capabilities: BrowserCommandCapabilities,
): Omit<CommandAction, 'run'>[] {
  return browserCommandActions({
    capabilities,
    onError: () => undefined,
    submitIntent: async () => undefined,
    tabs: [],
  }).map(({ run: _run, ...command }) => command);
}