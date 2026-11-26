import { describe, expect, it } from 'vitest';
import {
  adoptGroup,
  emptyGroupOwnershipRegistry,
  fromSpaceGroupIdsByWindow,
  groupIdForSpace,
  groupIdsForWindow,
  migrateGroup,
  ownershipForGroup,
  resolveGroupOwnership,
  toSpaceGroupIdsByWindow,
  unadoptGroup,
} from './groupOwnership';

describe('group ownership resolution', () => {
  it('expires a mapping whose group no longer exists', () => {
    const { conflicts, registry } = resolveGroupOwnership(
      [{ groupId: 5, spaceId: 'space-1', windowId: 1 }],
      new Map(),
    );
    expect(conflicts).toEqual([]);
    expect(registry.byGroup.size).toBe(0);
  });

  it('follows a group that moved to another window', () => {
    const { registry } = resolveGroupOwnership(
      [{ groupId: 5, spaceId: 'space-1', windowId: 1 }],
      new Map([[5, 2]]),
    );
    expect(groupIdForSpace(registry, 2, 'space-1')).toBe(5);
    expect(groupIdForSpace(registry, 1, 'space-1')).toBeUndefined();
  });

  it('drops both claims when two spaces name the same group', () => {
    const { conflicts, registry } = resolveGroupOwnership([
      { groupId: 5, spaceId: 'space-1', windowId: 1 },
      { groupId: 5, spaceId: 'space-2', windowId: 1 },
    ], new Map([[5, 1]]));
    expect(registry.byGroup.size).toBe(0);
    expect(conflicts).toEqual([{
      claims: [
        { groupId: 5, spaceId: 'space-1', windowId: 1 },
        { groupId: 5, spaceId: 'space-2', windowId: 1 },
      ],
      groupId: 5,
      kind: 'group-claimed-twice',
    }]);
  });

  it('drops both claims when one space names two groups in a window', () => {
    const { conflicts, registry } = resolveGroupOwnership([
      { groupId: 5, spaceId: 'space-1', windowId: 1 },
      { groupId: 6, spaceId: 'space-1', windowId: 1 },
    ], new Map([[5, 1], [6, 1]]));
    expect(registry.byGroup.size).toBe(0);
    expect(conflicts).toEqual([{
      groupIds: [5, 6],
      kind: 'space-mapped-twice',
      spaceId: 'space-1',
      windowId: 1,
    }]);
  });

  it('keeps the same space mapped in two different windows', () => {
    const { conflicts, registry } = resolveGroupOwnership([
      { groupId: 5, spaceId: 'space-1', windowId: 1 },
      { groupId: 6, spaceId: 'space-1', windowId: 2 },
    ], new Map([[5, 1], [6, 2]]));
    expect(conflicts).toEqual([]);
    expect(groupIdsForWindow(registry, 1)).toEqual({ 'space-1': 5 });
    expect(groupIdsForWindow(registry, 2)).toEqual({ 'space-1': 6 });
  });
});

describe('group adoption', () => {
  it('displaces both the previous group and the previous space', () => {
    let registry = adoptGroup(emptyGroupOwnershipRegistry, {
      groupId: 5,
      spaceId: 'space-1',
      windowId: 1,
    });
    registry = adoptGroup(registry, { groupId: 5, spaceId: 'space-2', windowId: 1 });
    expect(ownershipForGroup(registry, 5)?.spaceId).toBe('space-2');
    expect(groupIdForSpace(registry, 1, 'space-1')).toBeUndefined();

    registry = adoptGroup(registry, { groupId: 6, spaceId: 'space-2', windowId: 1 });
    expect(registry.byGroup.has(5)).toBe(false);
    expect(groupIdForSpace(registry, 1, 'space-2')).toBe(6);
  });

  it('unadopts by group id', () => {
    const registry = unadoptGroup(
      adoptGroup(emptyGroupOwnershipRegistry, { groupId: 5, spaceId: 'space-1', windowId: 1 }),
      5,
    );
    expect(registry.byGroup.size).toBe(0);
    expect(registry.bySpace.size).toBe(0);
  });
});

describe('group migration', () => {
  it('carries the space onto the reissued group id in the new window', () => {
    const registry = migrateGroup(
      adoptGroup(emptyGroupOwnershipRegistry, { groupId: 5, spaceId: 'space-1', windowId: 1 }),
      5,
      { groupId: 8, windowId: 2 },
    );
    expect(groupIdForSpace(registry, 2, 'space-1')).toBe(8);
    expect(registry.byGroup.has(5)).toBe(false);
  });

  it('refuses to displace a group the destination window already owns', () => {
    let registry = adoptGroup(emptyGroupOwnershipRegistry, {
      groupId: 5,
      spaceId: 'space-1',
      windowId: 1,
    });
    registry = adoptGroup(registry, { groupId: 7, spaceId: 'space-1', windowId: 2 });
    const migrated = migrateGroup(registry, 5, { groupId: 8, windowId: 2 });
    expect(groupIdForSpace(migrated, 2, 'space-1')).toBe(7);
    expect(migrated.byGroup.has(5)).toBe(false);
    expect(migrated.byGroup.has(8)).toBe(false);
  });
});

describe('session value round trip', () => {
  it('survives conversion to and from the persisted shape', () => {
    const byWindow = { 1: { 'space-1': 5 }, 2: { 'space-2': 6 } };
    const { registry } = resolveGroupOwnership(
      fromSpaceGroupIdsByWindow(byWindow),
      new Map([[5, 1], [6, 2]]),
    );
    expect(toSpaceGroupIdsByWindow(registry)).toEqual(byWindow);
  });
});
