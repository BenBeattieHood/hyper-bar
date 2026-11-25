import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HyperModelSnapshot } from './model';
import type { TabBookmarkLink, TabName } from './tabBookmarkLink';
import { createTabTitlePresenter, tabTitleUpdates } from './tabTitlePresenter';
import { testTab } from './testFixtures';

const page = (title: string, url = 'https://example.com/page') => testTab({ id: 1, title, url });
const bookmarkName: TabName = { drifted: true, source: 'bookmark', title: 'Team docs' };
const recorded: TabBookmarkLink = { bookmarkId: 'docs', drifted: true, persisted: true };

describe('tab title updates', () => {
  it('shows a recorded bookmark name, marked once the tab drifts', () => {
    expect(tabTitleUpdates([page('Docs')], new Map([[1, bookmarkName]]), new Map([[1, recorded]]), new Map()))
      .toEqual([{ kind: 'name', tabId: 1, title: 'Team docs*' }]);
  });

  it('waits for a bookmark link to be recorded before showing its name', () => {
    expect(tabTitleUpdates(
      [page('Docs')],
      new Map([[1, bookmarkName]]),
      new Map([[1, { ...recorded, persisted: false }]]),
      new Map(),
    )).toEqual([]);
  });

  it('leaves a tab that already shows its name alone', () => {
    expect(tabTitleUpdates([page('Team docs*')], new Map([[1, bookmarkName]]), new Map([[1, recorded]]), new Map()))
      .toEqual([]);
  });

  it('restores the page title once a name it applied no longer applies', () => {
    expect(tabTitleUpdates(
      [page('Team docs*')],
      new Map(),
      new Map(),
      new Map([[1, 'Team docs*']]),
      new Map([[1, 'Docs page']]),
    )).toEqual([{ kind: 'restore', tabId: 1, title: 'Docs page' }]);
    // Until the backing keeps the page's title, the name stays.
    expect(tabTitleUpdates([page('Team docs*')], new Map(), new Map(), new Map([[1, 'Team docs*']])))
      .toEqual([]);
    expect(tabTitleUpdates([page('New page')], new Map(), new Map(), new Map([[1, 'Team docs*']])))
      .toEqual([]);
  });

  it('never scripts pages that are not on the web', () => {
    expect(tabTitleUpdates(
      [page('Settings', 'chrome://settings/')],
      new Map([[1, { drifted: false, source: 'tab', title: 'Mine' }]]),
      new Map(),
      new Map(),
    )).toEqual([]);
  });
});

describe('tab title presenter', () => {
  afterEach(() => vi.useRealTimers());

  const snapshot = (title: string) => ({
    browser: { tabs: [page(title)] },
    derived: {
      tabBookmarkLinks: new Map(),
      tabPageTitles: new Map(),
      tabNames: new Map([[1, { drifted: false, source: 'tab', title: 'Mine' }]]),
    },
  }) as unknown as HyperModelSnapshot;

  it('re-applies a name the page overwrote, at most once a second', async () => {
    vi.useFakeTimers();
    const setDocumentTitle = vi.fn(async () => true);
    const presenter = createTabTitlePresenter({ setDocumentTitle });

    presenter.present(snapshot('Page'));
    await vi.advanceTimersByTimeAsync(0);
    presenter.present(snapshot('Page again'));
    await vi.advanceTimersByTimeAsync(0);
    expect(setDocumentTitle).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(setDocumentTitle).toHaveBeenCalledTimes(2);
    expect(setDocumentTitle).toHaveBeenLastCalledWith(1, 'Mine');
  });

  it('stops trying a page it cannot script until the tab navigates', async () => {
    vi.useFakeTimers();
    const setDocumentTitle = vi.fn(async () => false);
    const presenter = createTabTitlePresenter({ setDocumentTitle });

    presenter.present(snapshot('Page'));
    await vi.advanceTimersByTimeAsync(2_000);
    presenter.present(snapshot('Page'));
    await vi.advanceTimersByTimeAsync(2_000);

    expect(setDocumentTitle).toHaveBeenCalledTimes(1);
  });
});
