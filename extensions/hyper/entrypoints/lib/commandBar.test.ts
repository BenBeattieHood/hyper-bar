import { describe, expect, it, vi } from 'vitest';
import {
  formatHistoryVisitDate,
  isDirectSearchShortcut,
  matchingCommands,
  navigationTarget,
  opensInNewTab,
  selectedResultIndex,
  shouldPrioritiseWebSearch,
  webSearchTarget,
  type CommandAction,
} from './commandBar';
import { searchWithDefaultEngine } from './browserSearch';
import type { SearchItem } from './search';

const command = (
  id: CommandAction['icon'],
  label: string,
  detail: string,
  keywords?: string[],
): CommandAction => ({ id, label, detail, icon: id, ...(keywords ? { keywords } : {}), run: vi.fn() });

const commands = [
  command('reload', 'Reload current tab', 'Page', ['refresh']),
  command('restore', 'Reopen closed tab', 'Tabs', ['undo close']),
  command('new-window', 'Open new window', 'Window'),
];

const searchTarget = (query: string) => ({
  kind: 'search',
  query,
  label: `Search the web for “${query}”`,
  detail: 'Search',
});

describe('selectedResultIndex', () => {
  const results = [{ id: 'first' }, { id: 'second' }, { id: 'third' }];

  it('keeps the selected result when live results reorder', () => {
    expect(selectedResultIndex(
      [results[1]!, results[0]!, results[2]!],
      'second',
    )).toBe(0);
  });

  it('falls back to the first result when the selection disappears', () => {
    expect(selectedResultIndex(results, 'missing')).toBe(0);
  });
});

describe('isDirectSearchShortcut', () => {
  const shortcut = (
    modifiers: Partial<Pick<KeyboardEvent, 'altKey' | 'ctrlKey' | 'metaKey'>>,
    key = 'Enter',
  ) => isDirectSearchShortcut({
    altKey: false,
    ctrlKey: false,
    key,
    metaKey: false,
    ...modifiers,
  });

  it.each([
    { altKey: true },
  ])('opens a direct search for modified Enter: %o', (modifiers) => {
    expect(shortcut(modifiers)).toBe(true);
  });

  it('keeps Ctrl/Cmd+Enter for the selected result', () => {
    expect(shortcut({ ctrlKey: true })).toBe(false);
    expect(shortcut({ metaKey: true })).toBe(false);
  });

  it('keeps plain Enter and unrelated modified keys for normal handling', () => {
    expect(shortcut({})).toBe(false);
    expect(shortcut({ ctrlKey: true }, 'ArrowDown')).toBe(false);
  });
});

describe('opensInNewTab', () => {
  const click = (event: Partial<Pick<MouseEvent, 'button' | 'ctrlKey' | 'metaKey'>>) =>
    opensInNewTab({ button: 0, ctrlKey: false, metaKey: false, ...event });

  it('treats modified and middle clicks as a request for a new tab', () => {
    expect(click({ ctrlKey: true })).toBe(true);
    expect(click({ metaKey: true })).toBe(true);
    expect(click({ button: 1 })).toBe(true);
    expect(click({})).toBe(false);
  });

  it('treats Ctrl/Cmd+Enter as a request for a new tab', () => {
    expect(opensInNewTab({ ctrlKey: true, metaKey: false })).toBe(true);
    expect(opensInNewTab({ ctrlKey: false, metaKey: true })).toBe(true);
  });
});

describe('formatHistoryVisitDate', () => {
  it('formats a visit with weekday, relative days, and 24-hour time', () => {
    const visited = new Date(2026, 7, 3, 15, 30);
    const now = new Date(2026, 7, 6, 9, 0);

    expect(formatHistoryVisitDate(visited.getTime(), now)).toBe('Mon, 2d ago, 15:30');
  });

  it('counts midnights since the visit and shows only the time when that is zero', () => {
    const now = new Date(2026, 7, 6, 9, 0);
    const format = (visited: Date, at = now) => formatHistoryVisitDate(visited.getTime(), at);

    // Same day: no midnight has passed.
    expect(format(new Date(2026, 7, 6, 8, 59))).toBe('08:59');
    // One midnight, within 20 hours and after 3am: counts as a day.
    expect(format(new Date(2026, 7, 5, 13, 0))).toBe('Wed, 1d ago, 13:00');
    // One midnight but over 20 hours ago: one less.
    expect(format(new Date(2026, 7, 5, 12, 59))).toBe('12:59');
    expect(format(new Date(2026, 7, 4, 12, 0))).toBe('Tue, 1d ago, 12:00');
    // One midnight but now is before 3am: one less.
    expect(format(new Date(2026, 7, 5, 23, 0), new Date(2026, 7, 6, 2, 59))).toBe('23:00');
    expect(format(new Date(2026, 7, 5, 23, 0), new Date(2026, 7, 6, 3, 0))).toBe('Wed, 1d ago, 23:00');
  });

  it('omits missing or invalid timestamps', () => {
    expect(formatHistoryVisitDate(undefined)).toBeUndefined();
    expect(formatHistoryVisitDate(Number.NaN)).toBeUndefined();
  });
});

