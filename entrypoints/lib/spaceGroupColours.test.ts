import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BookmarkNode } from './bookmarks';
import { liveSpaceColours } from './groupOwnership';
import {
  SYNCED_GROUP_COLOURS_KEY,
  createSpaceGroupColours,
  newSpaceGroupColour,
  planSpaceColourSync,
  removeStoredSpaceColours,
} from './spaceGroupColours';
import { spaceGroupKey } from './spaceGroupStore';
import { defaultHyperGroupColour } from './tabGroups';
import { hyperBookmarkTree, testFolder } from './testBookmarkTree';
import { fakeStorageArea } from './testFixtures';

const own = (spaceId: string, groupId: number, windowId = 1) => ({ groupId, spaceId, windowId });
const group = (id: number, color: string, windowId = 1) => ({ color, id, windowId });

describe('liveSpaceColours', () => {
  const groups = [group(10, 'pink', 1), group(20, 'blue', 2), group(30, 'cyan', 2)];
  const ownerships = [own('work', 10, 1), own('work', 20, 2), own('home', 30, 2)];

  it('colours a space by its group in the window first, else by its group in another window', () => {
    expect(liveSpaceColours(groups, ownerships, 2)).toEqual(new Map([['work', 'blue'], ['home', 'cyan']]));
    expect(liveSpaceColours(groups, ownerships, 1)).toEqual(new Map([['work', 'pink'], ['home', 'cyan']]));
  });

  it('gives a space with no open group no colour', () => {
    expect(liveSpaceColours(groups, [own('work', 10, 1), own('gone', 99, 1)]).has('gone')).toBe(false);
    expect(liveSpaceColours([], ownerships).size).toBe(0);
  });
});

describe('planSpaceColourSync', () => {
  it('carries a colour the user gave a group to the space’s group in every other window', () => {
    const plan = planSpaceColourSync({
      groups: [group(10, 'pink', 1), group(20, 'blue', 2)],
      ownerships: [own('work', 10, 1), own('work', 20, 2)],
      spaces: [{ id: 'work' }],
      synced: { 10: 'blue', 20: 'blue' },
    });

    expect(plan.updates).toEqual([{ colour: 'pink', groupId: 20 }]);
    expect(plan.synced).toEqual({ 10: 'pink', 20: 'pink' });
  });

  it('gives an adopted group the colour the space’s known groups wear', () => {
    const plan = planSpaceColourSync({
      groups: [group(30, 'grey', 1), group(10, 'purple', 2)],
      ownerships: [own('work', 30, 1), own('work', 10, 2)],
      spaces: [{ id: 'work' }],
      synced: { 10: 'purple' },
    });

    expect(plan.updates).toEqual([{ colour: 'purple', groupId: 30 }]);
  });

  it('keeps the colour the first group wears when Hyper knows none, in every window', () => {
    const plan = planSpaceColourSync({
      groups: [group(10, 'cyan', 1), group(20, 'red', 2)],
      ownerships: [own('work', 10, 1), own('work', 20, 2)],
      spaces: [{ id: 'work' }],
      synced: {},
    });

    expect(plan.updates).toEqual([{ colour: 'cyan', groupId: 20 }]);
    expect(plan.synced).toEqual({ 10: 'cyan', 20: 'cyan' });
  });

  it('leaves a space with no group and a group with no space alone, and forgets groups that went', () => {
    const plan = planSpaceColourSync({
      groups: [group(10, 'cyan'), group(11, 'red')],
      ownerships: [own('gone', 11)],
      spaces: [{ id: 'work' }],
      synced: { 10: 'cyan', 99: 'blue' },
    });

    expect(plan).toEqual({ synced: {}, updates: [] });
  });

  it('settles: a lone group keeps whatever colour it wears', () => {
    const plan = planSpaceColourSync({
      groups: [group(10, 'orange')],
      ownerships: [own('work', 10)],
      spaces: [{ id: 'work' }],
      synced: { 10: 'blue' },
    });

    expect(plan).toEqual({ synced: { 10: 'orange' }, updates: [] });
  });
});

function spacesTree(titles: Record<string, string>): BookmarkNode[] {
  return hyperBookmarkTree(Object.entries(titles).map(([id, title]) => testFolder(id, title, 'spaces')));
}

