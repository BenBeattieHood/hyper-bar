import { withNamedAsyncLock } from './async';
import { pickByText } from './collections';

type TabGroup = Browser.tabGroups.TabGroup;

export interface TabGroupChanges {
  collapsed?: boolean;
  color?: TabGroupColour;
  title?: string;
}

interface NativeTabGroups {
  get(groupId: number): Promise<TabGroup>;
  move(groupId: number, moveProperties: { index: number }): Promise<unknown>;
  query(queryInfo: { windowId?: number }): Promise<TabGroup[]>;
  update(groupId: number, changes: TabGroupChanges): Promise<TabGroup>;
}

/** The browser's `tabGroups`, if it has every one of the `needed` calls. */
export function nativeTabGroups<Name extends keyof NativeTabGroups>(
  ...needed: Name[]
): Pick<NativeTabGroups, Name> | undefined {
  const tabGroups = (browser as unknown as { tabGroups?: Partial<NativeTabGroups> }).tabGroups;
  return tabGroups && needed.every((name) => typeof tabGroups[name] === 'function')
    ? tabGroups as Pick<NativeTabGroups, Name>
    : undefined;
}

/** The tab group calls Hyper's group placement needs, where the browser has them all. */
export interface TabGroupApi {
  get(groupId: number): Promise<TabGroup>;
  group(options: { createProperties?: { windowId: number }; groupId?: number; tabIds: number | number[] }): Promise<number>;
  query(windowId: number): Promise<TabGroup[]>;
  ungroup(tabIds: number | number[]): Promise<void>;
  update(groupId: number, changes: TabGroupChanges): Promise<TabGroup>;
}

export function tabGroupApi(): TabGroupApi | undefined {
  const tabGroups = nativeTabGroups('get', 'query', 'update');
  const { tabs } = browser as unknown as {
    tabs: { group?: TabGroupApi['group']; ungroup?: (tabIds: number | number[]) => Promise<void> };
  };
  if (!tabGroups || !tabs.group) return undefined;
  return {
    get: (groupId) => tabGroups.get(groupId),
    group: (options) => tabs.group!(options),
    query: (windowId) => tabGroups.query({ windowId }),
    ungroup: async (tabIds) => { await tabs.ungroup?.(tabIds); },
    update: (groupId, changes) => tabGroups.update(groupId, changes),
  };
}

const SUPERSCRIPT_DIGITS: Record<string, string> = {
  '⁰': '0',
  '¹': '1',
  '²': '2',
  '³': '3',
  '⁴': '4',
  '⁵': '5',
  '⁶': '6',
  '⁷': '7',
  '⁸': '8',
  '⁹': '9',
};

/** Every colour a browser tab group can take, and so every colour a space can wear. */
export const TAB_GROUP_COLOURS = [
  'grey',
  'blue',
  'red',
  'yellow',
  'green',
  'pink',
  'purple',
  'cyan',
  'orange',
] as const satisfies readonly Browser.tabGroups.TabGroup['color'][];

export type TabGroupColour = (typeof TAB_GROUP_COLOURS)[number];

export function isTabGroupColour(value: unknown): value is TabGroupColour {
  return (TAB_GROUP_COLOURS as readonly unknown[]).includes(value);
}

const HYPER_GROUP_COLOURS = [
  'blue',
  'green',
  'yellow',
  'red',
  'cyan',
  'orange',
  'pink',
] as const satisfies readonly TabGroupColour[];

/** The colour a space's first group takes, since a browser group needs one. */
export function defaultHyperGroupColour(spaceId: string): TabGroupColour {
  return pickByText(HYPER_GROUP_COLOURS, spaceId);
}

export function tabActivationCanSelectSpace(
  tab: { active?: boolean; groupId: number; windowId: number },
  group: { collapsed: boolean; id: number; windowId: number } | undefined,
  windowId: number,
): group is { collapsed: boolean; id: number; windowId: number } {
  return Boolean(
    tab.active &&
    tab.windowId === windowId &&
    group &&
    group.id === tab.groupId &&
    group.windowId === windowId,
  );
}

/** Brackets Hyper's own group edits so the group listeners do not take them for the user's. */
export interface ProgrammaticGroupUpdates {
  beginProgrammaticGroupUpdate(groupId: number): void;
  endProgrammaticGroupUpdate(groupId: number): Promise<void>;
}

export async function withHyperGroupLock<T>(
  windowId: number,
  operation: () => Promise<T>,
): Promise<T> {
  return withNamedAsyncLock(`hyper-window-groups:${windowId}`, operation);
}

