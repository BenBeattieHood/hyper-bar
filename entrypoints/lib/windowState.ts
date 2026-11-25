import { followedBy } from './async';
import { createSessionValueStore, sessionStorageArea } from './sessionValues';

type WindowKind = Pick<Browser.windows.Window, 'incognito' | 'type'>;

/** A normal, non-incognito window: the only kind Hyper shows spaces in. */
export function isNormalWindow(window: WindowKind): boolean {
  return window.type === 'normal' && !window.incognito;
}

/** The window with this ID, or undefined once it has closed. */
export function windowById(windowId: number): Promise<Browser.windows.Window | undefined> {
  return browser.windows.get(windowId).catch(() => undefined);
}

export function normalWindowIds(windows: readonly (WindowKind & { id?: number })[]): Set<number> {
  return new Set(windows.flatMap((window) =>
    window.id !== undefined && isNormalWindow(window) ? [window.id] : []));
}

export const LEGACY_ACTIVE_SPACE_KEY = 'activeSpaceId';
const LEGACY_ACTIVE_SPACE_PREFIX = `${LEGACY_ACTIVE_SPACE_KEY}:`;
const ACTIVE_SPACE_SESSION_PREFIX = 'hyperActiveSpaceId:v1:';
export const ACTIVE_SPACE_WINDOW_VALUE_KEY = 'hyperActiveSpaceId';

export function activeSpaceKey(windowId: number): string {
  return `${ACTIVE_SPACE_SESSION_PREFIX}${windowId}`;
}

export function isActiveSpaceKey(key: string, windowId?: number): boolean {
  return key === LEGACY_ACTIVE_SPACE_KEY || (
    windowId === undefined
      ? key.startsWith(ACTIVE_SPACE_SESSION_PREFIX) ||
        key.startsWith(LEGACY_ACTIVE_SPACE_PREFIX)
      : key === activeSpaceKey(windowId)
  );
}

const activeSpaces = createSessionValueStore({
  parse: (value) => typeof value === 'string' ? value : undefined,
  scope: 'Window',
  storageKey: activeSpaceKey,
  valueKey: ACTIVE_SPACE_WINDOW_VALUE_KEY,
});

export function getWindowActiveSpaceId(windowId: number): Promise<string | undefined> {
  return activeSpaces.get(windowId);
}

export function setWindowActiveSpaceId(windowId: number, spaceId: string): Promise<void> {
  return activeSpaces.set(windowId, spaceId);
}

export function createWindowActiveSpaceWriter(
  onPersisted: () => void,
): (windowId: number, spaceId: string) => Promise<void> {
  return followedBy(setWindowActiveSpaceId, onPersisted);
}

export function removeWindowActiveSpaceId(windowId: number): Promise<void> {
  return activeSpaces.remove(windowId);
}

export async function reconcileWindowActiveSpaceIds(
  openWindowIds: ReadonlySet<number>,
): Promise<void> {
  const legacyValues = await browser.storage.local.get(null);
  const legacyKeys = Object.keys(legacyValues).filter((key) =>
    key === LEGACY_ACTIVE_SPACE_KEY || key.startsWith(LEGACY_ACTIVE_SPACE_PREFIX));
  if (legacyKeys.length > 0) await browser.storage.local.remove(legacyKeys);

  const session = sessionStorageArea();
  const sessionValues = await session?.get(null).catch(() => undefined);
  const staleSessionKeys = Object.keys(sessionValues ?? {}).filter((key) => {
    if (!key.startsWith(ACTIVE_SPACE_SESSION_PREFIX)) return false;
    const windowId = Number(key.slice(ACTIVE_SPACE_SESSION_PREFIX.length));
    return Number.isSafeInteger(windowId) && !openWindowIds.has(windowId);
  });
  if (staleSessionKeys.length > 0) {
    await session?.remove(staleSessionKeys);
  }
}

/**
 * Matches each previous window to the window now showing its tabs: by tab
 * ownership that names exactly one current window, then by the most pages a
 * previous window's backings share with a current window's tabs.
 */
export function mapRestoredWindowIds(
  previousWindowTargets: ReadonlyMap<number, ReadonlySet<number>>,
  backingPagesByWindow: ReadonlyMap<number, ReadonlySet<string>>,
  livePagesByWindow: ReadonlyMap<number, ReadonlySet<string>>,
): Map<number, number> {
  const soleTarget = (targets: ReadonlySet<number>) =>
    targets.size === 1 ? [...targets][0] : undefined;
  const sources = new Map<number, number>();
  for (const targets of previousWindowTargets.values()) {
    const target = soleTarget(targets);
    if (target !== undefined) sources.set(target, (sources.get(target) ?? 0) + 1);
  }
  const mapping = new Map([...previousWindowTargets].flatMap(([previousWindowId, targets]) => {
    const target = soleTarget(targets);
    return target !== undefined && sources.get(target) === 1
      ? [[previousWindowId, target] as const]
      : [];
  }));
  const mappedCurrent = new Set(mapping.values());
  const unmapped = (previousWindowId: number, currentWindowId: number) =>
    !mapping.has(previousWindowId) && !mappedCurrent.has(currentWindowId);
  const inferred = [...backingPagesByWindow].flatMap(([previousWindowId, backingPages]) =>
    [...livePagesByWindow].flatMap(([currentWindowId, livePages]) => {
      if (!unmapped(previousWindowId, currentWindowId)) return [];
      const overlap = [...livePages].filter((identity) => backingPages.has(identity)).length;
      return overlap > 0 ? [{ currentWindowId, overlap, previousWindowId }] : [];
    }))
    .sort((left, right) => right.overlap - left.overlap);
  for (const { currentWindowId, previousWindowId } of inferred) {
    if (!unmapped(previousWindowId, currentWindowId)) continue;
    mapping.set(previousWindowId, currentWindowId);
    mappedCurrent.add(currentWindowId);
  }
  return mapping;
}