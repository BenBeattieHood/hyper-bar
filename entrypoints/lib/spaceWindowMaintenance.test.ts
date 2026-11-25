import { afterEach, describe, expect, it, vi } from 'vitest';
import { adoptGroup, emptyGroupOwnershipRegistry, type GroupOwnership } from './groupOwnership';
import type { HyperModelSnapshot, HyperModelStore } from './model';
import {
  createSpaceWindowMaintenance,
  defaultWindowSpaceId,
  groupColourSignature,
  planWindowSpaces,
} from './spaceWindowMaintenance';
import { fakeStorageArea, testTab } from './testFixtures';
import { activeSpaceKey } from './windowState';

const WINDOW_ID = 1;
const spaces = [{ id: 'work' }, { id: 'home' }];
const normalWindow = (id: number) => ({ id, incognito: false, type: 'normal' });

function snapshot(overrides: {
  activeSpaceIds?: Record<number, string>;
  commands?: Record<string, { phase: string; targets: string[] }>;
  groups?: Array<{ color: string; id: number; windowId: number }>;
  ownerships?: GroupOwnership[];
  spaces?: Array<{ id: string }>;
  windows?: Array<{ id: number; incognito: boolean; type: string }>;
} = {}): HyperModelSnapshot {
  return {
    browser: {
      tabGroups: overrides.groups ?? [],
      windows: overrides.windows ?? [normalWindow(WINDOW_ID)],
    },
    commands: overrides.commands ?? {},
    hyper: { spaces: overrides.spaces ?? spaces },
    runtime: {
      activeSpaceIds: overrides.activeSpaceIds ?? {},
      groupOwnership: (overrides.ownerships ?? []).reduce(adoptGroup, emptyGroupOwnershipRegistry),
    },
  } as unknown as HyperModelSnapshot;
}

describe('planWindowSpaces', () => {
  it('gives a window with no space one, and leaves a window showing a space alone', () => {
    const plan = planWindowSpaces(snapshot({
      activeSpaceIds: { 2: 'home' },
      windows: [
        normalWindow(1),
        normalWindow(2),
        { id: 3, incognito: true, type: 'normal' },
        { id: 4, incognito: false, type: 'popup' },
      ],
    }), new Map());

    expect(plan.needed).toEqual([1]);
    expect(plan.windowSpaces).toEqual(new Map([[2, 'home']]));
  });

  it('shows the new space of a window whose space was removed', () => {
    const plan = planWindowSpaces(snapshot({ activeSpaceIds: { 1: 'home' } }), new Map([[1, 'gone']]));

    expect(plan.needed).toEqual([1]);
  });

  it('leaves a window to a command still changing it or its space', () => {
    const pending = (target: string) => ({ command: { phase: 'pending', targets: [target] } });

    expect(planWindowSpaces(snapshot({ commands: pending('window:1') }), new Map()).needed).toEqual([]);
    expect(planWindowSpaces(
      snapshot({ activeSpaceIds: { 1: 'home' }, commands: pending('space:gone') }),
      new Map([[1, 'gone']]),
    ).needed).toEqual([]);
  });

  it('offers a window a space only once, and waits for spaces to exist', () => {
    expect(planWindowSpaces(snapshot(), new Map([[1, null]])).needed).toEqual([]);
    expect(planWindowSpaces(snapshot({ spaces: [] }), new Map()).needed).toEqual([]);
  });
});

describe('groupColourSignature', () => {
  const owned = { groupId: 10, spaceId: 'work', windowId: WINDOW_ID };
  const group = { color: 'blue', id: 10, windowId: WINDOW_ID };
  const base = groupColourSignature(snapshot({ groups: [group], ownerships: [owned] }));

  it('changes with the spaces, a group colour or window, or group ownership', () => {
    expect(groupColourSignature(snapshot({
      groups: [group],
      ownerships: [owned],
      spaces: [{ id: 'work' }],
    }))).not.toBe(base);
    expect(groupColourSignature(snapshot({ groups: [{ ...group, color: 'pink' }], ownerships: [owned] })))
      .not.toBe(base);
    expect(groupColourSignature(snapshot({ groups: [{ ...group, windowId: 2 }], ownerships: [owned] })))
      .not.toBe(base);
    expect(groupColourSignature(snapshot({ groups: [group] }))).not.toBe(base);
  });

  it('ignores changes the colour pass does not read', () => {
    expect(groupColourSignature(snapshot({
      activeSpaceIds: { 1: 'home' },
      groups: [group],
      ownerships: [owned],
    }))).toBe(base);
  });
});

