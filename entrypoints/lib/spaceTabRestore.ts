import { withNamedAsyncLock } from './async';
import { deriveSpaces, tabBackingSpaceId, tabBackingToken } from './bookmarks';
import {
  bookmarkById,
  ensureTabBackingBookmark,
  type TabBackingLocation,
  windowTabBackings,
} from './bookmarkStorage';
import { isRecord } from './collections';
import {
  advanceDurableOperation,
  beginDurableOperation,
  completeDurableOperation,
  type DurableOperation,
  type DurableOperationResolution,
} from './operationJournal';
import { getTabOwnership, tabOwnershipsById, type TabOwnership } from './tabOwnership';
import { isCurrentSpaceRestoreCandidate, tabById } from './tabs';
import { pageIdentity, tabPageIdentity } from './urlIdentity';

export interface SpaceTabRestoreDependencies {
  /** Each window's current space activation; a restore begun under an older one stops. */
  activationTokens: ReadonlyMap<number, string>;
  /** Whether a closed tab's backing is still waiting to be removed, so its tab stays closed. */
  backingClosing(backing: { backingId: string; backingToken?: string }): Promise<boolean>;
  backingClaimedByAnotherLiveTab(
    tabId: number,
    backing: { backingId: string; backingToken?: string },
  ): Promise<boolean>;
  markIntentionalTab(tabId: number): void;
  persistTabOwnership(tabId: number, ownership: TabOwnership): Promise<void>;
  tabBackingLocations: Map<number, TabBackingLocation>;
}

export type SpaceTabRestore = (
  spaceId: string,
  windowId: number,
  candidateTabIds: number[],
  groupId?: number,
  activationToken?: string,
) => Promise<number[]>;

/** A restore interrupted after creating tabs completes only if every tab still proves its backing. */
export async function recoverSpaceTabRestore(
  operation: DurableOperation,
): Promise<DurableOperationResolution> {
  const { spaceId, windowId } = operation.completionProof;
  const createdTabs = operation.payload.createdTabs;
  if (
    typeof spaceId !== 'string' ||
    typeof windowId !== 'number' ||
    !Array.isArray(createdTabs) ||
    createdTabs.length === 0
  ) {
    return { reason: 'The restored tab identities were not fully recorded.', status: 'abandoned' };
  }
  for (const created of createdTabs) {
    if (!isRecord(created)) {
      return { reason: 'A restored tab record is invalid.', status: 'abandoned' };
    }
    const record = created;
    if (
      typeof record.tabId !== 'number' ||
      typeof record.backingId !== 'string' ||
      typeof record.backingToken !== 'string'
    ) {
      return { reason: 'A restored tab record is incomplete.', status: 'abandoned' };
    }
    const [tab, ownership, backing] = await Promise.all([
      tabById(record.tabId),
      getTabOwnership(record.tabId),
      bookmarkById(record.backingId),
    ]);
    if (
      !tab ||
      tab.windowId !== windowId ||
      !ownership ||
      ownership.spaceId !== spaceId ||
      ownership.backingId !== record.backingId ||
      ownership.backingToken !== record.backingToken ||
      !backing ||
      tabBackingSpaceId(backing) !== spaceId ||
      tabBackingToken(backing) !== record.backingToken
    ) {
      return {
        reason: 'A restored tab changed before its ownership could be proven.',
        status: 'abandoned',
      };
    }
  }
  return { status: 'completed' };
}

/**
 * Reopens a space's missing tabs in a window from their backing bookmarks.
 *
 * Tabs already in the window reclaim their own backings first, so only a
 * backing no live tab claims becomes a new tab, and not one whose tab has
 * just closed and waits for its release. The creation is journalled: a
 * worker stopped part-way abandons the restore rather than repeating it.
 */
