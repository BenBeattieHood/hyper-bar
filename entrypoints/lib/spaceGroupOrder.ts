import {
  deriveSpaces,
  findHyperBookmarkStructure,
  type Space,
} from './bookmarks';
import { runConcurrentOperations } from './async';
import { windowSpaceGroups } from './spaceGroupStore';
import {
  hyperGroupTitle,
  nativeTabGroups,
  ownedTabGroupOrder,
  spaceBookmarkMovesForOrder,
  spaceOrderMatchingTabGroups,
  withHyperGroupLock,
  type ProgrammaticGroupUpdates,
} from './tabGroups';

export type SpaceGroupOrderDependencies = ProgrammaticGroupUpdates;

/**
 * Keeps native group order and ordinal titles in step with the durable space
 * order, and lets dragging a Hyper group reorder the spaces themselves.
 */
export function createSpaceGroupOrder(dependencies: SpaceGroupOrderDependencies) {
  const reconcileWindow = async (spaces: readonly Space[], windowId: number) => {
    const groups = nativeTabGroups('move', 'query', 'update');
    if (!groups) return;
    const groupIdBySpace = await windowSpaceGroups(windowId);
    const desiredGroupIds = spaces.flatMap((space) => {
      const groupId = groupIdBySpace.get(space.id);
      return groupId === undefined ? [] : [groupId];
    });
    const liveGroupIds = new Set(ownedTabGroupOrder(desiredGroupIds, await browser.tabs.query({ windowId })));
    const liveDesiredGroupIds = desiredGroupIds.filter((groupId) => liveGroupIds.has(groupId));
    if (liveDesiredGroupIds.length === 0) return;

    await withHyperGroupLock(windowId, async () => {
      for (const [targetOrder, groupId] of liveDesiredGroupIds.entries()) {
        const tabs = await browser.tabs.query({ windowId });
        const currentOrder = ownedTabGroupOrder(liveDesiredGroupIds, tabs);
        if (currentOrder[targetOrder] === groupId) continue;
        const targetGroupId = currentOrder[targetOrder];
        const targetIndex = Math.min(...tabs.flatMap((tab) =>
          tab.groupId === targetGroupId ? [tab.index] : []));
        if (Number.isFinite(targetIndex)) await groups.move(groupId, { index: targetIndex });
      }
      const orderedGroupIds = new Set(ownedTabGroupOrder(
        liveDesiredGroupIds,
        await browser.tabs.query({ windowId }),
      ));
      const titleById = new Map((await groups.query({ windowId })).map((group) => [group.id, group.title]));
      for (const [spaceIndex, space] of spaces.entries()) {
        const groupId = groupIdBySpace.get(space.id);
        const title = hyperGroupTitle(spaceIndex);
        if (groupId === undefined || !orderedGroupIds.has(groupId) || titleById.get(groupId) === title) continue;
        dependencies.beginProgrammaticGroupUpdate(groupId);
        try {
          await groups.update(groupId, { title });
        } finally {
          await dependencies.endProgrammaticGroupUpdate(groupId);
        }
      }
    });
  };

  const reconcileAll = async (spaces: readonly Space[]): Promise<void> => {
    const windows = await browser.windows.getAll();
    await runConcurrentOperations(
      windows.flatMap((window) => window.id === undefined ? [] : [window.id]),
      (windowId) => reconcileWindow(spaces, windowId),
      'Unable to reconcile tab group order in every window.',
    );
  };

  return {
    reconcileAll,
    /** A Hyper group moved in one window moves its space, and so every other window's group. */
    async reorderSpacesFromWindow(windowId: number): Promise<void> {
      const bookmarkTree = await browser.bookmarks.getTree();
      const structure = findHyperBookmarkStructure(bookmarkTree);
      if (!structure) return;
      const spaces = deriveSpaces(bookmarkTree);
      const spaceIds = spaces.map((space) => space.id);
      const moves = spaceBookmarkMovesForOrder(spaceIds, spaceOrderMatchingTabGroups(
        spaceIds,
        await windowSpaceGroups(windowId),
        await browser.tabs.query({ windowId }),
      ));
      if (moves.length === 0) return;
      for (const move of moves) {
        await browser.bookmarks.move(move.spaceId, { parentId: structure.spaces.id, index: move.index });
      }
      await reconcileAll(deriveSpaces(await browser.bookmarks.getTree()));
    },
  };
}

export type SpaceGroupOrder = ReturnType<typeof createSpaceGroupOrder>;
