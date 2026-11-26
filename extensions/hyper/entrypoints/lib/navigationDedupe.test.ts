import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSerialAsyncRunner } from './async';
import {
  createNavigationDedupe,
  createNavigationUpdateQueue,
  FRAGMENT_UPDATE_INTERVAL_MS,
  mergeNavigationUpdates,
} from './navigationDedupe';
import { fakeStorageArea } from './testFixtures';
import type { TimedOffer } from './timedMessages';

const WINDOW_ID = 1;

interface FakeTab {
  active: boolean;
  id: number;
  incognito: boolean;
  index: number;
  url: string;
  windowId: number;
}

function installBrowser(tabs: FakeTab[], spaceByTab: Record<number, string>) {
  let liveTabs = tabs.map((tab) => ({ ...tab }));
  const session = fakeStorageArea(Object.fromEntries(Object.entries(spaceByTab)
    .map(([tabId, spaceId]) => [`tabSpaceId:${tabId}`, { spaceId, url: 'https://example.com/previous' }])));
  const remove = vi.fn(async (tabId: number) => {
    liveTabs = liveTabs.filter((tab) => tab.id !== tabId);
  });
  const goBack = vi.fn(async () => undefined);
  vi.stubGlobal('browser', {
    storage: { session },
    tabs: {
      get: async (tabId: number) => {
        const tab = liveTabs.find((candidate) => candidate.id === tabId);
        if (!tab) throw new Error('No tab');
        return tab;
      },
      goBack,
      query: async (query: { active?: boolean; windowId?: number }) => liveTabs.filter((tab) =>
        (query.windowId === undefined || tab.windowId === query.windowId) &&
        (query.active === undefined || tab.active === query.active)),
      remove,
      create: vi.fn(async (details: { active: boolean; index: number; url: string; windowId: number }) => {
        const tab = { ...details, id: 100, incognito: false };
        liveTabs = [...liveTabs.map((other) => ({ ...other, active: false })), tab];
        return tab;
      }),
      update: vi.fn(async (tabId: number, { active, url }: { active: boolean; url?: string }) => {
        liveTabs = liveTabs.map((tab) => tab.windowId === WINDOW_ID
          ? {
            ...tab,
            active: active ? tab.id === tabId : tab.active,
            ...(url && tab.id === tabId ? { url } : {}),
          }
          : tab);
      }),
    },
    windows: {
      get: async (windowId: number) => ({ focused: true, id: windowId }),
      update: async () => undefined,
    },
  });
  return { goBack, remove, tabs: () => liveTabs };
}

function dedupe() {
  const persistWindowActiveSpace = vi.fn(async () => undefined);
  const markIntentionalTab = vi.fn();
  const offer = vi.fn((_windowId: number, _offer: TimedOffer) => 'message');
  return {
    markIntentionalTab,
    navigationDedupe: createNavigationDedupe({
      generations: new Map([[10, 1], [11, 1]]),
      markIntentionalTab,
      messages: { offer },
      newTabUrl: 'chrome-extension://hyper/newtab.html',
      persistWindowActiveSpace,
      queueMutation: (operation) => operation(),
    }),
    offer,
    persistWindowActiveSpace,
  };
}

const existing: FakeTab = {
  active: false,
  id: 10,
  incognito: false,
  index: 0,
  url: 'https://example.com/page',
  windowId: WINDOW_ID,
};
const opened: FakeTab = { ...existing, active: true, id: 11, index: 1 };

