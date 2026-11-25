import { addToMapList } from './collections';
import { isTabGroupColour, type TabGroupColour } from './tabGroups';
/**
 * A native tab group belongs to at most one (window, space) pair and a
 * (window, space) pair owns at most one group. Both directions are enforced,
 * because a single-direction map cannot detect the two situations that actually
 * occur: a session value outliving its group, and a group moving between
 * windows and being reissued a new id.
 */

export interface GroupOwnership {
  groupId: number;
  spaceId: string;
  windowId: number;
}

export interface GroupOwnershipRegistry {
  byGroup: ReadonlyMap<number, GroupOwnership>;
  bySpace: ReadonlyMap<string, GroupOwnership>;
}

export type GroupOwnershipConflict =
  | { claims: readonly GroupOwnership[]; groupId: number; kind: 'group-claimed-twice' }
  | { groupIds: readonly number[]; kind: 'space-mapped-twice'; spaceId: string; windowId: number };

export interface GroupOwnershipResolution {
  conflicts: readonly GroupOwnershipConflict[];
  registry: GroupOwnershipRegistry;
}

export const emptyGroupOwnershipRegistry: GroupOwnershipRegistry = {
  byGroup: new Map(),
  bySpace: new Map(),
};

function spaceKey(windowId: number, spaceId: string): string {
  return `${windowId}:${spaceId}`;
}

function toRegistry(ownerships: readonly GroupOwnership[]): GroupOwnershipRegistry {
  return {
    byGroup: new Map(ownerships.map((ownership) => [ownership.groupId, ownership])),
    bySpace: new Map(ownerships.map(
      (ownership) => [spaceKey(ownership.windowId, ownership.spaceId), ownership],
    )),
  };
}

export function groupOwnerships(
  registry: GroupOwnershipRegistry,
): readonly GroupOwnership[] {
  return [...registry.byGroup.values()];
}

export function groupIdForSpace(
  registry: GroupOwnershipRegistry,
  windowId: number,
  spaceId: string,
): number | undefined {
  return registry.bySpace.get(spaceKey(windowId, spaceId))?.groupId;
}

export function ownershipForGroup(
  registry: GroupOwnershipRegistry,
  groupId: number,
): GroupOwnership | undefined {
  return registry.byGroup.get(groupId);
}

export function groupIdsForWindow(
  registry: GroupOwnershipRegistry,
  windowId: number,
): Readonly<Record<string, number>> {
  return Object.fromEntries([...registry.byGroup.values()].flatMap(
    (ownership) => ownership.windowId === windowId
      ? [[ownership.spaceId, ownership.groupId] as const]
      : [],
  ));
}

/**
 * Rebuilds the registry from persisted mappings against the groups the browser
 * actually reports. A mapping whose group no longer exists expires quietly; a
 * mapping whose group lives in a different window migrates to that window when
 * the destination is free; and an unresolvable claim is dropped entirely so the
 * only way back is an explicit adoption rather than a guess.
 */
export function resolveGroupOwnership(
  mappings: readonly GroupOwnership[],
  observedGroupWindows: ReadonlyMap<number, number>,
): GroupOwnershipResolution {
  const conflicts: GroupOwnershipConflict[] = [];
  const live = mappings.flatMap((mapping) => {
    const observedWindowId = observedGroupWindows.get(mapping.groupId);
    if (observedWindowId === undefined) return [];
    return [{ ...mapping, windowId: observedWindowId }];
  });

  const byGroup = new Map<number, GroupOwnership[]>();
  for (const mapping of live) {
    addToMapList(byGroup, mapping.groupId, mapping);
  }
  const uniqueGroups = [...byGroup.entries()].flatMap(([groupId, claims]) => {
    const spaceIds = new Set(claims.map((claim) => claim.spaceId));
    if (spaceIds.size === 1) return [claims[0]!];
    conflicts.push({ claims, groupId, kind: 'group-claimed-twice' });
    return [];
  });

  const bySpace = new Map<string, GroupOwnership[]>();
  for (const mapping of uniqueGroups) {
    addToMapList(bySpace, spaceKey(mapping.windowId, mapping.spaceId), mapping);
  }
  const resolved = [...bySpace.values()].flatMap((claims) => {
    if (claims.length === 1) return [claims[0]!];
    const first = claims[0]!;
    conflicts.push({
      groupIds: claims.map((claim) => claim.groupId),
      kind: 'space-mapped-twice',
      spaceId: first.spaceId,
      windowId: first.windowId,
    });
    return [];
  });

  return { conflicts, registry: toRegistry(resolved) };
}

