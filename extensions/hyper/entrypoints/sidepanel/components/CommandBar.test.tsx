import { describe, expect, it } from 'vitest';
import { nextSharedSearch, searchAnswerState, type SharedSearchState } from './CommandBar';

const result = (commandId: string) => ({ commandId, kind: 'command' as const });

describe('CommandBar search answers', () => {
  const empty: SharedSearchState = { key: '', results: [], sequence: 0 };

  it('lands an answer while its query is still the one typed', () => {
    const landed = nextSharedSearch(empty, { key: 'design', results: [result('a')], sequence: 1 }, 'design');

    expect(landed).toEqual({ key: 'design', results: [result('a')], sequence: 1 });
    expect(nextSharedSearch(empty, { key: 'desi', results: [result('a')], sequence: 1 }, 'design'))
      .toBe(empty);
  });

  it('keeps a later request\u2019s answer over an earlier one that arrives after it', () => {
    const later: SharedSearchState = { key: 'design', results: [result('b')], sequence: 2 };

    expect(nextSharedSearch(later, { key: 'design', results: [result('a')], sequence: 1 }, 'design'))
      .toBe(later);
    expect(nextSharedSearch(later, { key: 'design', results: [result('c')], sequence: 3 }, 'design'))
      .toEqual({ key: 'design', results: [result('c')], sequence: 3 });
  });

  it('keeps what a query had when an answer fails, and settles empty when it had nothing', () => {
    const shown: SharedSearchState = { key: 'design', results: [result('a')], sequence: 1 };

    expect(nextSharedSearch(shown, { key: 'design', sequence: 2 }, 'design')).toBe(shown);
    expect(nextSharedSearch(empty, { key: 'design', sequence: 2 }, 'design'))
      .toEqual({ key: 'design', results: [], sequence: 2 });
  });

  it('shows a remembered empty-query answer at once but holds Enter until the model answers', () => {
    expect(searchAnswerState('', '', false)).toEqual({ enterWaits: true, pending: false });
    expect(searchAnswerState('', '', true)).toEqual({ enterWaits: false, pending: false });
    expect(searchAnswerState('design', 'design', false)).toEqual({ enterWaits: true, pending: true });
    expect(searchAnswerState('designs', 'design', true)).toEqual({ enterWaits: true, pending: true });
  });
});