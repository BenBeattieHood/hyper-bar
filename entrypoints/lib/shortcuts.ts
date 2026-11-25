/**
 * Every keyboard shortcut Hyper handles or shows, in one place, so a key's
 * handler, its button's tooltip and its Search row cannot disagree.
 * Pure data and helpers: views, the content script and `wxt.config.ts` all read it.
 */

export type ShortcutPlatform = 'mac' | 'other';

export interface KeyBinding {
  /** A named `KeyboardEvent.key` ('F2', 'ArrowUp'), or one lower-case character. */
  key: string;
  /** Command on macOS, Ctrl elsewhere. */
  mod?: boolean;
  alt?: boolean;
  shift?: boolean;
}

/**
 * - `hyper`: a Hyper view listens for the key.
 * - `browser`: the browser's own key; Hyper only shows it.
 * - `manifest`: an extension command the browser routes to Hyper, even from a web page.
 */
export type ShortcutOwner = 'browser' | 'hyper' | 'manifest';

/**
 * - `sidebar`: anywhere in the sidebar; Alt and unmodified keys skip text fields.
 * - `item`: the focused sidebar row.
 * - `page`: a web page and the new tab page.
 * - `browser`: anywhere in the browser.
 */
export type ShortcutScope = 'browser' | 'item' | 'page' | 'sidebar';

export interface ShortcutDefinition {
  label: string;
  binding: KeyBinding;
  /** Further keys that do the same; tooltips show only `binding`. */
  alternates?: readonly KeyBinding[];
  /** Firefox's key, where its manifest command differs. */
  firefox?: KeyBinding;
  owner: ShortcutOwner;
  scope: ShortcutScope;
  /** The id of the Search command row that runs it, when Search lists it. */
  command?: string;
  /** A sidebar button runs it, so that button's tooltip must show the key. */
  button?: boolean;
}

const alt = (key: string, shift = false): KeyBinding => ({ key, alt: true, ...(shift ? { shift } : {}) });
const mod = (key: string, shift = false): KeyBinding => ({ key, mod: true, ...(shift ? { shift } : {}) });

/** Builds the shortcuts one owner handles in one scope. */
const shortcutsOf = (owner: ShortcutOwner, scope: ShortcutScope) => (
  label: string,
  binding: KeyBinding,
  options: Partial<ShortcutDefinition> = {},
): ShortcutDefinition => ({ label, binding, owner, scope, ...options });
const sidebarKey = shortcutsOf('hyper', 'sidebar');
const itemKey = shortcutsOf('hyper', 'item');
const browserKey = (label: string, binding: KeyBinding, command: string) =>
  shortcutsOf('browser', 'browser')(label, binding, { command });
/** A sidebar shortcut with a button and a Search command row. */
const sidebarButton = (label: string, binding: KeyBinding, command?: string) =>
  sidebarKey(label, binding, { ...(command ? { command } : {}), button: true });

const FIXED_SHORTCUTS = {
  openHyper: shortcutsOf('manifest', 'browser')('Open Hyper', mod('p', true), {
    firefox: alt('h', true),
    command: 'open-hyper',
  }),
  search: sidebarKey('Search', mod('p'), { alternates: [mod('k'), { key: '/' }], button: true }),
  pageSearch: shortcutsOf('hyper', 'page')('Search from a page', mod('p')),
  settings: sidebarButton('Settings', alt(','), 'open-settings'),
  showTabs: sidebarButton('Tabs', alt('t'), 'show-tabs'),
  showBookmarks: sidebarButton('Bookmarks', alt('b'), 'show-bookmarks'),
  addBookmark: sidebarKey('Bookmark current tab', alt('a'), { command: 'add-to-space' }),
  addFavourite: sidebarKey('Add current page to favourites', alt('a', true), { command: 'add-favourite' }),
  createTabFolder: sidebarButton('Create tab folder', alt('o'), 'create-tab-folder'),
  createBookmarkFolder: sidebarButton('Create bookmark folder', alt('o', true), 'create-bookmark-folder'),
  recentTabs: sidebarButton('Recent tabs', alt('r')),
  globalBookmarks: sidebarButton('Global bookmarks', alt('g'), 'toggle-global-bookmarks'),
  newSpace: sidebarButton('Add space', alt('n'), 'new-space'),
  previousSpace: sidebarKey('Switch to previous space', alt('['), { command: 'previous-space' }),
  nextSpace: sidebarKey('Switch to next space', alt(']'), { command: 'next-space' }),
  renameItem: itemKey('Rename', { key: 'F2' }),
  deleteItem: itemKey('Delete', { key: 'Delete' }, { alternates: [{ key: 'Backspace' }] }),
  moveItemUp: itemKey('Move up', alt('ArrowUp')),
  moveItemDown: itemKey('Move down', alt('ArrowDown')),
  cutItem: itemKey('Cut', mod('x')),
  copyItem: itemKey('Copy', mod('c')),
  pasteItem: itemKey('Paste', mod('v')),
  newTab: browserKey('Open new tab', mod('t'), 'new-tab'),
  newWindow: browserKey('Open new window', mod('n'), 'new-window'),
  newPrivateWindow: browserKey('Open private window', mod('n', true), 'new-private-window'),
  restoreTab: browserKey('Reopen closed tab', mod('t', true), 'restore-tab'),
  closeTab: browserKey('Close tab', mod('w'), 'close-tab'),
  copyUrl: browserKey('Copy URL', mod('c', true), 'copy-url'),
  reload: browserKey('Reload', mod('r'), 'reload'),
  zoomIn: browserKey('Zoom in', mod('+'), 'zoom-in'),
  zoomOut: browserKey('Zoom out', mod('-'), 'zoom-out'),
  zoomReset: browserKey('Reset zoom', mod('0'), 'zoom-reset'),
} satisfies Record<string, ShortcutDefinition>;

