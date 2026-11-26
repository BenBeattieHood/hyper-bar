import { describe, expect, it } from 'vitest';
import {
  ariaKeyShortcuts,
  bindingLabel,
  manifestKey,
  matchesShortcut,
  SHORTCUT_IDS,
  SHORTCUTS,
  shortcutBinding,
  shortcutBindings,
  shortcutTitle,
  sidebarShortcutFor,
  spaceShortcutId,
  type KeyBinding,
  type ShortcutKeyEvent,
  type ShortcutScope,
} from './shortcuts';

const press = (key: string, modifiers: Partial<ShortcutKeyEvent> = {}): ShortcutKeyEvent => ({
  altKey: false,
  ctrlKey: false,
  key,
  metaKey: false,
  shiftKey: false,
  ...modifiers,
});

/** One spelling per chord, so equal chords compare equal. */
const chord = ({ alt, key, mod, shift }: KeyBinding) =>
  [mod && 'mod', alt && 'alt', shift && 'shift', key.toLocaleLowerCase()].filter(Boolean).join('+');

/** Scopes whose keys can reach the same handler at once. */
const scopesOverlap = (a: ShortcutScope, b: ShortcutScope) =>
  a === b || a === 'browser' || b === 'browser' || (a !== 'page' && b !== 'page');

/** The browsers' own keys a Hyper shortcut must leave alone. */
const SHARED_BROWSER_KEYS = [
  'mod+t', 'mod+n', 'mod+w', 'mod+shift+t', 'mod+shift+n', 'mod+shift+w', 'mod+l', 'mod+d', 'mod+shift+d',
  'mod+f', 'mod+g', 'mod+shift+g', 'mod+h', 'mod+j', 'mod+o', 'mod+s', 'mod+r', 'mod+shift+r', 'mod+q',
  'mod+e', 'mod+u', 'mod+a', 'mod+z', 'mod+shift+z', 'mod+y', 'mod+x', 'mod+c', 'mod+v', 'mod+p', 'mod+k',
  'mod+,', 'mod+[', 'mod+]', 'mod++', 'mod+-', 'mod+0', 'mod+shift+b', 'mod+shift+o', 'mod+shift+i',
  'mod+shift+j', 'mod+shift+c', 'mod+shift+delete', 'mod+shift+a', 'mod+shift+m',
  ...Array.from({ length: 9 }, (_, index) => `mod+${index + 1}`),
  'alt+d', 'alt+f', 'alt+e', 'alt+home', 'alt+arrowleft', 'alt+arrowright',
  'f1', 'f3', 'f5', 'f6', 'f7', 'f10', 'f11', 'f12',
];
const CHROME_KEYS = [...SHARED_BROWSER_KEYS, 'alt+shift+a', 'alt+shift+b', 'alt+shift+i', 'alt+shift+t'];
const FIREFOX_KEYS = [
  ...SHARED_BROWSER_KEYS, 'mod+shift+p', 'mod+shift+e', 'mod+shift+h', 'mod+b', 'mod+i',
  // Menu-bar access keys on Windows and Linux.
  'alt+f', 'alt+e', 'alt+v', 'alt+s', 'alt+b', 'alt+t', 'alt+h',
];

/**
 * Browser keys Hyper takes on purpose, each for its own reason:
 * - mod+p and mod+k open Search, the way they always have.
 * - mod+x, mod+c and mod+v act on a focused row, where there is no text to cut or copy.
 * - alt+shift+a (Chrome on Windows focuses an inactive dialog) adds to favourites, as it always has.
 * - alt+t and alt+b open the lists; on Firefox the sidebar keeps them from reaching the menu bar.
 */
const TAKEN_ON_PURPOSE = new Set(['mod+p', 'mod+k', 'mod+x', 'mod+c', 'mod+v', 'alt+shift+a', 'alt+t', 'alt+b']);

describe('shortcut labels', () => {
  it('reads with symbols on macOS and with words elsewhere', () => {
    expect(bindingLabel({ key: 'a', alt: true, shift: true }, 'mac')).toBe('⌥⇧A');
    expect(bindingLabel({ key: 'a', alt: true, shift: true }, 'other')).toBe('Alt+Shift+A');
    expect(bindingLabel({ key: 'e', mod: true, shift: true }, 'mac')).toBe('⇧⌘E');
    expect(bindingLabel({ key: 'e', mod: true, shift: true }, 'other')).toBe('Ctrl+Shift+E');
    expect(bindingLabel({ key: 'ArrowUp', alt: true }, 'mac')).toBe('⌥↑');
    expect(bindingLabel({ key: 'ArrowUp', alt: true }, 'other')).toBe('Alt+Up');
    expect(bindingLabel({ key: 'F2' }, 'other')).toBe('F2');
  });

  it('puts the key after the control name in a tooltip', () => {
    expect(shortcutTitle('search', 'Search', 'other')).toBe('Search (Ctrl+P)');
    expect(shortcutTitle('settings', undefined, 'mac')).toBe('Settings (⌥,)');
  });

  it('lists every key for assistive technology', () => {
    expect(ariaKeyShortcuts('search', 'mac')).toBe('Meta+P Meta+K /');
    expect(ariaKeyShortcuts('addFavourite', 'other')).toBe('Alt+Shift+A');
  });

  it('builds the manifest keys from the same bindings', () => {
    expect(manifestKey(shortcutBinding('openHyper', false), 'default')).toBe('Ctrl+Shift+P');
    expect(manifestKey(shortcutBinding('openHyper', false), 'mac')).toBe('Command+Shift+P');
    expect(manifestKey(shortcutBinding('openHyper', true), 'default')).toBe('Alt+Shift+H');
  });

  it('numbers only the first nine spaces', () => {
    expect(spaceShortcutId(0)).toBe('space1');
    expect(spaceShortcutId(8)).toBe('space9');
    expect(spaceShortcutId(9)).toBeUndefined();
    expect(spaceShortcutId(-1)).toBeUndefined();
  });
});

