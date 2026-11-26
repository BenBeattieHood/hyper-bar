import { describe, expect, it } from 'vitest';
import {
  matchRestoredTabsToBackings,
  type UnclaimedBacking,
  type UnclaimedTab,
} from './restoredTabBackings';

function tab(tabId: number, index: number, url: string, extra: Partial<UnclaimedTab> = {}): UnclaimedTab {
  return { tabId, windowId: 1, index, url, ...extra };
}

function backing(
  backingId: string,
  tabIndex: number | undefined,
  url: string,
  extra: Partial<UnclaimedBacking> = {},
): UnclaimedBacking {
  return {
    backingId,
    backingToken: `token-${backingId}`,
    spaceId: 'space',
    windowId: 1,
    ...(tabIndex === undefined ? {} : { tabIndex }),
    url,
    ...extra,
  };
}

const openWindowIds = new Set([1, 2]);

function pairs(tabs: UnclaimedTab[], backings: UnclaimedBacking[]) {
  return matchRestoredTabsToBackings(tabs, backings, openWindowIds)
    .map(({ tabId, backing: { backingId } }) => [tabId, backingId])
    .sort(([left], [right]) => Number(left) - Number(right));
}

describe('matchRestoredTabsToBackings', () => {
  it('gives a tab restored before its redirect settled the backing of the page it reached', () => {
    expect(pairs(
      [tab(1, 0, 'https://a.test/one'), tab(2, 1, 'https://wiki.test/login')],
      [backing('a', 0, 'https://a.test/one'), backing('w', 1, 'https://wiki.test/page/42')],
    )).toEqual([[1, 'a'], [2, 'w']]);
  });

  it('settles every exact page before matching by site', () => {
    expect(pairs(
      [tab(1, 0, 'https://wiki.test/old'), tab(2, 1, 'https://wiki.test/new')],
      [backing('new', 0, 'https://wiki.test/new'), backing('other', 1, 'https://wiki.test/elsewhere')],
    )).toEqual([[1, 'other'], [2, 'new']]);
  });

  it('pairs tabs of the same site with the backings nearest their place', () => {
    expect(pairs(
      [tab(1, 2, 'https://wiki.test/x'), tab(2, 5, 'https://wiki.test/y')],
      [backing('far', 5, 'https://wiki.test/q'), backing('near', 2, 'https://wiki.test/p')],
    )).toEqual([[1, 'near'], [2, 'far']]);
  });

  it('falls back to the same place when the restored tab is on another site', () => {
    expect(pairs(
      [tab(1, 3, 'https://login.test/sso')],
      [backing('moved', 2, 'https://wiki.test/page'), backing('same-place', 3, 'https://teams.test/chat')],
    )).toEqual([[1, 'same-place']]);
  });

  it('leaves a tab on another site at another place unmatched', () => {
    expect(pairs(
      [tab(1, 3, 'https://new.test/')],
      [backing('b', 1, 'https://wiki.test/page')],
    )).toEqual([]);
  });

  it('never matches across windows', () => {
    expect(pairs(
      [tab(1, 0, 'https://a.test/', { windowId: 2 })],
      [backing('b', 0, 'https://a.test/')],
    )).toEqual([]);
  });

  it('lets a tab in any window take back a closed window\'s backing of its site', () => {
    expect(pairs(
      [tab(1, 0, 'https://wiki.test/login', { windowId: 2 })],
      [backing('parked', 0, 'https://wiki.test/page', { windowId: 9 })],
    )).toEqual([[1, 'parked']]);
  });

  it('prefers the window\'s own backing to a closed window\'s', () => {
    expect(pairs(
      [tab(1, 4, 'https://a.test/')],
      [backing('parked', 4, 'https://a.test/', { windowId: 9 }), backing('own', 0, 'https://a.test/')],
    )).toEqual([[1, 'own']]);
  });

  it('never gives a closed window\'s backing to a tab by place alone', () => {
    expect(pairs(
      [tab(1, 3, 'https://new.test/')],
      [backing('parked', 3, 'https://wiki.test/page', { windowId: 9 })],
    )).toEqual([]);
  });

  it('keeps a tab in a space group to that space', () => {
    expect(pairs(
      [tab(1, 0, 'https://a.test/', { spaceId: 'work' })],
      [backing('home', 0, 'https://a.test/'), backing('work', 4, 'https://a.test/', { spaceId: 'work' })],
    )).toEqual([[1, 'work']]);
  });

  it('matches each tab and each backing at most once', () => {
    const matches = matchRestoredTabsToBackings(
      [tab(1, 0, 'https://a.test/'), tab(2, 1, 'https://a.test/'), tab(3, 2, 'https://a.test/')],
      [backing('x', 0, 'https://a.test/'), backing('y', 1, 'https://a.test/')],
      openWindowIds,
    );
    expect(matches).toHaveLength(2);
    expect(new Set(matches.map(({ tabId }) => tabId)).size).toBe(2);
    expect(new Set(matches.map(({ backing: { backingId } }) => backingId)).size).toBe(2);
  });
});