function installBrowser(options: {
  groups: Array<{ color: string; id: number; windowId: number }>;
  session?: Record<string, unknown>;
  titles: Record<string, string>;
}) {
  const titles = { ...options.titles };
  const groups = options.groups.map((entry) => ({ ...entry }));
  const sessionArea = fakeStorageArea(options.session);
  let refuse = false;
  const update = vi.fn(async (groupId: number, { color }: { color: string }) => {
    if (refuse) throw new Error('Tabs cannot be edited right now (user may be dragging a tab).');
    groups.find((candidate) => candidate.id === groupId)!.color = color;
  });
  const bookmarkUpdate = vi.fn(async (id: string, { title }: { title: string }) => {
    titles[id] = title;
  });
  vi.stubGlobal('browser', {
    bookmarks: {
      get: async (id: string) => titles[id] === undefined ? [] : [{ id, title: titles[id] }],
      getTree: async () => spacesTree(titles),
      update: bookmarkUpdate,
    },
    storage: { session: sessionArea },
    tabGroups: { query: async () => groups.map((entry) => ({ ...entry })), update },
  });
  return {
    bookmarkUpdate,
    colours: () => Object.fromEntries(groups.map((entry) => [entry.id, entry.color])),
    recolour: (groupId: number, color: string) => {
      groups.find((candidate) => candidate.id === groupId)!.color = color;
    },
    refuse: (value: boolean) => { refuse = value; },
    session: sessionArea.values,
    sessionSet: sessionArea.set,
    titles,
    update,
  };
}

function controller() {
  const dependencies = {
    beginProgrammaticGroupUpdate: vi.fn(),
    endProgrammaticGroupUpdate: vi.fn(async () => undefined),
  };
  return { colours: createSpaceGroupColours(dependencies), dependencies };
}

afterEach(() => vi.unstubAllGlobals());

describe('space group colours', () => {
  const twoWindows = {
    groups: [group(10, 'blue', 1), group(20, 'blue', 2)],
    session: { [spaceGroupKey('work', 1)]: 10, [spaceGroupKey('work', 2)]: 20 },
    titles: { work: 'Work' },
  };

  it('carries a colour picked in the browser to the space’s group in every other window', async () => {
    const browserState = installBrowser(twoWindows);
    const { colours, dependencies } = controller();
    await colours.reconcileAll();

    browserState.recolour(10, 'pink');
    await expect(colours.reconcileAll()).resolves.toBe(true);

    expect(browserState.colours()).toEqual({ 10: 'pink', 20: 'pink' });
    expect(dependencies.beginProgrammaticGroupUpdate).toHaveBeenCalledWith(20);
    expect(dependencies.endProgrammaticGroupUpdate).toHaveBeenCalledWith(20);
    expect(browserState.bookmarkUpdate).not.toHaveBeenCalled();
  });

  it('settles after its own recolours instead of reading them back as choices', async () => {
    const browserState = installBrowser(twoWindows);
    const { colours } = controller();
    await colours.reconcileAll();
    browserState.recolour(20, 'green');
    await colours.reconcileAll();
    browserState.update.mockClear();
    browserState.sessionSet.mockClear();

    await colours.reconcileAll();

    expect(browserState.colours()).toEqual({ 10: 'green', 20: 'green' });
    expect(browserState.update).not.toHaveBeenCalled();
    expect(browserState.sessionSet).not.toHaveBeenCalled();
  });

  it('keeps the colour the browser restored a group with after a restart', async () => {
    const browserState = installBrowser({
      groups: [group(70, 'grey', 5)],
      session: { [spaceGroupKey('work', 5)]: 70 },
      titles: { work: 'Work {"hyper":{"colour":"purple"}}' },
    });
    const { colours } = controller();

    await colours.reconcileAll();

    expect(browserState.colours()).toEqual({ 70: 'grey' });
    expect(browserState.update).not.toHaveBeenCalled();
  });

  it('does not read a recolour the browser refused as the user choosing the old colour', async () => {
    const browserState = installBrowser(twoWindows);
    const { colours } = controller();
    await colours.reconcileAll();
    browserState.recolour(10, 'pink');
    browserState.refuse(true);

    await expect(colours.reconcileAll()).resolves.toBe(false);
    expect(browserState.colours()).toEqual({ 10: 'pink', 20: 'blue' });
    expect(browserState.session.get(SYNCED_GROUP_COLOURS_KEY)).toEqual({ 10: 'pink', 20: 'blue' });

    browserState.refuse(false);
    await expect(colours.reconcileAll()).resolves.toBe(true);
    expect(browserState.colours()).toEqual({ 10: 'pink', 20: 'pink' });
  });

  it('gives a new group the colour the space wears in another window, else one from its id', async () => {
    installBrowser({
      groups: [group(10, 'cyan', 1)],
      session: { [spaceGroupKey('work', 1)]: 10 },
      titles: { home: 'Home', work: 'Work' },
    });

    await expect(newSpaceGroupColour('work', 2)).resolves.toBe('cyan');
    await expect(newSpaceGroupColour('home', 2)).resolves.toBe(defaultHyperGroupColour('home'));
  });

  it('removes the colour earlier versions stored on space folders and leaves other titles alone', async () => {
    const browserState = installBrowser({
      groups: [],
      titles: {
        home: 'Home',
        work: 'Work {"hyper":{"archived":true,"colour":"purple"}}',
      },
    });

    await removeStoredSpaceColours();

    expect(browserState.titles).toEqual({ home: 'Home', work: 'Work {"hyper":{"archived":true}}' });
    expect(browserState.bookmarkUpdate).toHaveBeenCalledTimes(1);
  });
});