describe('navigation dedupe', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('closes a new tab whose page its space already shows, and focuses the existing tab', async () => {
    const fake = installBrowser([existing, opened], { 10: 'work', 11: 'work' });
    const { navigationDedupe, persistWindowActiveSpace } = dedupe();

    await expect(navigationDedupe.closeNewlyGroupedDuplicate(11)).resolves.toBe(true);

    expect(fake.remove).toHaveBeenCalledWith(11);
    expect(fake.tabs()).toEqual([expect.objectContaining({ active: true, id: 10 })]);
    expect(persistWindowActiveSpace).toHaveBeenCalledWith(WINDOW_ID, 'work');
  });

  it('keeps a new tab when only another space shows the page', async () => {
    const fake = installBrowser([existing, opened], { 10: 'home', 11: 'work' });

    await expect(dedupe().navigationDedupe.closeNewlyGroupedDuplicate(11)).resolves.toBe(false);

    expect(fake.remove).not.toHaveBeenCalled();
    expect(fake.tabs().find((tab) => tab.id === 11)?.active).toBe(true);
  });

  it('sends a navigating tab back once the existing tab has focus', async () => {
    const fake = installBrowser([existing, opened], { 10: 'work', 11: 'work' });
    const { navigationDedupe } = dedupe();

    await expect(navigationDedupe.focusExistingSameSpaceNavigation(11, 'https://example.com/page', 1))
      .resolves.toBe(true);

    expect(fake.goBack).toHaveBeenCalledWith(11);
    expect(fake.tabs().find((tab) => tab.id === 10)?.active).toBe(true);
    expect(navigationDedupe.pendingBacks.get(11)).toMatchObject({ targetTabId: 10, targetSpaceId: 'work' });
    // Retires the pending close so its timer does nothing after the browser stub is gone.
    navigationDedupe.pendingBacks.delete(11);
  });

  it('ignores a navigation the tab has since moved on from', async () => {
    const fake = installBrowser([existing, opened], { 10: 'work', 11: 'work' });

    await expect(dedupe().navigationDedupe.focusExistingSameSpaceNavigation(11, 'https://example.com/page', 0))
      .resolves.toBe(false);

    expect(fake.goBack).not.toHaveBeenCalled();
  });

  it('offers to cancel closing a new tab, which reopens it where it was and keeps it', async () => {
    const fake = installBrowser([existing, opened], { 10: 'work', 11: 'work' });
    const { markIntentionalTab, navigationDedupe, offer } = dedupe();

    await navigationDedupe.closeNewlyGroupedDuplicate(11);

    const [[windowId, cancel]] = offer.mock.calls as [[number, TimedOffer]];
    expect(windowId).toBe(WINDOW_ID);
    expect(cancel).toMatchObject({ kind: 'opt-out', tabId: 10, text: 'Deduplicated tab' });
    await cancel.act(new Map());
    expect(fake.tabs().find((tab) => tab.id === 100))
      .toMatchObject({ active: true, index: 1, url: 'https://example.com/page', windowId: WINDOW_ID });
    expect(markIntentionalTab).toHaveBeenCalledWith(100);
    // The reopened copy is the user's choice, so it is not deduped again.
    await expect(navigationDedupe.closeNewlyGroupedDuplicate(100)).resolves.toBe(false);
  });

  it('offers to cancel sending a tab back, which lets it make its navigation after all', async () => {
    const fake = installBrowser([existing, opened], { 10: 'work', 11: 'work' });
    const { navigationDedupe, offer } = dedupe();

    await navigationDedupe.focusExistingSameSpaceNavigation(11, 'https://example.com/page', 1);
    const [[, cancel]] = offer.mock.calls as [[number, TimedOffer]];
    await cancel.act(new Map());

    expect(navigationDedupe.pendingBacks.has(11)).toBe(false);
    expect(browser.tabs.update).toHaveBeenLastCalledWith(11, { active: true, url: 'https://example.com/page' });
    expect(fake.tabs().find((tab) => tab.id === 11)?.active).toBe(true);
    await expect(navigationDedupe.focusExistingSameSpaceNavigation(11, 'https://example.com/page', 1))
      .resolves.toBe(false);
    // Showing another page ends the choice, so a later duplicate is deduped as usual.
    await expect(navigationDedupe.focusExistingSameSpaceNavigation(11, 'https://example.com/other', 1))
      .resolves.toBe(false);
    await expect(navigationDedupe.focusExistingSameSpaceNavigation(11, 'https://example.com/page', 1))
      .resolves.toBe(true);
    navigationDedupe.pendingBacks.delete(11);
  });

  it('folds a burst of navigations into one, from where it began to where it ended', () => {
    const fromNewTab = {
      generation: 1,
      newTabNavigation: true,
      previousUrl: 'chrome-extension://hyper/newtab.html',
      url: 'https://example.com/start',
    };
    const redirect = {
      generation: 2,
      newTabNavigation: false,
      previousUrl: 'https://example.com/start',
      url: 'https://example.com/page',
    };

    expect(mergeNavigationUpdates(fromNewTab, redirect)).toEqual({
      generation: 2,
      newTabNavigation: true,
      previousUrl: 'chrome-extension://hyper/newtab.html',
      url: 'https://example.com/page',
    });
    expect(mergeNavigationUpdates(redirect, fromNewTab)).toBe(redirect);
  });

  it('paces a tab that only rewrites its fragment, but never its real navigations', async () => {
    vi.useFakeTimers();
    try {
      const runs: string[] = [];
      const queue = createNavigationUpdateQueue(createSerialAsyncRunner(), async (_tabId, update) => {
        runs.push(update.url);
      });
      const page = 'https://example.com/page';
      const update = (generation: number, previousUrl: string, url: string) => ({
        generation,
        newTabNavigation: false,
        previousUrl,
        url,
      });

      await queue(1, update(1, page, `${page}#1`));
      const paced = queue(1, update(2, `${page}#1`, `${page}#2`));
      void queue(1, update(3, `${page}#2`, `${page}#3`));
      await queue(1, update(4, `${page}#3`, 'https://example.com/next'));
      expect(runs).toEqual([`${page}#1`, 'https://example.com/next']);

      await vi.advanceTimersByTimeAsync(FRAGMENT_UPDATE_INTERVAL_MS);
      await paced;
      expect(runs).toEqual([`${page}#1`, 'https://example.com/next', `${page}#3`]);
    } finally {
      vi.useRealTimers();
    }
  });
});
