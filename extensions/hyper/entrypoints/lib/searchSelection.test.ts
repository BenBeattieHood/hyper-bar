import { describe, expect, it } from 'vitest';
import {
  forgetSearchSelection,
  parseSearchSelectionHistory,
  RECENT_SELECTION_WINDOW_MS,
  recentSearchSelections,
  recordSearchSelection,
  searchSelectionPreference,
  type SearchSelectionHistory,
} from './searchSelection';

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_000 * DAY;

describe('search selection preference', () => {
  it('prefers a result picked for the same normalised query', () => {
    const history = recordSearchSelection({}, '  Hyper ', 'second', NOW);
    const preference = searchSelectionPreference(history, 'hyper', NOW);

    expect(preference('second')).toEqual({ similarQuery: true, strength: expect.any(Number) });
    expect(preference('second')!.strength).toBeGreaterThan(0);
    expect(preference('first')).toBeUndefined();
  });

  it('treats a query one begins or extends as similar, and any other as dissimilar', () => {
    const history = recordSearchSelection({}, 'design', 'bookmark:x', NOW);

    expect(searchSelectionPreference(history, 'des', NOW)('bookmark:x')!.similarQuery).toBe(true);
    expect(searchSelectionPreference(history, 'Design notes', NOW)('bookmark:x')!.similarQuery).toBe(true);
    expect(searchSelectionPreference(history, 'github', NOW)('bookmark:x')!.similarQuery).toBe(false);
    expect(searchSelectionPreference(history, 'sign', NOW)('bookmark:x')!.similarQuery).toBe(false);
  });

  it('grows with repeated use for the same query but stays bounded', () => {
    let history: SearchSelectionHistory = {};
    const preferences: number[] = [];
    for (let count = 0; count < 32; count += 1) {
      history = recordSearchSelection(history, 'hyper', 'sixth', NOW);
      preferences.push(searchSelectionPreference(history, 'hyper', NOW)('sixth')!.strength);
    }

    expect(preferences[1]).toBeGreaterThan(preferences[0]!);
    expect(preferences.at(-1)).toBeLessThanOrEqual(1);
  });

  it('counts a recent pick for a dissimilar query, fading with age, but not an old one', () => {
    const history = recordSearchSelection({}, 'design', 'bookmark:x', NOW - DAY);
    const fresh = searchSelectionPreference(history, 'notes', NOW)('bookmark:x');
    const older = searchSelectionPreference(history, 'notes', NOW + 5 * DAY)('bookmark:x');

    expect(fresh!.strength).toBeGreaterThan(older!.strength);
    expect(searchSelectionPreference(history, 'notes', NOW + RECENT_SELECTION_WINDOW_MS)('bookmark:x'))
      .toBeUndefined();
    expect(searchSelectionPreference(history, 'des', NOW + RECENT_SELECTION_WINDOW_MS)('bookmark:x')!.strength)
      .toBeGreaterThan(0);
  });

  it('ignores malformed stored data', () => {
    expect(parseSearchSelectionHistory({ hyper: { second: { count: 'many' } } }))
      .toEqual({});
  });

  it('preserves prototype-shaped keys as own persisted records', () => {
    const parsed = parseSearchSelectionHistory({
      ['__proto__']: { second: { count: 1, lastUsed: 100 } },
    });
    const history = recordSearchSelection({}, '__proto__', 'constructor', NOW);

    expect(Object.hasOwn(parsed, '__proto__')).toBe(true);
    expect(Object.hasOwn(history, '__proto__')).toBe(true);
    expect(Object.hasOwn(history.__proto__ ?? {}, 'constructor')).toBe(true);
    expect(searchSelectionPreference(history, '__proto__', NOW)('constructor')!.strength).toBeGreaterThan(0);
    expect(searchSelectionPreference({}, 'x', NOW)('constructor')).toBeUndefined();
  });

  it('discards malformed nested values before recording a new selection', () => {
    const history = recordSearchSelection({
      hyper: {
        broken: { count: Number.NaN, lastUsed: 1 },
      },
    } as SearchSelectionHistory, 'hyper', 'second', 100);

    expect(history).toEqual({
      hyper: {
        second: { count: 1, lastUsed: 100 },
      },
    });
  });
});

describe('recent search selections', () => {
  it('lists each result once, newest first, with the query it was last picked for', () => {
    let history: SearchSelectionHistory = {};
    history = recordSearchSelection(history, 'des', 'bookmark:design', 1);
    history = recordSearchSelection(history, 'mail', 'tab:mail', 2);
    history = recordSearchSelection(history, 'design', 'bookmark:design', 3);

    expect(recentSearchSelections(history)).toEqual([
      { lastUsed: 3, query: 'design', resultId: 'bookmark:design' },
      { lastUsed: 2, query: 'mail', resultId: 'tab:mail' },
    ]);
  });

  it('forgets a result from every query it was picked for', () => {
    let history: SearchSelectionHistory = {};
    history = recordSearchSelection(history, 'des', 'bookmark:design', 1);
    history = recordSearchSelection(history, 'design', 'bookmark:design', 2);
    history = recordSearchSelection(history, 'design', 'tab:docs', 3);

    const forgotten = forgetSearchSelection(history, 'bookmark:design');

    expect(forgotten).toEqual({ design: { 'tab:docs': { count: 1, lastUsed: 3 } } });
    expect(searchSelectionPreference(forgotten, 'design', 3)('bookmark:design')).toBeUndefined();
    expect(forgetSearchSelection(forgotten, 'bookmark:design')).toBe(forgotten);
  });
});
