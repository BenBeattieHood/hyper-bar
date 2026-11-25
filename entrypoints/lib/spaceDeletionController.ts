import { withNamedAsyncLock } from './async';
import {
  deriveSpaces,
  isSpaceBookmarksFolder,
  neighbourShownSpace,
  shownSpaces,
  isSpaceTabsFolder,
  visibleBookmarkTitle,
  type BrowserTab,
} from './bookmarks';
import { bookmarkById, ensureHyperBookmarkStructure, ensureSpaceBookmarksFolder } from './bookmarkStorage';
import type { DeleteSpacePayload } from './modelIntentPayloads';
import {
  advanceDurableOperation,
  beginDurableOperation,
  completeDurableOperation,
  type DurableOperation,
} from './operationJournal';
import {
  deleteSpacePostconditionViolations,
  moveSpaceBookmarks,
  ownedTabIdsForSpace,
  provisionalSpaceInfrastructureIds,
  releaseAndRemoveSpaceGroupMappings,
  spaceGroupMappingsForSpace,
} from './spaceDeletion';
import type { SpaceDeletionBrowserPort } from './spaceDeletionBrowser';
import { loadTabOwnerships } from './tabOwnership';
import { getWindowActiveSpaceId, removeWindowActiveSpaceId } from './windowState';

const MAX_LATE_TAB_SWEEPS = 3;
const PROVISIONAL_CHANGED = 'The provisional space changed before it could be removed.';

export interface SpaceDeletionControllerDependencies {
  /** Changes whenever a bookmark is created, moved, or removed outside this deletion. */
  bookmarkLifecycleGeneration(): number;
  closeTabs(tabIds: number[]): Promise<void>;
  persistWindowActiveSpace(windowId: number, spaceId: string): Promise<void>;
  port: SpaceDeletionBrowserPort;
}

async function spaceTabIds(spaceId: string, tabs?: BrowserTab[]): Promise<number[]> {
  const liveTabs = tabs ?? await browser.tabs.query({});
  const ownerships = await loadTabOwnerships(liveTabs);
  return ownedTabIdsForSpace(
    liveTabs.map((tab) => ({ tab, ownership: tab.id === undefined ? undefined : ownerships[tab.id] })),
    spaceId,
  );
}

/**
 * Deletes a space as one journalled operation: windows showing it move to a
 * neighbour, its tabs close (including any that join it meanwhile), its groups
 * are released, and only then is its bookmark folder removed and verified.
 * Bookmarks asked to be kept move to the first other space before any of that.
 */
