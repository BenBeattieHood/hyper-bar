import { retainRecentEntries } from './tabs';

interface ExpandedGroup {
  collapsed: boolean;
  id: number;
  windowId: number;
}

export interface SpaceGroupExpansionDependencies {
  activateSpaceGroup(group: ExpandedGroup): Promise<void>;
  activationTokens: ReadonlyMap<number, string>;
  isSwitching(windowId: number): boolean;
  maxTrackedGroups: number;
  queueActivation(operation: () => Promise<void>): void;
  startupRecoveryInProgress(): boolean;
}

/**
 * Tells the user expanding a space's group, which selects that space, apart
 * from Hyper expanding and collapsing groups itself.
 */
export function createSpaceGroupExpansion(dependencies: SpaceGroupExpansionDependencies) {
  const programmaticGroupUpdates = new Map<number, {
    depth: number;
    ending: boolean;
    sawExpansion: boolean;
  }>();
  const groupUpdateGenerations = new Map<number, number>();

  const beginProgrammaticGroupUpdate = (groupId: number) => {
    const update = programmaticGroupUpdates.get(groupId);
    if (update) {
      update.depth += 1;
      update.ending = false;
    } else {
      programmaticGroupUpdates.set(groupId, {
        depth: 1,
        ending: false,
        sawExpansion: false,
      });
    }
  };

  const endProgrammaticGroupUpdate = async (groupId: number) => {
    const update = programmaticGroupUpdates.get(groupId);
    if (!update) return;
    update.depth = Math.max(0, update.depth - 1);
    if (update.depth > 0) return;
    update.ending = true;
    if (update.sawExpansion) {
      programmaticGroupUpdates.delete(groupId);
      return;
    }
    const group = await browser.tabGroups?.get(groupId).catch(() => undefined);
    if (programmaticGroupUpdates.get(groupId) === update && (!group || group.collapsed)) {
      programmaticGroupUpdates.delete(groupId);
    }
  };

  const groupUpdated = (group: ExpandedGroup) => {
    const updateGeneration = (groupUpdateGenerations.get(group.id) ?? 0) + 1;
    groupUpdateGenerations.set(group.id, updateGeneration);
    retainRecentEntries(groupUpdateGenerations, dependencies.maxTrackedGroups);
    const activationToken = dependencies.activationTokens.get(group.windowId);
    const programmaticUpdate = programmaticGroupUpdates.get(group.id);
    if (group.collapsed) {
      if (programmaticUpdate?.ending) programmaticGroupUpdates.delete(group.id);
      return;
    }
    if (programmaticUpdate) {
      programmaticUpdate.sawExpansion = true;
      if (programmaticUpdate.ending) programmaticGroupUpdates.delete(group.id);
      return;
    }
    if (dependencies.isSwitching(group.windowId)) return;
    if (dependencies.startupRecoveryInProgress()) return;
    dependencies.queueActivation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      if (
        groupUpdateGenerations.get(group.id) !== updateGeneration ||
        dependencies.activationTokens.get(group.windowId) !== activationToken
      ) return;
      const currentGroup = await browser.tabGroups?.get(group.id).catch(() => undefined);
      if (
        groupUpdateGenerations.get(group.id) !== updateGeneration ||
        dependencies.activationTokens.get(group.windowId) !== activationToken ||
        !currentGroup ||
        currentGroup.windowId !== group.windowId ||
        currentGroup.collapsed
      ) return;
      await dependencies.activateSpaceGroup(currentGroup);
    });
  };

  return { beginProgrammaticGroupUpdate, endProgrammaticGroupUpdate, groupUpdated };
}