export function hyperGroupTitle(spaceIndex: number): string {
  const ordinal = String(spaceIndex + 1)
    .split('')
    .map((digit) => Object.entries(SUPERSCRIPT_DIGITS).find(([, value]) => value === digit)?.[0])
    .join('');
  return `𝒉${ordinal}`;
}

export function hyperGroupOrdinal(title?: string): number | undefined {
  if (!title) return undefined;
  const normalised = Array.from(title.trim().toLocaleLowerCase())
    .map((character) => SUPERSCRIPT_DIGITS[character] ?? character)
    .join('')
    .replace(/[𝒉ℎ𝐡𝘩]/gu, 'h')
    .replace(/\s+/g, '');
  const match = /^h(\d+)$/.exec(normalised);
  const ordinal = match ? Number(match[1]) : 0;
  return Number.isSafeInteger(ordinal) && ordinal > 0 ? ordinal : undefined;
}

export function findHyperGroupForSpace<T extends { id: number; title?: string }>(
  groups: T[],
  spaceIndex: number,
  preferredGroupIds: number[] = [],
): T | undefined {
  const matches = findHyperGroupsForSpace(groups, spaceIndex);
  for (const groupId of preferredGroupIds) {
    const preferred = matches.find((group) => group.id === groupId);
    if (preferred) return preferred;
  }
  return matches[0];
}

export function resolveHyperGroupForSpace<T extends { id: number; title?: string }>(
  groups: T[],
  spaceIndex: number,
  ownedGroupId?: number,
  preferredRecoveryIds: number[] = [],
  claimedGroupIds: ReadonlySet<number> = new Set(),
): { group: T | undefined; recovered: boolean } {
  const owned = ownedGroupId === undefined
    ? undefined
    : groups.find((group) => group.id === ownedGroupId);
  if (owned) return { group: owned, recovered: false };
  return {
    group: findHyperGroupForSpace(
      groups.filter((group) => !claimedGroupIds.has(group.id)),
      spaceIndex,
      preferredRecoveryIds,
    ),
    recovered: true,
  };
}

export function findHyperGroupsForSpace<T extends { title?: string }>(
  groups: T[],
  spaceIndex: number,
): T[] {
  return groups.filter(
    (group) => hyperGroupOrdinal(group.title) === spaceIndex + 1,
  );
}

type IndexedGroupTab = {
  groupId: number;
  index: number;
};

function liveGroupPositions(tabs: readonly IndexedGroupTab[]): Map<number, number> {
  const positions = new Map<number, number>();
  for (const tab of tabs) {
    if (tab.groupId < 0) continue;
    const current = positions.get(tab.groupId);
    if (current === undefined || tab.index < current) {
      positions.set(tab.groupId, tab.index);
    }
  }
  return positions;
}

export function ownedTabGroupOrder(
  ownedGroupIds: readonly number[],
  tabs: readonly IndexedGroupTab[],
): number[] {
  const positions = liveGroupPositions(tabs);
  return [...new Set(ownedGroupIds)]
    .filter((groupId) => positions.has(groupId))
    .sort((left, right) => positions.get(left)! - positions.get(right)!);
}

export function spaceOrderMatchingTabGroups(
  spaceIds: readonly string[],
  groupIdBySpace: ReadonlyMap<string, number>,
  tabs: readonly IndexedGroupTab[],
): string[] {
  const positions = liveGroupPositions(tabs);
  const groupedSpaceIds = spaceIds.filter((spaceId) => {
    const groupId = groupIdBySpace.get(spaceId);
    return groupId !== undefined && positions.has(groupId);
  });
  const orderedGroupedSpaceIds = groupedSpaceIds.sort((left, right) =>
    positions.get(groupIdBySpace.get(left)!)! -
    positions.get(groupIdBySpace.get(right)!)!);
  let groupedIndex = 0;
  return spaceIds.map((spaceId) => {
    const groupId = groupIdBySpace.get(spaceId);
    return groupId !== undefined && positions.has(groupId)
      ? orderedGroupedSpaceIds[groupedIndex++] ?? spaceId
      : spaceId;
  });
}

export function spaceBookmarkMovesForOrder(
  currentSpaceIds: readonly string[],
  orderedSpaceIds: readonly string[],
): Array<{ spaceId: string; index: number }> {
  const current = [...currentSpaceIds];
  const moves: Array<{ spaceId: string; index: number }> = [];
  for (const [targetIndex, spaceId] of orderedSpaceIds.entries()) {
    const sourceIndex = current.indexOf(spaceId);
    if (sourceIndex < 0 || sourceIndex === targetIndex) continue;
    moves.push({
      spaceId,
      index: sourceIndex < targetIndex ? targetIndex + 1 : targetIndex,
    });
    current.splice(sourceIndex, 1);
    current.splice(targetIndex, 0, spaceId);
  }
  return moves;
}