describe('shortcut matching', () => {
  it('takes Command or Ctrl as the primary modifier', () => {
    expect(matchesShortcut(press('p', { metaKey: true }), 'search')).toBe(true);
    expect(matchesShortcut(press('P', { ctrlKey: true }), 'search')).toBe(true);
    expect(matchesShortcut(press('p', { ctrlKey: true, shiftKey: true }), 'search')).toBe(false);
    expect(matchesShortcut(press('p'), 'search')).toBe(false);
  });

  it('follows the key position when Option or the layout types another character', () => {
    expect(matchesShortcut(press('å', { altKey: true, code: 'KeyA' }), 'addBookmark')).toBe(true);
    expect(matchesShortcut(press('Å', { altKey: true, shiftKey: true, code: 'KeyA' }), 'addFavourite')).toBe(true);
    expect(matchesShortcut(press('ф', { altKey: true, code: 'KeyA' }), 'addBookmark')).toBe(true);
    expect(matchesShortcut(press('¡', { altKey: true, code: 'Digit1' }), 'space1')).toBe(true);
    expect(matchesShortcut(press('≤', { altKey: true, code: 'Comma' }), 'settings')).toBe(true);
    expect(matchesShortcut(press('“', { altKey: true, code: 'BracketLeft' }), 'previousSpace')).toBe(true);
    expect(matchesShortcut(press('с', { ctrlKey: true, code: 'KeyC' }), 'copyItem')).toBe(true);
  });

  it('trusts a typed Latin character over the key position', () => {
    // AZERTY: the key at KeyQ types `a`.
    expect(matchesShortcut(press('a', { altKey: true, code: 'KeyQ' }), 'addBookmark')).toBe(true);
    expect(matchesShortcut(press('q', { altKey: true, code: 'KeyA' }), 'addBookmark')).toBe(false);
  });

  it('never treats AltGr as Alt', () => {
    expect(matchesShortcut(press('a', { altKey: true, ctrlKey: true, code: 'KeyA' }), 'addBookmark')).toBe(false);
    expect(sidebarShortcutFor(press('[', { altKey: true, ctrlKey: true, code: 'Digit8' }))).toBeUndefined();
  });

  it('keeps Shift apart for letters', () => {
    expect(sidebarShortcutFor(press('a', { altKey: true }))).toBe('addBookmark');
    expect(sidebarShortcutFor(press('A', { altKey: true, shiftKey: true }))).toBe('addFavourite');
    expect(sidebarShortcutFor(press('o', { altKey: true }))).toBe('createTabFolder');
    expect(sidebarShortcutFor(press('O', { altKey: true, shiftKey: true }))).toBe('createBookmarkFolder');
  });

  it('opens Search with slash and Command+K too', () => {
    expect(sidebarShortcutFor(press('/'))).toBe('search');
    expect(sidebarShortcutFor(press('k', { metaKey: true }))).toBe('search');
  });

  it('leaves item and browser keys to their own handlers', () => {
    expect(sidebarShortcutFor(press('F2'))).toBeUndefined();
    expect(sidebarShortcutFor(press('c', { metaKey: true }))).toBeUndefined();
    expect(sidebarShortcutFor(press('t', { metaKey: true }))).toBeUndefined();
    expect(matchesShortcut(press('Backspace'), 'deleteItem')).toBe(true);
    expect(matchesShortcut(press('ArrowDown', { altKey: true }), 'moveItemDown')).toBe(true);
  });
});

describe('shortcut bindings', () => {
  it('never gives two shortcuts the same key where both can hear it', () => {
    const clashes: string[] = [];
    for (const firefox of [false, true]) {
      SHORTCUT_IDS.forEach((a, index) => {
        for (const b of SHORTCUT_IDS.slice(index + 1)) {
          if (!scopesOverlap(SHORTCUTS[a].scope, SHORTCUTS[b].scope)) continue;
          const keys = new Set(shortcutBindings(a, firefox).map(chord));
          const shared = shortcutBindings(b, firefox).map(chord).filter((key) => keys.has(key));
          if (shared.length > 0) clashes.push(`${a} and ${b}: ${shared.join(', ')}${firefox ? ' (Firefox)' : ''}`);
        }
      });
    }

    expect(clashes).toEqual([]);
  });

  it('leaves the browsers\u2019 own keys alone unless it takes one on purpose', () => {
    const taken: string[] = [];
    for (const [firefox, browserKeys] of [[false, CHROME_KEYS], [true, FIREFOX_KEYS]] as const) {
      for (const id of SHORTCUT_IDS) {
        if (SHORTCUTS[id].owner === 'browser') continue;
        for (const key of shortcutBindings(id, firefox).map(chord)) {
          if (browserKeys.includes(key) && !TAKEN_ON_PURPOSE.has(key)) {
            taken.push(`${id}: ${key}${firefox ? ' (Firefox)' : ''}`);
          }
        }
      }
    }

    expect(taken).toEqual([]);
  });
});
