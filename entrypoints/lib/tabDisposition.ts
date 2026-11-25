import { bookmarkableTabUrl, type BrowserTab } from './bookmarks';
import type { TabOwnership } from './tabOwnership';

/**
 * Every observed tab resolves to exactly one disposition. There is no implicit
 * "adopt into the active space" path, so a natively created tab can neither
 * appear inside a space it was never assigned to nor be silently dropped.
 */
export type TabDisposition =
  | { backingId: string; spaceId: string; status: 'owned' }
  | { reason: IgnoredTabReason; status: 'ignored' }
  | { reason: LooseTabReason; status: 'loose' }
  | { backingId?: string; spaceId: string; status: 'pending-recovery' }
  | { backingId?: string; spaceId: string; status: 'in-transit' };

/** Contexts Hyper must not observe, own, or mutate at all. */
export type IgnoredTabReason = 'private-context' | 'unidentified' | 'unsupported-window';

/** Real tabs Hyper shows but does not own. */
export type LooseTabReason =
  | 'backing-claimed'
  | 'space-removed'
  | 'unbackable-url'
  | 'unowned';

export interface BackingLocation {
  spaceId: string;
  token?: string;
}

export interface TabDispositionInputs {
  backings: ReadonlyMap<string, BackingLocation>;
  extensionOrigin: string;
  knownSpaceIds: ReadonlySet<string>;
  normalWindowIds: ReadonlySet<number>;
  ownerships: Readonly<Record<number, TabOwnership>>;
  tabs: readonly BrowserTab[];
}

export interface TabDispositionEntry {
  disposition: TabDisposition;
  tab: BrowserTab;
}

/**
 * Two live tabs can carry the same ownership when the browser copies session
 * values, so the claim is resolved deterministically by lowest tab id: the
 * original keeps the backing and every copy becomes loose, which is what makes
 * a fresh backing the only possible outcome for the duplicate.
 */
function resolveBackingClaims(inputs: TabDispositionInputs): ReadonlyMap<string, number> {
  const claims = new Map<string, number>();
  for (const tab of inputs.tabs) {
    if (tab.id === undefined) continue;
    const backingId = inputs.ownerships[tab.id]?.backingId;
    if (backingId === undefined) continue;
    const winner = claims.get(backingId);
    if (winner === undefined || tab.id < winner) claims.set(backingId, tab.id);
  }
  return claims;
}

function resolveBacking(
  inputs: TabDispositionInputs,
  ownership: TabOwnership,
): BackingLocation | undefined {
  if (ownership.backingId === undefined) return undefined;
  const backing = inputs.backings.get(ownership.backingId);
  if (!backing) return undefined;
  // A recycled bookmark id must not be mistaken for the original backing.
  const tokensDisagree = ownership.backingToken !== undefined
    && backing.token !== undefined
    && ownership.backingToken !== backing.token;
  return tokensDisagree ? undefined : backing;
}

function classifyOwnedTab(
  inputs: TabDispositionInputs,
  claims: ReadonlyMap<string, number>,
  tabId: number,
  ownership: TabOwnership,
): TabDisposition {
  const backing = resolveBacking(inputs, ownership);
  if (backing && ownership.backingId !== undefined) {
    return claims.get(ownership.backingId) === tabId
      ? { backingId: ownership.backingId, spaceId: backing.spaceId, status: 'owned' }
      : { reason: 'backing-claimed', status: 'loose' };
  }
  if (!inputs.knownSpaceIds.has(ownership.spaceId)) {
    return { reason: 'space-removed', status: 'loose' };
  }
  return {
    ...(ownership.backingId === undefined ? {} : { backingId: ownership.backingId }),
    spaceId: ownership.spaceId,
    status: 'pending-recovery',
  };
}

/**
 * A tab moved to another window keeps its old window's ownership until the move
 * that carried it places it, so until then it is in transit and belongs to no space here.
 */
export function ownershipNamesAnotherWindow(
  tab: Pick<BrowserTab, 'windowId'>,
  ownership: Pick<TabOwnership, 'windowId'> | undefined,
): boolean {
  return ownership?.windowId !== undefined && ownership.windowId !== tab.windowId;
}

function classifyTab(
  inputs: TabDispositionInputs,
  claims: ReadonlyMap<string, number>,
  tab: BrowserTab,
): TabDisposition {
  if (tab.id === undefined) return { reason: 'unidentified', status: 'ignored' };
  if (tab.incognito) return { reason: 'private-context', status: 'ignored' };
  if (!inputs.normalWindowIds.has(tab.windowId)) {
    return { reason: 'unsupported-window', status: 'ignored' };
  }
  const ownership = inputs.ownerships[tab.id];
  if (ownership) {
    const disposition = classifyOwnedTab(inputs, claims, tab.id, ownership);
    return ownershipNamesAnotherWindow(tab, ownership) &&
      (disposition.status === 'owned' || disposition.status === 'pending-recovery')
      ? { ...disposition, status: 'in-transit' }
      : disposition;
  }
  return bookmarkableTabUrl(tab, inputs.extensionOrigin) === null
    ? { reason: 'unbackable-url', status: 'loose' }
    : { reason: 'unowned', status: 'loose' };
}

/** Total over the observed tab set: one entry per input tab, in input order. */
export function classifyObservedTabs(
  inputs: TabDispositionInputs,
): readonly TabDispositionEntry[] {
  const claims = resolveBackingClaims(inputs);
  return inputs.tabs.map((tab) => ({ disposition: classifyTab(inputs, claims, tab), tab }));
}

export function tabDispositionsById(
  entries: readonly TabDispositionEntry[],
): ReadonlyMap<number, TabDisposition> {
  const byId = new Map<number, TabDisposition>();
  for (const entry of entries) {
    if (entry.tab.id !== undefined) byId.set(entry.tab.id, entry.disposition);
  }
  return byId;
}

/** The space a tab's activation selects: only a tab its own window's space holds. */
export function activationSpaceId(disposition: TabDisposition): string | undefined {
  return disposition.status === 'owned' || disposition.status === 'pending-recovery'
    ? disposition.spaceId
    : undefined;
}