/** Alt+1 to Alt+9 open the spaces in the order their buttons show. */
export const SPACE_SHORTCUT_COUNT = 9;
export type SpaceShortcutId = `space${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}`;
export type ShortcutId = keyof typeof FIXED_SHORTCUTS | SpaceShortcutId;

/** The shortcut for the space at `index` among the space buttons, if it has one. */
export function spaceShortcutId(index: number): SpaceShortcutId | undefined {
  return Number.isInteger(index) && index >= 0 && index < SPACE_SHORTCUT_COUNT
    ? `space${index + 1}` as SpaceShortcutId
    : undefined;
}

const SPACE_SHORTCUTS = Object.fromEntries(
  Array.from({ length: SPACE_SHORTCUT_COUNT }, (_, index) => [
    `space${index + 1}`,
    sidebarButton(`Switch to space ${index + 1}`, alt(String(index + 1))),
  ]),
) as Record<SpaceShortcutId, ShortcutDefinition>;

export const SHORTCUTS: Readonly<Record<ShortcutId, ShortcutDefinition>> = {
  ...FIXED_SHORTCUTS,
  ...SPACE_SHORTCUTS,
};

export const SHORTCUT_IDS = Object.keys(SHORTCUTS) as ShortcutId[];

export const currentPlatform: ShortcutPlatform =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.platform ?? '')
    ? 'mac'
    : 'other';

const isFirefoxBuild = import.meta.env?.BROWSER === 'firefox';

/** The key a shortcut uses in this build. */
export function shortcutBinding(id: ShortcutId, firefox = isFirefoxBuild): KeyBinding {
  const shortcut = SHORTCUTS[id];
  return (firefox && shortcut.firefox) || shortcut.binding;
}

/** Every key that runs a shortcut in this build: its binding, then its alternates. */
export function shortcutBindings(id: ShortcutId, firefox = isFirefoxBuild): KeyBinding[] {
  return [shortcutBinding(id, firefox), ...(SHORTCUTS[id].alternates ?? [])];
}

const MAC_KEY_LABELS: Readonly<Record<string, string>> = {
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  ArrowUp: '↑',
  Backspace: '⌫',
  Delete: '⌦',
};
const OTHER_KEY_LABELS: Readonly<Record<string, string>> = {
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  ArrowUp: 'Up',
};

function keyLabel(key: string, platform: ShortcutPlatform): string {
  if (key.length === 1) return key.toLocaleUpperCase();
  return (platform === 'mac' ? MAC_KEY_LABELS : OTHER_KEY_LABELS)[key] ?? key;
}

/** A binding as `Mod+Alt+Shift+Key`, with the primary modifier and the key spelled by the caller. */
function joinBinding(binding: KeyBinding, modName: string, keyName: string): string {
  return [binding.mod && modName, binding.alt && 'Alt', binding.shift && 'Shift', keyName]
    .filter(Boolean).join('+');
}

/** How a key reads on screen: `⌥⇧A` on macOS, `Alt+Shift+A` elsewhere. */
export function bindingLabel(binding: KeyBinding, platform = currentPlatform): string {
  if (platform === 'mac') {
    return `${binding.alt ? '⌥' : ''}${binding.shift ? '⇧' : ''}${binding.mod ? '⌘' : ''}${keyLabel(binding.key, platform)}`;
  }
  return joinBinding(binding, 'Ctrl', keyLabel(binding.key, platform));
}

