import { describe, expect, it } from 'vitest';
import { planLiveSpaceActivation } from './spaceActivationPlan';
import type { BrowserTab } from './bookmarks';
import type { TabOwnership } from './tabOwnership';

const SPACE = 'space-1';
const WINDOW = 4;

function tab(id: number, overrides: Partial<BrowserTab> = {}): BrowserTab {
  return { active: false, discarded: false, id, index: id, ...overrides } as BrowserTab;
}

function owned(backingId: string, overrides: Partial<TabOwnership> = {}): TabOwnership {
  return { backingId, spaceId: SPACE, windowId: WINDOW, ...overrides };
}

function plan(overrides: Partial<Parameters<typeof planLiveSpaceActivation>[0]> = {}) {
  return planLiveSpaceActivation({
    backingIds: ['backing-1', 'backing-2'],
    groupTabs: [tab(1), tab(2)],
    ownerships: { 1: owned('backing-1'), 2: owned('backing-2') },
    spaceId: SPACE,
    windowId: WINDOW,
    ...overrides,
  });
}

describe('planLiveSpaceActivation', () => {
  it('activates in place when every backing has exactly one live tab', () => {
    expect(plan()).toEqual({ tabId: 1 });
  });

  it('rebuilds when the group is empty', () => {
    expect(plan({ groupTabs: [] })).toBeUndefined();
  });

  it('rebuilds when the space has no backings', () => {
    expect(plan({ backingIds: [] })).toBeUndefined();
  });

  it('rebuilds when a live tab claims no backing', () => {
    expect(plan({ ownerships: { 1: owned('backing-1') } })).toBeUndefined();
  });

  it('rebuilds when a backing has no live tab', () => {
    expect(plan({ backingIds: ['backing-1', 'backing-2', 'backing-3'] })).toBeUndefined();
  });

  it('rebuilds when two tabs claim the same backing', () => {
    expect(plan({
      ownerships: { 1: owned('backing-1'), 2: owned('backing-1') },
    })).toBeUndefined();
  });

  it('rebuilds when a tab claims a backing the space does not own', () => {
    expect(plan({
      ownerships: { 1: owned('backing-1'), 2: owned('backing-elsewhere') },
    })).toBeUndefined();
  });

  it('ignores a claim belonging to another space', () => {
    expect(plan({
      ownerships: { 1: owned('backing-1'), 2: owned('backing-2', { spaceId: 'space-2' }) },
    })).toBeUndefined();
  });

  it('ignores a claim pinned to another window', () => {
    expect(plan({
      ownerships: { 1: owned('backing-1'), 2: owned('backing-2', { windowId: 99 }) },
    })).toBeUndefined();
  });

  it('accepts a claim that names no window', () => {
    expect(plan({
      ownerships: { 1: owned('backing-1'), 2: owned('backing-2', { windowId: undefined }) },
    })).toEqual({ tabId: 1 });
  });

  it('focuses the remembered tab rather than the first', () => {
    expect(plan({
      ownerships: {
        1: owned('backing-1'),
        2: owned('backing-2', { backingToken: 'token-2' }),
      },
      rememberedBackingToken: 'token-2',
    })).toEqual({ tabId: 2 });
  });

  it('rebuilds when the remembered token no longer matches a live tab', () => {
    expect(plan({ rememberedBackingToken: 'token-gone' })).toBeUndefined();
  });

  it('prefers a loaded tab over a discarded one', () => {
    expect(plan({ groupTabs: [tab(1, { discarded: true }), tab(2)] })).toEqual({ tabId: 2 });
  });

  it('does not prefer the active tab, so activation is deterministic', () => {
    expect(plan({ groupTabs: [tab(1), tab(2, { active: true })] })).toEqual({ tabId: 1 });
  });
});
