import type { GroupOwnership } from './groupOwnership';
import { sessionStorageArea } from './sessionValues';

/**
 * The session record of which native group shows each space in each window,
 * kept as `spaceGroupId:<windowId>:<spaceId>` so it ends with the browser session.
 */
const SPACE_GROUP_KEY_PREFIX = 'spaceGroupId:';

export function spaceGroupKey(spaceId: string, windowId: number): string {
  return `${SPACE_GROUP_KEY_PREFIX}${windowId}:${spaceId}`;
}

export function parseSpaceGroupKey(
  key: string,
): { spaceId: string; windowId: number } | undefined {
  if (!key.startsWith(SPACE_GROUP_KEY_PREFIX)) return undefined;
  const mapping = key.slice(SPACE_GROUP_KEY_PREFIX.length);
  const separator = mapping.indexOf(':');
  if (separator < 1) return undefined;
  const windowId = Number(mapping.slice(0, separator));
  const spaceId = mapping.slice(separator + 1);
  return Number.isSafeInteger(windowId) && spaceId ? { spaceId, windowId } : undefined;
}

/** Every space a window shows in a group, mapped to that group. */
export async function windowSpaceGroups(windowId: number): Promise<Map<string, number>> {
  const stored = await sessionStorageArea()?.get(null).catch(() => undefined) ?? {};
  return new Map(Object.entries(stored).flatMap(([key, groupId]) => {
    const mapping = parseSpaceGroupKey(key);
    return mapping?.windowId === windowId && typeof groupId === 'number'
      ? [[mapping.spaceId, groupId] as const]
      : [];
  }));
}

/** Every space shown in a group in any window, with that group. */
export async function allSpaceGroups(): Promise<GroupOwnership[]> {
  const stored = await sessionStorageArea()?.get(null).catch(() => undefined) ?? {};
  return Object.entries(stored).flatMap(([key, groupId]) => {
    const mapping = parseSpaceGroupKey(key);
    return mapping && typeof groupId === 'number' ? [{ ...mapping, groupId }] : [];
  });
}

export async function spaceGroupId(spaceId: string, windowId: number): Promise<number | undefined> {
  const key = spaceGroupKey(spaceId, windowId);
  const value = (await sessionStorageArea()?.get(key).catch(() => undefined))?.[key];
  return typeof value === 'number' ? value : undefined;
}

export async function rememberSpaceGroup(
  spaceId: string,
  windowId: number,
  groupId: number,
): Promise<void> {
  await sessionStorageArea()?.set({ [spaceGroupKey(spaceId, windowId)]: groupId });
}

export async function forgetSpaceGroup(spaceId: string, windowId: number): Promise<void> {
  await sessionStorageArea()?.remove(spaceGroupKey(spaceId, windowId));
}

export async function forgetWindowSpaceGroups(windowId: number): Promise<void> {
  const spaceIds = [...(await windowSpaceGroups(windowId)).keys()];
  if (spaceIds.length > 0) {
    await sessionStorageArea()?.remove(spaceIds.map((spaceId) => spaceGroupKey(spaceId, windowId)));
  }
}