describe('defaultWindowSpaceId', () => {
  it("prefers the active tab's space, then the first tab's, then the first space", () => {
    const tabs = [testTab({ id: 1, index: 0 }), testTab({ active: true, id: 2, index: 1 })];

    expect(defaultWindowSpaceId(tabs, { 1: { spaceId: 'work' }, 2: { spaceId: 'home' } }, spaces))
      .toBe('home');
    expect(defaultWindowSpaceId(tabs, { 1: { spaceId: 'home' } }, spaces)).toBe('home');
    expect(defaultWindowSpaceId(tabs, {}, spaces)).toBe('work');
  });

  it('ignores a tab still arriving from another window', () => {
    const tabs = [testTab({ active: true, id: 1, windowId: WINDOW_ID })];

    expect(defaultWindowSpaceId(tabs, { 1: { spaceId: 'home', windowId: 9 } }, spaces)).toBe('work');
  });
});

describe('space window maintenance', () => {
  afterEach(() => vi.unstubAllGlobals());

  function harness(initial: HyperModelSnapshot, colourResults: boolean[] = []) {
    const session = fakeStorageArea();
    vi.stubGlobal('browser', {
      runtime: { getURL: () => 'chrome-extension://hyper/' },
      storage: { session },
      tabs: {
        query: async () => [
          testTab({ active: true, id: 1, index: 0, url: 'https://example.com/' }),
          testTab({ id: 2, index: 1, pinned: true, url: 'https://mail.example.com/' }),
          testTab({ id: 3, index: 2, url: 'chrome-extension://hyper/sidepanel.html' }),
          testTab({ id: 4, index: 3, url: 'about:blank' }),
        ],
      },
      windows: { get: async (id: number) => normalWindow(id) },
    });
    let current = initial;
    let commit: (() => void) | undefined;
    const calls: string[] = [];
    const maintenance = createSpaceWindowMaintenance({
      browserSettled: async () => undefined,
      persistWindowActiveSpace: async (windowId, spaceId) => {
        session.values.set(activeSpaceKey(windowId), spaceId);
        calls.push(`persist ${spaceId}`);
      },
      queueMutation: (operation) => operation(),
      reconcileGroupColours: async () => {
        calls.push('colours');
        return colourResults.shift() ?? true;
      },
      reconcileGroupOrder: async (ordered) => {
        calls.push(`order ${ordered.map((space) => space.id).join(',')}`);
      },
      routeTab: async (tabId) => {
        calls.push(`route ${tabId}`);
      },
      showSpace: async (spaceId) => {
        calls.push(`show ${spaceId}`);
      },
      store: {
        get: () => current,
        sub: (_atom: unknown, listener: () => void) => {
          commit = listener;
          return () => undefined;
        },
      } as unknown as HyperModelStore,
    });
    const update = (next: HyperModelSnapshot) => {
      current = next;
      commit?.();
    };
    return { calls, maintenance, session, update };
  }

  it('gives a window with no space one, routing the tabs it opened meanwhile, once started', async () => {
    const { calls, maintenance, update } = harness(snapshot());
    update(snapshot());
    expect(calls).toEqual([]);

    maintenance.start();

    await vi.waitFor(() =>
      expect(calls).toEqual(['order work,home', 'colours', 'persist work', 'route 1', 'show work']));
  });

  it('leaves a window showing a space, then shows its replacement when the space is removed', async () => {
    const { calls, maintenance, session, update } = harness(snapshot({ activeSpaceIds: { 1: 'home' } }));
    maintenance.start();
    await vi.waitFor(() => expect(calls).toEqual(['order work,home', 'colours']));

    session.values.set(activeSpaceKey(WINDOW_ID), 'work');
    update(snapshot({ activeSpaceIds: { 1: 'work' }, spaces: [{ id: 'work' }] }));

    await vi.waitFor(() =>
      expect(calls).toEqual(['order work,home', 'colours', 'order work', 'colours', 'show work']));
  });

  it('recolours groups when a group colour changes, and only then', async () => {
    const owned = [{ groupId: 10, spaceId: 'work', windowId: WINDOW_ID }];
    const group = { color: 'blue', id: 10, windowId: WINDOW_ID };
    const shown = { activeSpaceIds: { 1: 'work' }, groups: [group], ownerships: owned };
    const { calls, maintenance, update } = harness(snapshot(shown));
    maintenance.start();
    await vi.waitFor(() => expect(calls).toEqual(['order work,home', 'colours']));

    update(snapshot(shown));
    update(snapshot({ ...shown, groups: [{ ...group, color: 'pink' }] }));
    await vi.waitFor(() => expect(calls).toEqual(['order work,home', 'colours', 'colours']));
  });

  it('runs the colour pass again on the next change after the browser refused a recolour', async () => {
    const shown = snapshot({ activeSpaceIds: { 1: 'work' } });
    const { calls, maintenance, update } = harness(shown, [false]);
    maintenance.start();
    await vi.waitFor(() => expect(calls).toEqual(['order work,home', 'colours']));

    update(snapshot({ activeSpaceIds: { 1: 'work' } }));

    await vi.waitFor(() => expect(calls).toEqual(['order work,home', 'colours', 'colours']));
  });
});
