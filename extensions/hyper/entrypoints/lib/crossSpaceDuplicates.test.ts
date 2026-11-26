import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  alreadyOpenText,
  createCrossSpaceDuplicates,
  offersSwitchOnFirstLoad,
  otherSpaceTab,
} from './crossSpaceDuplicates';
import { fakeStorageArea, testTab } from './testFixtures';
import type { TimedOffer } from './timedMessages';

const NEW_TAB_URL = 'chrome-extension://hyper/newtab.html';
const PAGE = 'https://example.test/page';
const PREVIOUS = 'https://example.test/previous';

type FakeTab = Browser.tabs.Tab & { id: number; url: string };

function tab(id: number, url: string, overrides: Partial<Browser.tabs.Tab> = {}): FakeTab {
  return { ...testTab({ id, url, ...overrides }), id, url };
}

function installBrowser(tabs: FakeTab[], spaceByTab: Record<number, string>) {
  let liveTabs = tabs.map((candidate) => ({ ...candidate }));
  const session = fakeStorageArea(Object.fromEntries(Object.entries(spaceByTab)
    .map(([tabId, spaceId]) => [`tabSpaceId:${tabId}`, { spaceId }])));
  const goBack = vi.fn(async () => undefined);
  const remove = vi.fn(async (tabId: number) => {
    liveTabs = liveTabs.filter((candidate) => candidate.id !== tabId);
  });
  const update = vi.fn(async (tabId: number, { active }: { active?: boolean }) => {
    const target = liveTabs.find((candidate) => candidate.id === tabId);
    liveTabs = liveTabs.map((candidate) => candidate.windowId === target?.windowId && active
      ? { ...candidate, active: candidate.id === tabId }
      : candidate);
  });
  const focusWindow = vi.fn(async () => undefined);
  vi.stubGlobal('browser', {
    storage: { session },
    tabs: {
      get: async (tabId: number) => {
        const found = liveTabs.find((candidate) => candidate.id === tabId);
        if (!found) throw new Error('No tab');
        return found;
      },
      goBack,
      query: async () => liveTabs,
      remove,
      update,
    },
    windows: { update: focusWindow },
  });
  return {
    focusWindow,
    goBack,
    navigate: (tabId: number, url: string) => {
      liveTabs = liveTabs.map((candidate) => candidate.id === tabId ? { ...candidate, url } : candidate);
    },
    remove,
    tabs: () => liveTabs,
    update,
  };
}

function crossSpace() {
  const offer = vi.fn((_windowId: number, _offer: TimedOffer) => 'message');
  const tabSpaceSwitch = { admit: vi.fn(), run: vi.fn(async () => undefined) };
  const duplicates = createCrossSpaceDuplicates({
    messages: { offer },
    newTabUrl: NEW_TAB_URL,
    queueMutation: (operation) => operation(),
    spaceTitle: (spaceId) => ({ home: 'Home', work: 'Work' })[spaceId],
    tabSpaceSwitch,
  });
  const lastOffer = () => offer.mock.calls.at(-1)?.[1] as TimedOffer;
  return { duplicates, lastOffer, offer, tabSpaceSwitch };
}

