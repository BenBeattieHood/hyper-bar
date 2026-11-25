import { describe, expect, it } from 'vitest';
import type { BrowserTab } from './bookmarks';
import { testTab } from './testFixtures';
import { mergeNativeTabStatuses, tabStatusAnnouncementIsCurrent } from './tabStatus';

const tab = (status: BrowserTab['status']): BrowserTab =>
  testTab({ id: 1, status }) as BrowserTab;

describe('native tab statuses', () => {
  it('rejects a delayed loading announcement after the native tab completes', () => {
    expect(tabStatusAnnouncementIsCurrent('loading', 'complete')).toBe(false);
    expect(tabStatusAnnouncementIsCurrent('loading', 'loading')).toBe(true);
    expect(tabStatusAnnouncementIsCurrent('complete', 'complete')).toBe(true);
  });

  it('keeps an observed status authoritative over a stale queried one', () => {
    const queried = tab('complete');

    expect(mergeNativeTabStatuses([queried], new Map([[1, 'loading']])))
      .toEqual([{ ...queried, status: 'loading' }]);
    expect(mergeNativeTabStatuses([tab('loading')], new Map([[1, 'complete']])))
      .toEqual([queried]);
  });

  it('leaves a tab alone when nothing has been observed for it', () => {
    const queried = tab('complete');

    expect(mergeNativeTabStatuses([queried], new Map())[0]).toBe(queried);
  });
});