/** How a middle-click reads on screen: `⌘Middle-click` on macOS, `Ctrl+Middle-click` elsewhere. */
export function middleClickLabel(withMod = false, platform = currentPlatform): string {
  if (!withMod) return 'Middle-click';
  return platform === 'mac' ? '⌘Middle-click' : 'Ctrl+Middle-click';
}

export function shortcutLabel(id: ShortcutId, platform = currentPlatform): string {
  return bindingLabel(shortcutBinding(id), platform);
}

/** A tooltip naming the control and its key, as `Search (⌘P)` or `Search (Ctrl+P)`. */
export function shortcutTitle(id: ShortcutId, label: string = SHORTCUTS[id].label, platform = currentPlatform): string {
  return `${label} (${shortcutLabel(id, platform)})`;
}

/** The `aria-keyshortcuts` value for every key that runs the shortcut. */
export function ariaKeyShortcuts(id: ShortcutId, platform = currentPlatform): string {
  return shortcutBindings(id).map((binding) => joinBinding(
    binding,
    platform === 'mac' ? 'Meta' : 'Control',
    binding.key.length === 1 ? binding.key.toLocaleUpperCase() : binding.key,
  )).join(' ');
}

/** Props for a button that runs a shortcut: its tooltip, accessible keys and registry id. */
export function shortcutButtonProps(id: ShortcutId, label?: string) {
  return {
    'aria-keyshortcuts': ariaKeyShortcuts(id),
    'data-shortcut': id,
    title: shortcutTitle(id, label),
  };
}

const PUNCTUATION_CODES: Readonly<Record<string, string>> = {
  ',': 'Comma',
  '-': 'Minus',
  '.': 'Period',
  '/': 'Slash',
  '+': 'Equal',
  '=': 'Equal',
  '[': 'BracketLeft',
  ']': 'BracketRight',
};

function keyCode(key: string): string | undefined {
  if (/^[a-z]$/.test(key)) return `Key${key.toUpperCase()}`;
  if (/^\d$/.test(key)) return `Digit${key}`;
  return PUNCTUATION_CODES[key];
}

export interface ShortcutKeyEvent {
  altKey: boolean;
  code?: string;
  ctrlKey: boolean;
  key: string;
  metaKey: boolean;
  shiftKey: boolean;
}

/**
 * Whether a key press is the binding. Command and Ctrl both count as the
 * primary modifier, as they always have here. Where the layout or Option types
 * another character (`å`, `¡`, `ф`), the key's place decides, so Alt+A still
 * means Alt+A; an AltGr press (Ctrl+Alt) never matches an Alt binding.
 */
export function matchesBinding(event: ShortcutKeyEvent, binding: KeyBinding): boolean {
  if (Boolean(binding.mod) !== (event.metaKey || event.ctrlKey)) return false;
  if (Boolean(binding.alt) !== event.altKey) return false;
  const pressed = event.key.length === 1 ? event.key.toLocaleLowerCase() : event.key;
  if (binding.key.length > 1) {
    return pressed === binding.key && Boolean(binding.shift) === event.shiftKey;
  }
  const typedAscii = /^[\x20-\x7e]$/.test(pressed);
  if (/^[a-z\d]$/.test(binding.key)) {
    if (Boolean(binding.shift) !== event.shiftKey) return false;
    return pressed === binding.key ||
      (!/^[a-z\d]$/.test(pressed) && event.code === keyCode(binding.key));
  }
  // A punctuation character carries its own Shift.
  if (pressed === binding.key) return true;
  return !typedAscii &&
    Boolean(binding.shift) === event.shiftKey &&
    event.code === keyCode(binding.key);
}

/** Whether a key press runs the shortcut, by its main key or an alternate. */
export function matchesShortcut(event: ShortcutKeyEvent, id: ShortcutId): boolean {
  return shortcutBindings(id).some((binding) => matchesBinding(event, binding));
}

/** The sidebar shortcut a key press runs, if any. */
export function sidebarShortcutFor(event: ShortcutKeyEvent): ShortcutId | undefined {
  return SHORTCUT_IDS.find((id) =>
    SHORTCUTS[id].owner === 'hyper' && SHORTCUTS[id].scope === 'sidebar' && matchesShortcut(event, id));
}

/** A manifest `suggested_key` value, such as `Command+Shift+P`. */
export function manifestKey(binding: KeyBinding, platform: 'default' | 'mac'): string {
  return joinBinding(binding, platform === 'mac' ? 'Command' : 'Ctrl', binding.key.toLocaleUpperCase());
}