export function createSpaceTabRestore(dependencies: SpaceTabRestoreDependencies): SpaceTabRestore {
  return (spaceId, windowId, candidateTabIds, groupId, activationToken) => withNamedAsyncLock(
    `hyper:space-mutation:${spaceId}`,
    async () => {
      const shouldContinue = () => activationToken === undefined ||
        dependencies.activationTokens.get(windowId) === activationToken;
      if (!shouldContinue()) return [];
      const tree = await browser.bookmarks.getTree();
      if (!shouldContinue()) return [];
      if (!deriveSpaces(tree).some((space) => space.id === spaceId)) return [];
      const allTabs = await browser.tabs.query({});
      const allOwnerships = await tabOwnershipsById(allTabs);
      if (!shouldContinue()) return [];
      const candidateIds = new Set(candidateTabIds);
      const existingTabs = allTabs.filter((tab) =>
        isCurrentSpaceRestoreCandidate(tab, windowId, candidateIds, groupId));
      const existingTabIds = new Set(existingTabs.map((tab) => tab.id as number));
      const claimedBackingIds = new Set([...allOwnerships].flatMap(([tabId, ownership]) =>
        !existingTabIds.has(tabId) && ownership?.backingId ? [ownership.backingId] : [],
      ));
      const claimedBackingTokens = new Set([...allOwnerships].flatMap(([tabId, ownership]) =>
        !existingTabIds.has(tabId) && ownership?.backingToken ? [ownership.backingToken] : [],
      ));
      const backings = await windowTabBackings(spaceId, windowId);
      if (!shouldContinue()) return [];
      const backingLocation = (backing: (typeof backings)[number]) => ({
        backingId: backing.id,
        backingToken: tabBackingToken(backing),
        spaceId,
        windowId,
        url: backing.url,
      });
      const claim = async (tabId: number, location: TabBackingLocation) => {
        claimedBackingIds.add(location.backingId);
        claimedBackingTokens.add(location.backingToken);
        dependencies.tabBackingLocations.set(tabId, location);
        await dependencies.persistTabOwnership(tabId, location);
      };

      for (const tab of existingTabs) {
        if (!shouldContinue()) return [];
        const ownership = allOwnerships.get(tab.id as number);
        const identity = tabPageIdentity(tab);
        const backing = ownership?.spaceId === spaceId && ownership.backingId
          ? backings.find((candidate) => candidate.id === ownership.backingId)
          : backings.find((candidate) =>
              !claimedBackingIds.has(candidate.id) &&
              !claimedBackingTokens.has(tabBackingToken(candidate) ?? '') &&
              pageIdentity(candidate.url) === identity,
            );
        const location = await ensureTabBackingBookmark(
          tab,
          spaceId,
          backing ? backingLocation(backing) : ownership,
          claimedBackingIds,
          claimedBackingTokens,
        );
        if (location && tab.id !== undefined) await claim(tab.id, location);
      }

      const createdIds: number[] = [];
      const createdRestores: Array<{
        backingId: string;
        backingToken?: string;
        tabId: number;
        url?: string;
      }> = [];
      let restoreOperation: DurableOperation | undefined;
      const beginRestoreOperation = async () => {
        if (restoreOperation) return;
        const operationId = crypto.randomUUID();
        restoreOperation = {
          completionProof: { spaceId, windowId },
          id: operationId,
          idempotencyKey: `restore-space-tabs:${spaceId}:${windowId}`,
          kind: 'restore-space-tabs',
          payload: {
            createdTabs: createdRestores,
            requestedBackings: backings.map((backing) => ({
              backingId: backing.id,
              backingToken: tabBackingToken(backing),
              url: backing.url,
            })),
            spaceId,
            windowId,
          },
          phase: 'prepared',
          recovery: 'abandon',
          startedAt: Date.now(),
          updatedAt: Date.now(),
        };
        await beginDurableOperation(restoreOperation);
      };
      for (const backing of backings) {
        if (!shouldContinue()) return createdIds;
        const token = tabBackingToken(backing);
        if (
          !backing.url ||
          claimedBackingIds.has(backing.id) ||
          (token && claimedBackingTokens.has(token))
        ) continue;
        const backingIdentity = { backingId: backing.id, backingToken: token };
        await beginRestoreOperation();
        const operation = restoreOperation;
        if (!operation) throw new Error('The tab restoration journal is unavailable.');
        // A closed tab is no longer live, though its backing stays until its release runs.
        const claimed = await dependencies.backingClaimedByAnotherLiveTab(-1, backingIdentity) ||
          await dependencies.backingClosing(backingIdentity);
        if (!shouldContinue() || claimed) continue;
        const tab = await browser.tabs.create({ active: false, windowId, url: backing.url });
        if (tab.id === undefined) continue;
        createdRestores.push({
          backingId: backing.id,
          ...(token ? { backingToken: token } : {}),
          tabId: tab.id,
          ...(backing.url ? { url: backing.url } : {}),
        });
        await advanceDurableOperation(operation.id, 'effect-applied', {
          payload: {
            ...operation.payload,
            createdTabs: createdRestores,
          },
        });
        const discard = () => browser.tabs.remove(tab.id!).catch(() => undefined);
        if (!shouldContinue()) return discard().then(() => createdIds);
        const backingClaimed = await dependencies.backingClaimedByAnotherLiveTab(
          tab.id,
          backingIdentity,
        );
        if (!shouldContinue()) return discard().then(() => createdIds);
        if (backingClaimed) {
          await discard();
          continue;
        }
        dependencies.markIntentionalTab(tab.id);
        const location = await ensureTabBackingBookmark(
          tab,
          spaceId,
          backingLocation(backing),
          claimedBackingIds,
          claimedBackingTokens,
        );
        if (!shouldContinue()) return discard().then(() => createdIds);
        if (location) await claim(tab.id, location);
        createdIds.push(tab.id);
      }
      if (restoreOperation) {
        await advanceDurableOperation(restoreOperation.id, 'verifying', {
          completionProof: {
            createdTabCount: createdRestores.length,
            spaceId,
            windowId,
          },
        });
        await completeDurableOperation(restoreOperation.id);
      }
      return createdIds;
    },
  );
}