export function createSpaceDeletionController(dependencies: SpaceDeletionControllerDependencies) {
  const { port } = dependencies;

  /**
   * A just-created space is removed only while it is still the empty shell it
   * was created as; any user change in between keeps it.
   */
  const removeProvisionalSpace = async (spaceId: string, expectedTitle: string) => {
    const infrastructureIds = await provisionalSpaceInfrastructureIds(spaceId, expectedTitle, port);
    if (!infrastructureIds) throw new Error(PROVISIONAL_CHANGED);
    const stillProvisional = async (folderId?: string) => {
      const generation = dependencies.bookmarkLifecycleGeneration();
      const [space, folder, children] = await Promise.all([
        bookmarkById(spaceId),
        bookmarkById(folderId),
        browser.bookmarks.getChildren(folderId ?? spaceId).catch(() => []),
      ]);
      return generation === dependencies.bookmarkLifecycleGeneration() &&
        space !== undefined &&
        visibleBookmarkTitle(space) === expectedTitle &&
        children.length === 0 &&
        (folderId === undefined || (
          folder?.parentId === spaceId &&
          (isSpaceTabsFolder(folder) || isSpaceBookmarksFolder(folder))
        ));
    };
    for (const infrastructureId of infrastructureIds) {
      if (!await stillProvisional(infrastructureId)) throw new Error(PROVISIONAL_CHANGED);
      await browser.bookmarks.remove(infrastructureId);
    }
    if (!await stillProvisional()) throw new Error(PROVISIONAL_CHANGED);
    await browser.bookmarks.remove(spaceId);
  };

  const deleteSpace = (
    { expectedProvisionalTitle, moveBookmarks, spaceId }: DeleteSpacePayload,
    currentWindowId?: number,
  ): Promise<{ activeSpaceId: string }> => withNamedAsyncLock(
    `hyper:space-mutation:${spaceId}`,
    async () => {
      await ensureHyperBookmarkStructure();
      const [tree, tabs, windows] = await Promise.all([
        browser.bookmarks.getTree(),
        browser.tabs.query({}),
        browser.windows.getAll(),
      ]);
      const spaces = deriveSpaces(tree);
      const sourceIndex = spaces.findIndex((space) => space.id === spaceId);
      if (sourceIndex < 0) throw new Error('This space no longer exists.');
      if (spaces.length <= 1) throw new Error('At least one space is required.');
      const shown = shownSpaces(spaces);
      const windowIds = windows.flatMap((window) => window.id === undefined ? [] : [window.id]);
      const activeSpaceIds = new Map(await Promise.all(windowIds.map(async (windowId) =>
        [windowId, await getWindowActiveSpaceId(windowId)] as const,
      )));
      const currentActiveSpaceId = currentWindowId === undefined
        ? undefined
        : activeSpaceIds.get(currentWindowId);
      // Windows go to a space they can show, so deleting the last unarchived space is refused here.
      const targetSpace = (currentActiveSpaceId !== spaceId
        ? shown.find((space) => space.id === currentActiveSpaceId)
        : undefined) ?? neighbourShownSpace(spaces, spaceId);
      if (!targetSpace) throw new Error('At least one space must stay unarchived.');
      if (await provisionalSpaceInfrastructureIds(spaceId, expectedProvisionalTitle, port) === undefined) {
        throw new Error(PROVISIONAL_CHANGED);
      }
      const source = spaces[sourceIndex];
      const defaultSpace = shown.find((space) => space.id !== spaceId);
      if (moveBookmarks && source && defaultSpace) {
        await moveSpaceBookmarks(source, {
          children: defaultSpace.children,
          rootId: defaultSpace.rootId ?? (await ensureSpaceBookmarksFolder(defaultSpace.id)).id,
        }, port);
      }

      const sourceGroupMappings = spaceGroupMappingsForSpace(await port.readSession(), spaceId);
      const ownerships = await loadTabOwnerships(tabs);
      const sourceTabIds = new Set(await spaceTabIds(spaceId, tabs));
      const operationId = crypto.randomUUID();
      const deleteOperation: DurableOperation = {
        completionProof: {
          sourceSpaceId: spaceId,
          sourceSpaceRemoved: true,
          targetSpaceId: targetSpace.id,
        },
        id: operationId,
        idempotencyKey: `delete-space:${spaceId}`,
        kind: 'delete-space',
        payload: {
          activeSpaceIds: Object.fromEntries(activeSpaceIds),
          groupOwnershipKeys: sourceGroupMappings.map(({ key }) => key),
          sourceSpaceId: spaceId,
          sourceTabs: tabs.flatMap((tab) => tab.id !== undefined && sourceTabIds.has(tab.id)
            ? [{
                backingId: ownerships[tab.id]?.backingId,
                backingToken: ownerships[tab.id]?.backingToken,
                tabId: tab.id,
                windowId: tab.windowId,
              }]
            : []),
          targetSpaceId: targetSpace.id,
        },
        phase: 'prepared',
        recovery: 'abandon',
        startedAt: Date.now(),
        updatedAt: Date.now(),
      };
      await beginDurableOperation(deleteOperation);

      const replacedWindowIds = windowIds.filter((windowId) => {
        const activeSpaceId = activeSpaceIds.get(windowId);
        return activeSpaceId === spaceId || !shown.some((space) => space.id === activeSpaceId);
      });
      try {
        await Promise.all(replacedWindowIds.map((windowId) =>
          dependencies.persistWindowActiveSpace(windowId, targetSpace.id)));
        const closedTabIds = new Set(sourceTabIds);
        await dependencies.closeTabs([...closedTabIds]);
        for (let attempt = 0; attempt < MAX_LATE_TAB_SWEEPS; attempt += 1) {
          const lateSourceTabIds = await spaceTabIds(spaceId);
          if (lateSourceTabIds.length === 0) break;
          if (attempt === MAX_LATE_TAB_SWEEPS - 1) {
            throw new Error('A live tab joined the space while it was being deleted.');
          }
          for (const tabId of lateSourceTabIds) closedTabIds.add(tabId);
          await dependencies.closeTabs(lateSourceTabIds);
        }
        const releasedGroupIds = await releaseAndRemoveSpaceGroupMappings(sourceGroupMappings, port);
        await advanceDurableOperation(operationId, 'effect-applied', {
          payload: {
            ...deleteOperation.payload,
            closedTabIds: [...closedTabIds],
            releasedGroupIds,
          },
        });
        await advanceDurableOperation(operationId, 'verifying', {
          completionProof: deleteOperation.completionProof,
        });
        if (expectedProvisionalTitle === undefined) {
          await browser.bookmarks.removeTree(spaceId);
        } else {
          await removeProvisionalSpace(spaceId, expectedProvisionalTitle);
        }
        const removedSpace = await bookmarkById(spaceId);
        if (removedSpace) throw new Error('The deleted space is still present.');
        const violations = await deleteSpacePostconditionViolations({
          ownedTabIds: [...closedTabIds],
          releasedGroupIds,
          spaceRootId: spaceId,
        }, port);
        if (violations.length > 0) {
          throw new Error(`The deleted space could not be verified: ${violations.join('; ')}.`);
        }
      } catch (error) {
        await Promise.all(replacedWindowIds.map(async (windowId) => {
          const previousSpaceId = activeSpaceIds.get(windowId);
          if (previousSpaceId) {
            await dependencies.persistWindowActiveSpace(windowId, previousSpaceId).catch(() => undefined);
          } else {
            await removeWindowActiveSpaceId(windowId).catch(() => undefined);
          }
        }));
        throw error;
      }

      await completeDurableOperation(operationId);
      return {
        activeSpaceId: currentActiveSpaceId !== spaceId &&
          shown.some((space) => space.id === currentActiveSpaceId)
          ? currentActiveSpaceId as string
          : targetSpace.id,
      };
    },
  );

  return { deleteSpace };
}
