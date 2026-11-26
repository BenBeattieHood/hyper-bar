import { describe, expect, it } from 'vitest';
import {
  isPageOpenShortcut,
  parseSearchOverlaySource,
  searchOverlayUrl,
} from './pageShortcut';

const keyEvent = (overrides: Partial<Parameters<typeof isPageOpenShortcut>[0]> = {}) => ({
  key: 'p',
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...overrides,
});

describe('page open shortcut', () => {
  it('accepts Ctrl+P and Command+P', () => {
    expect(isPageOpenShortcut(keyEvent({ ctrlKey: true }))).toBe(true);
    expect(isPageOpenShortcut(keyEvent({ key: 'P', metaKey: true }))).toBe(true);
  });

  it('leaves the browser-level fallback and modified chords alone', () => {
    expect(isPageOpenShortcut(keyEvent({ ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(isPageOpenShortcut(keyEvent({ metaKey: true, shiftKey: true }))).toBe(false);
    expect(isPageOpenShortcut(keyEvent({ ctrlKey: true, altKey: true }))).toBe(false);
    expect(isPageOpenShortcut(keyEvent())).toBe(false);
  });

  it('round-trips an overlay source without accepting invalid IDs', () => {
    const url = searchOverlayUrl('chrome-extension://hyper/newtab.html', {
      tabId: 42,
      windowId: 7,
    });

    expect(parseSearchOverlaySource(url)).toEqual({ tabId: 42, windowId: 7 });
    expect(parseSearchOverlaySource(
      'chrome-extension://hyper/newtab.html?mode=search-overlay&sourceTabId=x&sourceWindowId=7',
    )).toBeUndefined();
  });
});