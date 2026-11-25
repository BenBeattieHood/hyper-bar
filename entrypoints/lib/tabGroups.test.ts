import { describe, expect, it } from 'vitest';
import {
  defaultHyperGroupColour,
  findHyperGroupForSpace,
  findHyperGroupsForSpace,
  hyperGroupOrdinal,
  hyperGroupTitle,
  isTabGroupColour,
  ownedTabGroupOrder,
  resolveHyperGroupForSpace,
  spaceBookmarkMovesForOrder,
  spaceOrderMatchingTabGroups,
  tabActivationCanSelectSpace,
  withHyperGroupLock,
} from './tabGroups';

describe('Hyper tab-group titles', () => {
  it('allows the browser active tab to select a collapsed space', () => {
    const tab = { active: true, groupId: 4, windowId: 7 };

    expect(tabActivationCanSelectSpace(
      tab,
      { collapsed: true, id: 4, windowId: 7 },
      7,
    )).toBe(true);
    expect(tabActivationCanSelectSpace(
      tab,
      { collapsed: false, id: 4, windowId: 7 },
      7,
    )).toBe(true);
  });

  it('assigns stable non-grey colours from a space id', () => {
    expect(defaultHyperGroupColour('space-one')).toBe(defaultHyperGroupColour('space-one'));
    expect(defaultHyperGroupColour('space-one')).not.toBe('grey');
  });

  it('accepts only the colours a browser tab group can wear', () => {
    expect(['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange']
      .every(isTabGroupColour)).toBe(true);
    expect(isTabGroupColour('magenta')).toBe(false);
    expect(isTabGroupColour(undefined)).toBe(false);
  });

  it('serializes group mutations through one lock per window', async () => {
    const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    const requestedNames: string[] = [];
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {
        locks: {
          request: async (name: string, operation: () => Promise<unknown>) => {
            requestedNames.push(name);
            return operation();
          },
        },
      },
    });
    try {
      await expect(withHyperGroupLock(12, async () => 'done')).resolves.toBe('done');
      await withHyperGroupLock(12, async () => undefined);
      expect(requestedNames).toEqual([
        'hyper-window-groups:12',
        'hyper-window-groups:12',
      ]);
    } finally {
      if (navigatorDescriptor) {
        Object.defineProperty(globalThis, 'navigator', navigatorDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, 'navigator');
      }
    }
  });

  it('runs group mutations directly when the Web Locks API is unavailable', async () => {
    const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {},
    });
    try {
      await expect(withHyperGroupLock(4, async () => 'unlocked')).resolves.toBe('unlocked');
    } finally {
      if (navigatorDescriptor) {
        Object.defineProperty(globalThis, 'navigator', navigatorDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, 'navigator');
      }
    }
  });

  it('formats the native title for a space index', () => {
    expect(hyperGroupTitle(0)).toBe('𝒉¹');
    expect(hyperGroupTitle(11)).toBe('𝒉¹²');
  });

  it('recognises styled and plain existing group titles', () => {
    expect(hyperGroupOrdinal('𝒉¹')).toBe(1);
    expect(hyperGroupOrdinal('h2')).toBe(2);
    expect(hyperGroupOrdinal(' H 12 ')).toBe(12);
    expect(hyperGroupOrdinal('work')).toBeUndefined();
  });

  it('rejects zero, partial, decimal, and unsafe ordinals', () => {
    expect(hyperGroupOrdinal('h0')).toBeUndefined();
    expect(hyperGroupOrdinal('h2 tabs')).toBeUndefined();
    expect(hyperGroupOrdinal('h1.5')).toBeUndefined();
    expect(hyperGroupOrdinal(`h${Number.MAX_SAFE_INTEGER}0`)).toBeUndefined();
  });

  it('prefers the current matching group when duplicate titles exist', () => {
    const groups = [
      { id: 4, title: 'h1' },
      { id: 7, title: '𝒉¹' },
      { id: 9, title: 'h2' },
    ];
    expect(findHyperGroupForSpace(groups, 0, [7, 4])).toEqual(groups[1]);
    expect(findHyperGroupForSpace(groups, 1)).toEqual(groups[2]);
  });

  it('collects every title variant for one space ordinal', () => {
    const groups = [
      { id: 2, title: 'h1' },
      { id: 3, title: '𝒉¹' },
      { id: 4, title: 'H 1' },
      { id: 5, title: 'h2' },
      { id: 6, title: 'Work' },
    ];
    expect(findHyperGroupsForSpace(groups, 0)).toEqual(groups.slice(0, 3));
  });

  it('keeps stable ownership when space ordinals change', () => {
    const groups = [
      { id: 4, title: 'h1' },
      { id: 7, title: 'h2' },
    ];

    expect(resolveHyperGroupForSpace(groups, 0, 7)).toEqual({
      group: groups[1],
      recovered: false,
    });
  });

  it('recovers by ordinal only when the owned group is unavailable', () => {
    const groups = [
      { id: 4, title: 'h1' },
      { id: 7, title: 'h2' },
    ];

    expect(resolveHyperGroupForSpace(groups, 0, 12)).toEqual({
      group: groups[0],
      recovered: true,
    });
  });

  it('does not recover a group claimed by another space', () => {
    const groups = [
      { id: 4, title: 'h1' },
      { id: 7, title: 'h1' },
    ];

    expect(resolveHyperGroupForSpace(groups, 0, undefined, [], new Set([4]))).toEqual({
      group: groups[1],
      recovered: true,
    });
    expect(resolveHyperGroupForSpace(groups.slice(0, 1), 0, undefined, [], new Set([4])))
      .toEqual({ group: undefined, recovered: true });
  });

  it('keeps an explicitly owned group even when another owner also claims it', () => {
    const groups = [{ id: 4, title: 'h2' }];

    expect(resolveHyperGroupForSpace(groups, 0, 4, [], new Set([4]))).toEqual({
      group: groups[0],
      recovered: false,
    });
  });
});

describe('space and tab-group ordering', () => {
  const tabs = [
    { groupId: 20, index: 7 },
    { groupId: 10, index: 4 },
    { groupId: 20, index: 6 },
    { groupId: -1, index: 0 },
    { groupId: 30, index: 2 },
  ];

  it('orders owned groups by their first live tab', () => {
    expect(ownedTabGroupOrder([10, 20, 30, 40], tabs)).toEqual([30, 10, 20]);
  });

  it('matches grouped spaces while preserving spaces without live groups', () => {
    const groups = new Map([
      ['one', 10],
      ['two', 20],
      ['three', 30],
    ]);

    expect(spaceOrderMatchingTabGroups(
      ['one', 'empty', 'two', 'three'],
      groups,
      tabs,
    )).toEqual(['three', 'empty', 'one', 'two']);
  });

  it('plans browser bookmark indices for multi-space reordering', () => {
    expect(spaceBookmarkMovesForOrder(
      ['one', 'two', 'three'],
      ['three', 'one', 'two'],
    )).toEqual([{ spaceId: 'three', index: 0 }]);
    expect(spaceBookmarkMovesForOrder(
      ['one', 'two', 'three'],
      ['two', 'three', 'one'],
    )).toEqual([
      { spaceId: 'two', index: 0 },
      { spaceId: 'three', index: 1 },
    ]);
  });
});