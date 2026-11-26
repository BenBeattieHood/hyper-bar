import type { BrowserTab } from './bookmarks';
import { spaceTabActivationTarget } from './tabs';
import type { TabOwnership } from './tabOwnership';

export interface LiveSpaceActivationInputs {
  /** Bookmark ids of the tab backings the space owns in this window. */
  backingIds: readonly string[];
  groupTabs: readonly BrowserTab[];
  ownerships: Readonly<Record<number, TabOwnership>>;
  rememberedBackingToken?: string;
  spaceId: string;
  windowId: number;
}

/**
 * Decides whether a space can be reactivated in place instead of being rebuilt
 * from its backings.
 *
 * In-place activation is only safe when the live group is an exact one-to-one
 * match for the space's backings. Anything less means a tab is missing, extra,
 * or double-claimed, and focusing the group would strand or duplicate a tab
 * rather than restore the space, so those cases fall through to a full restore.
 */
export function planLiveSpaceActivation(
  inputs: LiveSpaceActivationInputs,
): { tabId: number } | undefined {
  const { backingIds, groupTabs, ownerships, rememberedBackingToken } = inputs;
  if (groupTabs.length === 0 || backingIds.length === 0) return undefined;
  const claimedBackingIds = groupTabs.flatMap((tab) => {
    if (tab.id === undefined) return [];
    const ownership = ownerships[tab.id];
    return ownership?.spaceId === inputs.spaceId &&
      (ownership.windowId === undefined || ownership.windowId === inputs.windowId) &&
      ownership.backingId
      ? [ownership.backingId]
      : [];
  });
  const backings = new Set(backingIds);
  if (
    claimedBackingIds.length !== groupTabs.length ||
    new Set(claimedBackingIds).size !== claimedBackingIds.length ||
    backings.size !== claimedBackingIds.length ||
    claimedBackingIds.some((backingId) => !backings.has(backingId))
  ) return undefined;
  const target = spaceTabActivationTarget(
    [...groupTabs],
    ownerships,
    rememberedBackingToken,
    false,
  );
  if (target?.id === undefined) return undefined;
  // A remembered tab that is no longer the one holding that token means the
  // space moved on, so the group is rebuilt rather than focused at the old tab.
  if (
    rememberedBackingToken &&
    ownerships[target.id]?.backingToken !== rememberedBackingToken
  ) return undefined;
  return { tabId: target.id };
}
