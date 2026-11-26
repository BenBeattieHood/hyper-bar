import { followedBy } from './async';
import type { BrowserTab } from './bookmarks';
import type { TabBackingLocation } from './bookmarkStorage';
import { isRecord } from './collections';
import { createSessionValueStore } from './sessionValues';

const TAB_SPACE_VALUE_KEY = 'hyperSpaceId';
const TAB_SPACE_STORAGE_PREFIX = 'tabSpaceId:';

export interface TabOwnership {
  spaceId: string;
  windowId?: number;
  backingId?: string;
  backingToken?: string;
  url?: string;
}

/** The backing ids and tokens that live tab locations or persisted ownerships already claim. */
export function claimedBackings(
  locations: Iterable<Pick<TabBackingLocation, 'backingId' | 'backingToken'>>,
  ownerships: Iterable<TabOwnership | undefined>,
): { claimedBackingIds: Set<string>; claimedBackingTokens: Set<string> } {
  const claimedBackingIds = new Set<string>();
  const claimedBackingTokens = new Set<string>();
  for (const { backingId, backingToken } of locations) {
    claimedBackingIds.add(backingId);
    claimedBackingTokens.add(backingToken);
  }
  for (const ownership of ownerships) {
    if (ownership?.backingId) claimedBackingIds.add(ownership.backingId);
    if (ownership?.backingToken) claimedBackingTokens.add(ownership.backingToken);
  }
  return { claimedBackingIds, claimedBackingTokens };
}

/** Whether two records name the same space, window, backing and page. */
export function sameTabOwnership(left: TabOwnership, right: TabOwnership): boolean {
  return left.spaceId === right.spaceId &&
    left.windowId === right.windowId &&
    left.backingId === right.backingId &&
    left.backingToken === right.backingToken &&
    left.url === right.url;
}

function parseOwnership(value: unknown): TabOwnership | undefined {
  if (typeof value === 'string') return { spaceId: value };
  if (!isRecord(value)) return undefined;
  const ownership = value;
  if (typeof ownership.spaceId !== 'string') return undefined;
  return {
    spaceId: ownership.spaceId,
    ...(typeof ownership.windowId === 'number' ? { windowId: ownership.windowId } : {}),
    ...(typeof ownership.backingId === 'string' ? { backingId: ownership.backingId } : {}),
    ...(typeof ownership.backingToken === 'string'
      ? { backingToken: ownership.backingToken }
      : {}),
    ...(typeof ownership.url === 'string' ? { url: ownership.url } : {}),
  };
}

const ownershipValues = createSessionValueStore({
  mirrorWrites: true,
  parse: parseOwnership,
  scope: 'Tab',
  storageKey: (tabId) => `${TAB_SPACE_STORAGE_PREFIX}${tabId}`,
  valueKey: TAB_SPACE_VALUE_KEY,
});

export function getTabOwnership(tabId: number): Promise<TabOwnership | undefined> {
  return ownershipValues.get(tabId);
}

export async function getTabSpaceId(tabId: number): Promise<string | undefined> {
  return (await getTabOwnership(tabId))?.spaceId;
}

export function setTabOwnership(tabId: number, ownership: TabOwnership): Promise<void> {
  return ownershipValues.set(tabId, ownership);
}

export function createTabOwnershipWriter(
  onPersisted: () => void,
): (tabId: number, ownership: TabOwnership) => Promise<void> {
  return followedBy(setTabOwnership, onPersisted);
}

export async function setTabSpaceId(tabId: number, spaceId: string): Promise<void> {
  const current = await getTabOwnership(tabId);
  await setTabOwnership(tabId, {
    ...(current ?? {}),
    spaceId,
  });
}

export function removeTabSpaceId(tabId: number): Promise<void> {
  return ownershipValues.remove(tabId);
}

export async function loadTabSpaceIds(
  tabs: BrowserTab[],
): Promise<Record<number, string>> {
  const ownerships = await loadTabOwnerships(tabs);
  return Object.fromEntries(Object.entries(ownerships).map(
    ([tabId, ownership]) => [tabId, ownership.spaceId],
  ));
}

/** One storage read for every tab the native tab values do not cover. */
export function tabOwnershipsById(tabs: readonly BrowserTab[]): Promise<Map<number, TabOwnership>> {
  return ownershipValues.getMany(tabs.flatMap((tab) => tab.id === undefined ? [] : [tab.id]));
}

export async function loadTabOwnerships(
  tabs: BrowserTab[],
): Promise<Record<number, TabOwnership>> {
  return Object.fromEntries(await tabOwnershipsById(tabs));
}

export function tabsOwnedBySpace(
  tabs: BrowserTab[],
  ownerships: Readonly<Record<number, TabOwnership>>,
  spaceId: string,
): BrowserTab[] {
  return tabs.filter(
    (tab) => tab.id !== undefined && ownerships[tab.id]?.spaceId === spaceId,
  );
}