const navigation = (url: string, previousUrl?: string, newTabNavigation = false) => ({
  generation: 2,
  newTabNavigation,
  ...(previousUrl ? { previousUrl } : {}),
  url,
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('alreadyOpenText', () => {
  it('names the space, or says another space when it has no title', () => {
    expect(alreadyOpenText('Work')).toBe('Already open in Work. Switch instead?');
    expect(alreadyOpenText('  ')).toBe('Already open in another space. Switch instead?');
  });
});

describe('offersSwitchOnFirstLoad', () => {
  it('leaves out tabs Hyper opened, restored and duplicated', () => {
    expect(offersSwitchOnFirstLoad('hyper')).toBe(false);
    expect(offersSwitchOnFirstLoad('restored')).toBe(false);
    expect(offersSwitchOnFirstLoad('duplicate')).toBe(false);
    expect(offersSwitchOnFirstLoad('foreground-link')).toBe(true);
    expect(offersSwitchOnFirstLoad('background-link')).toBe(true);
    expect(offersSwitchOnFirstLoad('blank')).toBe(true);
    expect(offersSwitchOnFirstLoad('external')).toBe(true);
  });
});

describe('otherSpaceTab', () => {
  const source = { id: 10, incognito: false, spaceId: 'home', windowId: 1 };

  it('prefers a tab in the source window, then a shown one, then the oldest', () => {
    const tabs = [
      tab(10, PAGE, { active: true }),
      tab(20, PAGE, { active: true, windowId: 2 }),
      tab(21, `${PAGE}#section`),
      tab(19, PAGE, { windowId: 2 }),
    ];
    const ownerships = { 10: { spaceId: 'home' }, 19: { spaceId: 'work' }, 20: { spaceId: 'work' }, 21: { spaceId: 'work' } };
    expect(otherSpaceTab(source, PAGE, tabs, ownerships)?.tab.id).toBe(21);
    expect(otherSpaceTab(source, PAGE, tabs.filter((candidate) => candidate.id !== 21), ownerships)?.tab.id)
      .toBe(20);
  });

  it('offers nothing when the source space already shows the page in any window', () => {
    const tabs = [tab(10, PAGE), tab(11, PAGE, { windowId: 2 }), tab(12, PAGE)];
    expect(otherSpaceTab(source, PAGE, tabs, { 10: { spaceId: 'home' }, 11: { spaceId: 'home' }, 12: { spaceId: 'work' } }))
      .toBeUndefined();
  });

  it('ignores unowned tabs and tabs in another browsing context', () => {
    const tabs = [tab(10, PAGE), tab(11, PAGE), tab(12, PAGE, { incognito: true })];
    expect(otherSpaceTab(source, PAGE, tabs, { 10: { spaceId: 'home' }, 12: { spaceId: 'work' } })).toBeUndefined();
  });
});

describe('createCrossSpaceDuplicates', () => {
  it('offers to switch when a tab navigates to a page another space shows', async () => {
    installBrowser(
      [tab(10, PAGE, { active: true }), tab(20, `${PAGE}#top`, { title: 'The page' })],
      { 10: 'home', 20: 'work' },
    );
    const { duplicates, lastOffer, offer } = crossSpace();

    await expect(duplicates.offerSwitch(10, navigation(PAGE, PREVIOUS))).resolves.toBe(true);

    expect(offer).toHaveBeenCalledWith(1, expect.objectContaining({
      detail: 'The page',
      kind: 'opt-in',
      tabId: 10,
      text: 'Already open in Work. Switch instead?',
    }));
    expect(lastOffer().tone).toBeUndefined();
  });

  it('offers nothing for a same-space duplicate, an internal page, or a reload', async () => {
    installBrowser(
      [tab(10, PAGE), tab(11, PAGE), tab(20, PAGE), tab(30, 'chrome://settings/'), tab(31, 'chrome://settings/')],
      { 10: 'home', 11: 'home', 20: 'work', 30: 'home', 31: 'work' },
    );
    const { duplicates, offer } = crossSpace();

    await expect(duplicates.offerSwitch(10, navigation(PAGE, PREVIOUS))).resolves.toBe(false);
    await expect(duplicates.offerSwitch(30, navigation('chrome://settings/', PREVIOUS))).resolves.toBe(false);
    await expect(duplicates.offerSwitch(20, navigation(PAGE, `${PAGE}#old`))).resolves.toBe(false);
    expect(offer).not.toHaveBeenCalled();
  });

  it('offers nothing on the first page of a tab Hyper opened, but does on later navigations', async () => {
    const browserTabs = installBrowser([tab(10, NEW_TAB_URL), tab(20, PAGE)], { 10: 'home', 20: 'work' });
    const { duplicates, offer } = crossSpace();
    duplicates.noteNewTab(10, 'hyper');

    await expect(duplicates.offerSwitch(10, navigation(NEW_TAB_URL))).resolves.toBe(false);
    browserTabs.navigate(10, PAGE);
    await expect(duplicates.offerSwitch(10, navigation(PAGE, NEW_TAB_URL))).resolves.toBe(false);
    browserTabs.navigate(10, PREVIOUS);
    await duplicates.offerSwitch(10, navigation(PREVIOUS, PAGE));
    browserTabs.navigate(10, PAGE);
    await expect(duplicates.offerSwitch(10, navigation(PAGE, PREVIOUS))).resolves.toBe(true);
    expect(offer).toHaveBeenCalledTimes(1);
  });

  it('offers nothing when the tab has already left the page', async () => {
    installBrowser([tab(10, PREVIOUS), tab(20, PAGE)], { 10: 'home', 20: 'work' });
    const { duplicates, offer } = crossSpace();

    await expect(duplicates.offerSwitch(10, navigation(PAGE, PREVIOUS))).resolves.toBe(false);
    expect(offer).not.toHaveBeenCalled();
  });

  it('switches to the open tab and sends the navigated tab back without offering again', async () => {
    const browserTabs = installBrowser(
      [tab(10, PAGE, { active: true }), tab(20, PAGE)],
      { 10: 'home', 20: 'work' },
    );
    const { duplicates, lastOffer, tabSpaceSwitch } = crossSpace();
    await duplicates.offerSwitch(10, navigation(PAGE, PREVIOUS));

    await lastOffer().act(new Map());

    const client = { role: 'sidebar', windowId: 1 };
    expect(tabSpaceSwitch.admit).toHaveBeenCalledWith(20, client);
    expect(tabSpaceSwitch.run).toHaveBeenCalledWith(20, client);
    expect(browserTabs.tabs().find((candidate) => candidate.id === 20)?.active).toBe(true);
    expect(browserTabs.goBack).toHaveBeenCalledWith(10);
    expect(browserTabs.remove).not.toHaveBeenCalled();
    expect(duplicates.consumeReturn(10, PREVIOUS)).toBe(true);
    expect(duplicates.consumeReturn(10, PREVIOUS)).toBe(false);
  });

  it('closes a new tab the link opened instead of sending it back', async () => {
    const browserTabs = installBrowser(
      [tab(10, PAGE, { active: true }), tab(20, PAGE, { windowId: 2 })],
      { 10: 'home', 20: 'work' },
    );
    const { duplicates, lastOffer, tabSpaceSwitch } = crossSpace();
    duplicates.noteNewTab(10, 'foreground-link');
    await duplicates.offerSwitch(10, navigation(PAGE));

    await lastOffer().act(new Map());

    expect(tabSpaceSwitch.run).toHaveBeenCalledWith(20, { role: 'sidebar', windowId: 2 });
    expect(browserTabs.focusWindow).toHaveBeenCalledWith(2, { focused: true });
    expect(browserTabs.remove).toHaveBeenCalledWith(10);
    expect(browserTabs.goBack).not.toHaveBeenCalled();
  });

  it('treats a page reached from the new tab page as a new tab', async () => {
    const browserTabs = installBrowser([tab(10, PAGE), tab(20, PAGE)], { 10: 'home', 20: 'work' });
    const { duplicates, lastOffer } = crossSpace();
    await duplicates.offerSwitch(10, navigation(PAGE, NEW_TAB_URL));

    await lastOffer().act(new Map());

    expect(browserTabs.remove).toHaveBeenCalledWith(10);
  });

  it('still switches, but leaves the source alone, once the source has moved on', async () => {
    const browserTabs = installBrowser([tab(10, PAGE), tab(20, PAGE)], { 10: 'home', 20: 'work' });
    const { duplicates, lastOffer, tabSpaceSwitch } = crossSpace();
    await duplicates.offerSwitch(10, navigation(PAGE, PREVIOUS));
    browserTabs.navigate(10, 'https://example.test/elsewhere');

    await lastOffer().act(new Map());

    expect(tabSpaceSwitch.run).toHaveBeenCalled();
    expect(browserTabs.goBack).not.toHaveBeenCalled();
    expect(browserTabs.remove).not.toHaveBeenCalled();
  });

  it('refuses when the open tab has left the page, touching nothing', async () => {
    const browserTabs = installBrowser([tab(10, PAGE), tab(20, PAGE)], { 10: 'home', 20: 'work' });
    const { duplicates, lastOffer, tabSpaceSwitch } = crossSpace();
    await duplicates.offerSwitch(10, navigation(PAGE, PREVIOUS));
    browserTabs.navigate(20, 'https://example.test/elsewhere');

    await expect(lastOffer().act(new Map())).rejects.toThrow('That page is no longer open in Work.');

    expect(tabSpaceSwitch.run).not.toHaveBeenCalled();
    expect(browserTabs.goBack).not.toHaveBeenCalled();
  });

  it('forgets a closed tab', async () => {
    installBrowser([tab(10, PAGE), tab(20, PAGE)], { 10: 'home', 20: 'work' });
    const { duplicates, offer } = crossSpace();
    duplicates.noteNewTab(10, 'hyper');
    duplicates.forgetTab(10);

    await expect(duplicates.offerSwitch(10, navigation(PAGE, PREVIOUS))).resolves.toBe(true);
    expect(offer).toHaveBeenCalledTimes(1);
  });
});