/**
 * Adoption is the only way a group becomes a Hyper group. It displaces both the
 * previous group for that space and the previous space for that group, so the
 * registry cannot be driven into an ambiguous state by repeated adoption.
 */
export function adoptGroup(
  registry: GroupOwnershipRegistry,
  ownership: GroupOwnership,
): GroupOwnershipRegistry {
  const key = spaceKey(ownership.windowId, ownership.spaceId);
  const retained = groupOwnerships(registry).filter(
    (existing) => existing.groupId !== ownership.groupId
      && spaceKey(existing.windowId, existing.spaceId) !== key,
  );
  return toRegistry([...retained, ownership]);
}

export function unadoptGroup(
  registry: GroupOwnershipRegistry,
  groupId: number,
): GroupOwnershipRegistry {
  return toRegistry(groupOwnerships(registry).filter(
    (ownership) => ownership.groupId !== groupId,
  ));
}

/**
 * Chromium reissues a group id when its tabs move to another window. The space
 * keeps its group only if the destination window has no group of its own for
 * that space; otherwise the stale mapping is dropped rather than displacing a
 * mapping that matches a real group.
 */
export function migrateGroup(
  registry: GroupOwnershipRegistry,
  previousGroupId: number,
  next: { groupId: number; windowId: number },
): GroupOwnershipRegistry {
  const previous = registry.byGroup.get(previousGroupId);
  if (!previous) return registry;
  const withoutPrevious = unadoptGroup(registry, previousGroupId);
  const occupant = withoutPrevious.bySpace.get(spaceKey(next.windowId, previous.spaceId));
  if (occupant && occupant.groupId !== next.groupId) return withoutPrevious;
  return adoptGroup(withoutPrevious, {
    groupId: next.groupId,
    spaceId: previous.spaceId,
    windowId: next.windowId,
  });
}

export function toSpaceGroupIdsByWindow(
  registry: GroupOwnershipRegistry,
): Readonly<Record<number, Readonly<Record<string, number>>>> {
  const byWindow: Record<number, Record<string, number>> = {};
  for (const ownership of registry.byGroup.values()) {
    byWindow[ownership.windowId] ??= {};
    byWindow[ownership.windowId]![ownership.spaceId] = ownership.groupId;
  }
  return byWindow;
}

export function fromSpaceGroupIdsByWindow(
  byWindow: Readonly<Record<number, Readonly<Record<string, number>>>>,
): readonly GroupOwnership[] {
  return Object.entries(byWindow).flatMap(([windowId, spaces]) =>
    Object.entries(spaces).map(([spaceId, groupId]) => ({
      groupId,
      spaceId,
      windowId: Number(windowId),
    })));
}

export interface ObservedGroup {
  color: string;
  id: number;
  windowId: number;
}

/** The live groups each space owns, with the colour each wears, in ownership order. */
export function ownedGroupColours(
  groups: readonly ObservedGroup[],
  ownerships: readonly GroupOwnership[],
): Map<string, Array<{ colour: TabGroupColour; id: number; windowId: number }>> {
  const groupsById = new Map(groups.map((group) => [group.id, group] as const));
  const bySpace = new Map<string, Array<{ colour: TabGroupColour; id: number; windowId: number }>>();
  for (const ownership of ownerships) {
    const group = groupsById.get(ownership.groupId);
    if (!group || group.windowId !== ownership.windowId || !isTabGroupColour(group.color)) continue;
    addToMapList(bySpace, ownership.spaceId, { colour: group.color, id: group.id, windowId: group.windowId });
  }
  return bySpace;
}

/**
 * Each space's colour, which is only ever the colour its tab groups wear: its
 * group's in `windowId` first, else one in another window. A space with no open
 * group has none.
 */
export function liveSpaceColours(
  groups: readonly ObservedGroup[],
  ownerships: readonly GroupOwnership[],
  windowId?: number,
): Map<string, TabGroupColour> {
  return new Map([...ownedGroupColours(groups, ownerships)].map(([spaceId, owned]) => [
    spaceId,
    (owned.find((group) => group.windowId === windowId) ?? owned[0]!).colour,
  ] as const));
}