describe('matchingCommands', () => {
  it('keeps declared order for an empty query', () => {
    expect(matchingCommands(commands, '')).toEqual(commands);
  });

  it('ranks label prefixes ahead of keyword matches', () => {
    expect(matchingCommands(commands, 're').map(({ id }) => id)).toEqual([
      'reload',
      'restore',
    ]);
  });

  it('matches aliases and details', () => {
    expect(matchingCommands(commands, 'refresh').map(({ id }) => id)).toEqual(['reload']);
    expect(matchingCommands(commands, 'window').map(({ id }) => id)).toEqual(['new-window']);
  });
});

describe('navigationTarget', () => {
  it('preserves explicit web URLs', () => {
    expect(navigationTarget('https://example.com/path')).toMatchObject({
      kind: 'url',
      url: 'https://example.com/path',
    });
  });

  it('adds a scheme to domains and local addresses', () => {
    expect(navigationTarget('example.com/docs')).toMatchObject({
      kind: 'url',
      url: 'https://example.com/docs',
    });
    expect(navigationTarget('localhost:5173')).toMatchObject({
      kind: 'url',
      url: 'https://localhost:5173/',
    });
  });

  it('turns plain text into a native web search query', () => {
    expect(navigationTarget('arc command bar')).toEqual(searchTarget('arc command bar'));
  });

  it('does not create a target for whitespace', () => {
    expect(navigationTarget('   ')).toBeUndefined();
  });
});

describe('webSearchTarget', () => {
  it('searches URL-shaped input literally for modified Enter', () => {
    expect(webSearchTarget('example.com/docs')).toEqual(searchTarget('example.com/docs'));
  });

  it('does not create a search target for empty input', () => {
    expect(webSearchTarget('   ')).toBeUndefined();
  });
});

const page = (kind: 'bookmark' | 'tab', title: string): SearchItem => ({
  id: `${kind}:${title}`,
  kind,
  source: kind,
  title,
  detail: kind === 'tab' ? 'Open tab' : 'Bookmark',
  url: `https://example.com/${title.toLocaleLowerCase().replaceAll(' ', '-')}`,
});

describe('shouldPrioritiseWebSearch', () => {
  it('promotes web search when there are no commands and page matches are weak', () => {
    expect(shouldPrioritiseWebSearch([
      { kind: 'item', item: page('bookmark', 'Command patterns') },
      { kind: 'item', item: page('tab', 'Search handbook') },
    ], 'ar')).toBe(true);
  });

  it('keeps commands and strong page matches ahead of web search', () => {
    expect(shouldPrioritiseWebSearch([{ kind: 'command' }], 'reload')).toBe(false);
    expect(shouldPrioritiseWebSearch([
      { kind: 'item', item: page('tab', 'Arc command bar') },
    ], 'arc')).toBe(false);
    expect(shouldPrioritiseWebSearch([
      { kind: 'item', item: page('bookmark', 'Guide to Arc') },
    ], 'arc')).toBe(false);
  });

  it('promotes web search when no page or command matches are returned', () => {
    expect(shouldPrioritiseWebSearch([], 'weather tomorrow')).toBe(true);
  });

  it('treats URLs holding every query word as strong, but not scattered letters', () => {
    expect(shouldPrioritiseWebSearch([{
      kind: 'item',
      item: {
        ...page('tab', 'Netbank'),
        url: 'https://github.com/netbank',
      },
    }], 'github netbank')).toBe(false);
    expect(shouldPrioritiseWebSearch([{
      kind: 'item',
      item: {
        ...page('tab', 'Netbank'),
        url: 'https://github.com/netbank',
      },
    }], 'githubnetba')).toBe(true);
    expect(shouldPrioritiseWebSearch([{
      kind: 'item',
      item: {
        ...page('tab', 'Weak URL'),
        url: 'https://github.com/nextjs/tbank',
      },
    }], 'githubnetba')).toBe(true);
  });
});

describe('searchWithDefaultEngine', () => {
  it('uses the Chromium search API with the exact target tab', async () => {
    const query = vi.fn().mockResolvedValue(undefined);

    await searchWithDefaultEngine('weather tomorrow', 42, { query });

    expect(query).toHaveBeenCalledWith({ text: 'weather tomorrow', tabId: 42 });
  });

  it('uses the Firefox search API with the exact target tab', async () => {
    const search = vi.fn().mockResolvedValue(undefined);

    await searchWithDefaultEngine('weather tomorrow', 42, { search });

    expect(search).toHaveBeenCalledWith({ query: 'weather tomorrow', tabId: 42 });
  });

  it('fails clearly when the browser search API is unavailable', async () => {
    await expect(searchWithDefaultEngine('weather tomorrow', 42, null))
      .rejects.toThrow('default engine is unavailable');
  });

  it('names a browser without a default engine as unsupported, and passes other errors on', async () => {
    const query = vi.fn()
      .mockRejectedValueOnce(new Error('Missing default search provider.'))
      .mockRejectedValueOnce(new Error('No tab with id: 42.'));

    await expect(searchWithDefaultEngine('weather tomorrow', 42, { query }))
      .rejects.toMatchObject({ failure: 'unsupported', name: 'CommandFailureError' });
    await expect(searchWithDefaultEngine('weather tomorrow', 42, { query }))
      .rejects.toThrow('No tab with id: 42.');
  });
});