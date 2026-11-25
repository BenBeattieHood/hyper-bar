import { describe, expect, it } from 'vitest';
import type { BrowserTab } from './bookmarks';
import type { TabOwnership } from './tabOwnership';
import {
  activationSpaceId,
  classifyObservedTabs,
  tabDispositionsById,
  type BackingLocation,
  type TabDispositionInputs,
} from './tabDisposition';

const extensionOrigin = 'chrome-extension://hyper/';

function tab(id: number, overrides: Partial<BrowserTab> = {}): BrowserTab {
  return {
    id,
    incognito: false,
    url: 'https://example.com',
    windowId: 1,
    ...overrides,
  } as BrowserTab;
}

function inputs(overrides: Partial<TabDispositionInputs> = {}): TabDispositionInputs {
  return {
    backings: new Map<string, BackingLocation>(),
    extensionOrigin,
    knownSpaceIds: new Set(['space-1']),
    normalWindowIds: new Set([1]),
    ownerships: {} as Record<number, TabOwnership>,
    tabs: [],
    ...overrides,
  };
}

describe('observed tab disposition', () => {
  it('resolves exactly one disposition for every observed tab', () => {
    const tabs = [
      tab(1),
      tab(2, { incognito: true }),
      tab(3, { windowId: 99 }),
      { url: 'https://no-id.example', windowId: 1 } as BrowserTab,
    ];
    const entries = classifyObservedTabs(inputs({ tabs }));
    expect(entries).toHaveLength(tabs.length);
    expect(entries.map((entry) => entry.disposition.status)).toEqual([
      'loose',
      'ignored',
      'ignored',
      'ignored',
    ]);
  });

  it('leaves an unassigned tab loose instead of adopting it into a space', () => {
    const [entry] = classifyObservedTabs(inputs({ tabs: [tab(1)] }));
    expect(entry?.disposition).toEqual({ reason: 'unowned', status: 'loose' });
  });

  it('marks a tab Hyper could never back as loose rather than ignoring it', () => {
    const [entry] = classifyObservedTabs(inputs({
      tabs: [tab(1, { url: 'chrome://settings' })],
    }));
    expect(entry?.disposition).toEqual({ reason: 'unbackable-url', status: 'loose' });
  });

  it('owns a tab whose backing exists and reports the space from the tree', () => {
    const [entry] = classifyObservedTabs(inputs({
      backings: new Map([['backing-1', { spaceId: 'space-2', token: 'token-1' }]]),
      knownSpaceIds: new Set(['space-1', 'space-2']),
      ownerships: { 1: { backingId: 'backing-1', backingToken: 'token-1', spaceId: 'stale' } },
      tabs: [tab(1)],
    }));
    expect(entry?.disposition).toEqual({
      backingId: 'backing-1',
      spaceId: 'space-2',
      status: 'owned',
    });
  });

  it('gives a copied ownership to the original tab and looses every duplicate', () => {
    const dispositions = tabDispositionsById(classifyObservedTabs(inputs({
      backings: new Map([['backing-1', { spaceId: 'space-1' }]]),
      ownerships: {
        4: { backingId: 'backing-1', spaceId: 'space-1' },
        9: { backingId: 'backing-1', spaceId: 'space-1' },
      },
      tabs: [tab(9), tab(4)],
    })));
    expect(dispositions.get(4)).toMatchObject({ status: 'owned' });
    expect(dispositions.get(9)).toEqual({ reason: 'backing-claimed', status: 'loose' });
  });

  it('does not accept a recycled bookmark id as the original backing', () => {
    const [entry] = classifyObservedTabs(inputs({
      backings: new Map([['backing-1', { spaceId: 'space-1', token: 'fresh' }]]),
      ownerships: { 1: { backingId: 'backing-1', backingToken: 'original', spaceId: 'space-1' } },
      tabs: [tab(1)],
    }));
    expect(entry?.disposition).toEqual({
      backingId: 'backing-1',
      spaceId: 'space-1',
      status: 'pending-recovery',
    });
  });

  it('awaits recovery while the space survives and looses the tab once it does not', () => {
    const surviving = classifyObservedTabs(inputs({
      ownerships: { 1: { spaceId: 'space-1' } },
      tabs: [tab(1)],
    }));
    expect(surviving[0]?.disposition).toEqual({ spaceId: 'space-1', status: 'pending-recovery' });

    const removed = classifyObservedTabs(inputs({
      knownSpaceIds: new Set(),
      ownerships: { 1: { spaceId: 'space-1' } },
      tabs: [tab(1)],
    }));
    expect(removed[0]?.disposition).toEqual({ reason: 'space-removed', status: 'loose' });
  });

  it('holds a tab moved to another window in transit until routing reassigns it', () => {
    const backings = new Map([['backing-1', { spaceId: 'space-1' }]]);
    const moved = classifyObservedTabs(inputs({
      backings,
      normalWindowIds: new Set([1, 2]),
      ownerships: { 1: { backingId: 'backing-1', spaceId: 'space-1', windowId: 1 } },
      tabs: [tab(1, { windowId: 2 })],
    }));
    expect(moved[0]?.disposition).toEqual({
      backingId: 'backing-1',
      spaceId: 'space-1',
      status: 'in-transit',
    });
    expect(activationSpaceId(moved[0]!.disposition)).toBeUndefined();

    const routed = classifyObservedTabs(inputs({
      backings,
      normalWindowIds: new Set([1, 2]),
      ownerships: { 1: { backingId: 'backing-1', spaceId: 'space-1', windowId: 2 } },
      tabs: [tab(1, { windowId: 2 })],
    }));
    expect(activationSpaceId(routed[0]!.disposition)).toBe('space-1');
  });
});
