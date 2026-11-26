import { createKeyedSerialRunner } from './async';
import {
  deriveSpaces,
  openableSpace,
  spaceLastActiveTabToken,
  tabBackingToken,
  type BrowserTab,
  type Space,
} from './bookmarks';
import {
  adoptParkedTabBackings,
  bookmarkById,
  hasParkedTabBackings,
  windowTabBackings,
} from './bookmarkStorage';
import { addToMapList } from './collections';
import { rememberActiveTab } from './lastActiveTab';
import { SupersededTargetError, spaceTarget } from './modelGuards';
import { userNewTabShownMessageType } from './pageShortcut';
import { createSelfActivationLedger } from './selfActivation';
import { planLiveSpaceActivation } from './spaceActivationPlan';
import { newSpaceGroupColour } from './spaceGroupColours';
import {
  findHyperGroupsForSpace,
  hyperGroupTitle,
  resolveHyperGroupForSpace,
  tabGroupApi,
  withHyperGroupLock,
  type ProgrammaticGroupUpdates,
  type TabGroupChanges,
} from './tabGroups';
import {
  focusTabInWindow,
  isBlankTabPage,
  moveTabsPreservingActive,
  resolveSpaceRestoreGroup,
  spaceRestoreCandidates,
  spaceTabActivationTarget,
  unplacedTabIds,
  waitForStableTabSnapshot,
} from './tabs';
import { loadTabOwnerships } from './tabOwnership';
import { pageIdentity, tabPageIdentity, tabUrl } from './urlIdentity';
import { getWindowActiveSpaceId, normalWindowIds, removeWindowActiveSpaceId } from './windowState';
import {
  forgetSpaceGroup,
  forgetWindowSpaceGroups,
  rememberSpaceGroup,
  spaceGroupId,
  spaceGroupKey,
  windowSpaceGroups,
} from './spaceGroupStore';

export interface OwnedGroup {
  collapsed: boolean;
  id: number;
  windowId: number;
}

export interface SpaceSwitchDependencies extends ProgrammaticGroupUpdates {
  /** Expands, records, and collapses around a tab already focused in place. */
  activateLiveGroup(group: OwnedGroup, token: string, tabId: number): Promise<void>;
  activationTokens: Map<number, string>;
  /** Whether a closed tab's backing is still waiting to be removed, so its tab is not coming back. */
  backingClosing(backing: { backingId: string; backingToken?: string }): Promise<boolean>;
  /** False while the browser restores tabs that may claim parked backings themselves. */
  canAdoptParkedTabs(): boolean;
  disposeSpaceNewTabs(spaceId: string, windowId: number, token: string): Promise<void>;
  persistWindowActiveSpace(windowId: number, spaceId: string): Promise<void>;
  restoreSpaceTabs(
    spaceId: string,
    windowId: number,
    candidateTabIds: number[],
    groupId: number | undefined,
    token: string,
  ): Promise<number[]>;
  routeTabToSpace(tabId: number, spaceId: string): Promise<void>;
  /** The order the space's tabs in a window take in the tab strip, or none while the strip keeps its own. */
  spaceTabStripOrder(spaceId: string, windowId: number): Promise<number[]>;
}

const wait = (durationMs: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, durationMs));

/** What a space with no tab in the window gets: nothing, a new blank tab, or the focused new tab page. */
type EmptySpaceTab = 'none' | 'open' | 'take';

/**
 * Switches a window to a space from the background, where browser effects live.
 *
 * Every activation this causes is recorded before its browser call, so the
 * activation listener can tell the switch's own focus changes from the user's:
 * a claimed activation is not remembered as the space's last-used tab, while an
 * unclaimed one is the user's, supersedes the switch, and stands.
 */
export function createSpaceSwitchController(dependencies: SpaceSwitchDependencies) {
  const ledger = createSelfActivationLedger();
  const switching = new Map<number, string>();
  const latestAdmissions = new Map<number, string>();
  const provisionalTabIds = new Set<number>();
  const serialGroupRecovery = createKeyedSerialRunner<string>();
  const serialGroupEnsure = createKeyedSerialRunner<string>();

  const supersede = (windowId: number) => {
    dependencies.activationTokens.set(windowId, crypto.randomUUID());
  };

  const updateGroup = async (windowId: number, groupId: number, changes: TabGroupChanges) => {
    const groups = tabGroupApi();
    if (!groups) return;
    const activeTab = changes.collapsed === true
      ? (await browser.tabs.query({ active: true, windowId }))[0]
      : undefined;
    // Only a collapse that swallows the active tab can move focus.
    if (activeTab?.groupId !== groupId) {
      await groups.update(groupId, changes);
      return;
    }
    const release = ledger.expectDisplacement(windowId);
    let displaced = false;
    try {
      await groups.update(groupId, changes);
      const [current] = await browser.tabs.query({ active: true, windowId });
      displaced = current?.id !== activeTab.id;
    } finally {
      release(displaced);
    }
  };

  const otherOwnedGroupIds = async (spaceId: string, windowId: number) =>
    new Set([...await windowSpaceGroups(windowId)].flatMap(([ownerId, groupId]) =>
      ownerId === spaceId ? [] : [groupId]));

  const findSpaceGroupNow = async (
    space: Space,
    windowTabs: BrowserTab[],
  ): Promise<number | undefined> => {
    const groups = tabGroupApi();
    const windowId = windowTabs[0]?.windowId;
    if (!groups || windowId === undefined) return undefined;
    const cachedId = await spaceGroupId(space.id, windowId);
    const liveGroups = await groups.query(windowId);
    const cachedGroup = cachedId === undefined
      ? undefined
      : liveGroups.find((group) => group.id === cachedId);
    if (cachedId !== undefined && !cachedGroup) await forgetSpaceGroup(space.id, windowId);
    const claimedGroupIds = await otherOwnedGroupIds(space.id, windowId);
    const activeGroupId = windowTabs.find((tab) => tab.active)?.groupId;
    const resolution = resolveHyperGroupForSpace(
      liveGroups,
      space.index,
      cachedGroup?.id,
      [activeGroupId].filter((id): id is number => id !== undefined && id >= 0),
      claimedGroupIds,
    );
    const ownedGroup = resolution.group;
    if (!ownedGroup) return undefined;
    const duplicateGroupIds = resolution.recovered
      ? new Set(findHyperGroupsForSpace(liveGroups, space.index).flatMap((group) =>
          group.id === ownedGroup.id || claimedGroupIds.has(group.id) ? [] : [group.id]))
      : new Set<number>();
    const duplicateTabIds = windowTabs.flatMap((tab) =>
      tab.id !== undefined && duplicateGroupIds.has(tab.groupId) ? [tab.id] : []);
    if (duplicateTabIds.length > 0) {
      dependencies.beginProgrammaticGroupUpdate(ownedGroup.id);
      try {
        await groups.group({ groupId: ownedGroup.id, tabIds: duplicateTabIds });
        await updateGroup(windowId, ownedGroup.id, { collapsed: ownedGroup.collapsed });
      } finally {
        await dependencies.endProgrammaticGroupUpdate(ownedGroup.id);
      }
    }
    await rememberSpaceGroup(space.id, windowId, ownedGroup.id);
    return ownedGroup.id;
  };

  const findSpaceGroup = async (space: Space, windowTabs: BrowserTab[]) => {
    const windowId = windowTabs[0]?.windowId;
    if (windowId === undefined) return undefined;
    return serialGroupRecovery(spaceGroupKey(space.id, windowId), () => findSpaceGroupNow(space, windowTabs));
  };

  const restoreTabGrouping = async (originalGroupIds: ReadonlyMap<number, number>) => {
    const groups = tabGroupApi();
    if (!groups) return;
    const ungrouped: number[] = [];
    const grouped = new Map<number, number[]>();
    for (const [tabId, groupId] of originalGroupIds) {
      if (groupId < 0) ungrouped.push(tabId);
      else addToMapList(grouped, groupId, tabId);
    }
    await Promise.allSettled([
      ...(ungrouped.length > 0 ? [groups.ungroup(ungrouped)] : []),
      ...[...grouped].map(([groupId, tabIds]) => groups.group({ groupId, tabIds })),
    ]);
  };

  const ensureSpaceGroupNow = async (
    space: Space,
    windowTabs: BrowserTab[],
    additionalTabIds: number[],
    shouldContinue: () => boolean,
  ): Promise<number | undefined> => {
    const groups = tabGroupApi();
    const windowId = windowTabs[0]?.windowId;
    if (!groups || windowId === undefined) return undefined;
    let groupId = await findSpaceGroup(space, windowTabs);
    if (!shouldContinue()) return undefined;
    const existingGroup = groupId !== undefined;
    const keys = new Set((await windowTabBackings(space.id, windowId))
      .flatMap((node) => pageIdentity(node.url) ?? []));
    const matchingIds = windowTabs.flatMap((tab) =>
      !tab.pinned &&
      tab.id !== undefined &&
      (tab.groupId < 0 || tab.groupId === groupId) &&
      keys.has(tabPageIdentity(tab) ?? '')
        ? [tab.id]
        : []);
    const tabIds = [...new Set([...matchingIds, ...additionalTabIds])];
    const originalGroupIds = new Map(windowTabs.flatMap((tab) =>
      tab.id !== undefined && tabIds.includes(tab.id) ? [[tab.id, tab.groupId] as const] : []));
    let groupedTabs = false;
    try {
      if (tabIds.length > 0) {
        groupId = await groups.group({
          tabIds,
          // A new group otherwise opens in the last focused window, taking the tabs with it.
          ...(groupId !== undefined ? { groupId } : { createProperties: { windowId } }),
        });
        groupedTabs = true;
        if (!shouldContinue()) {
          await restoreTabGrouping(originalGroupIds);
          return undefined;
        }
      }
      if (groupId === undefined) return undefined;
      await updateGroup(windowId, groupId, {
        collapsed: false,
        title: hyperGroupTitle(space.index),
        ...(!existingGroup ? { color: await newSpaceGroupColour(space.id, windowId) } : {}),
      });
      await rememberSpaceGroup(space.id, windowId, groupId);
      if (!shouldContinue()) {
        if (!existingGroup) await forgetSpaceGroup(space.id, windowId);
        if (groupedTabs) await restoreTabGrouping(originalGroupIds);
        return undefined;
      }
      return groupId;
    } catch (error) {
      if (groupedTabs) await restoreTabGrouping(originalGroupIds);
      throw error;
    }
  };

  const ensureSpaceGroup = async (
    space: Space,
    windowTabs: BrowserTab[],
    additionalTabIds: number[],
    shouldContinue: () => boolean,
  ) => {
    const windowId = windowTabs[0]?.windowId;
    if (windowId === undefined) return undefined;
    return serialGroupEnsure(spaceGroupKey(space.id, windowId), async () => shouldContinue()
      ? withHyperGroupLock(windowId, () =>
          ensureSpaceGroupNow(space, windowTabs, additionalTabIds, shouldContinue))
      : undefined);
  };

  const restoreMissingSpaceTabs = async (
    space: Space,
    windowTabs: BrowserTab[],
    claimUnowned: boolean,
    shouldContinue: () => boolean,
    recoverGroup: boolean,
    token: string,
  ): Promise<number[]> => {
    const windowId = windowTabs[0]?.windowId;
    if (windowTabs[0]?.incognito || windowId === undefined) return [];
    const groups = tabGroupApi();
    // A backing whose tab the user just closed waits only for its release.
    const awaitsRestoredTab = async () => {
      for (const backing of await windowTabBackings(space.id, windowId)) {
        if (!await dependencies.backingClosing({
          backingId: backing.id,
          backingToken: tabBackingToken(backing),
        })) return true;
      }
      return false;
    };
    const resolution = await resolveSpaceRestoreGroup(
      windowTabs,
      (tabs) => groups ? findSpaceGroup(space, tabs) : Promise.resolve(undefined),
      () => browser.tabs.query({ windowId }),
      {
        awaitsRestoredTab,
        recoverGroup: recoverGroup && groups !== undefined,
        shouldContinue,
        wait,
      },
    );
    if (!shouldContinue() || !resolution.canRestore) return [];
    const { groupId } = resolution;
    if (groups && groupId !== undefined) {
      dependencies.beginProgrammaticGroupUpdate(groupId);
      try {
        await groups.update(groupId, { collapsed: false });
        await waitForStableTabSnapshot(
          () => browser.tabs.query({ groupId }),
          { shouldContinue, wait },
        );
      } finally {
        await dependencies.endProgrammaticGroupUpdate(groupId);
      }
    }
    if (!shouldContinue()) return [];
    const allTabs = await browser.tabs.query({});
    const candidates = spaceRestoreCandidates(allTabs, await loadTabOwnerships(allTabs), {
      claimUnowned,
      groupId,
      spaceId: space.id,
      windowId,
    });
    return dependencies.restoreSpaceTabs(
      space.id,
      windowId,
      candidates.flatMap((tab) => tab.id === undefined ? [] : [tab.id]),
      groupId,
      token,
    );
  };

  const restoreSpaceTabOrder = async (
    space: Space,
    windowId: number,
    shouldContinue: () => boolean,
  ) => {
    const order = await dependencies.spaceTabStripOrder(space.id, windowId);
    const tabs = await browser.tabs.query({ windowId });
    const tabsById = new Map(tabs.map((tab) => [tab.id, tab]));
    const orderedTabs = order.flatMap((tabId) => {
      const tab = tabsById.get(tabId);
      return tab ? [tab] : [];
    });
    if (orderedTabs.length < 2) return;
    await moveTabsPreservingActive(
      orderedTabs.map((tab) => tab.id as number),
      windowId,
      Math.min(...orderedTabs.map((tab) => tab.index)),
      undefined,
      shouldContinue,
    );
  };

  /** A blank tab for a space that has none; its unnamed activation is Hyper's own. */
  const createProvisionalTab = async (windowId: number) => {
    const release = ledger.expectDisplacement(windowId);
    try {
      const tab = await browser.tabs.create({ active: true, windowId });
      if (tab.id !== undefined) provisionalTabIds.add(tab.id);
      return tab;
    } finally {
      release(true);
    }
  };

  /** A tab no space owns yet, or one just dragged in from another window, is still being placed. */
  const hasUnplacedTab = async (windowId: number) => {
    const tabs = await browser.tabs.query({ windowId });
    return unplacedTabIds(tabs, await loadTabOwnerships(tabs), browser.runtime.getURL('')).length > 0;
  };

  const focusedNewTab = async (windowId: number) => {
    const [tab] = await browser.tabs.query({ active: true, windowId });
    return tab?.id !== undefined && !tab.pinned &&
      isBlankTabPage(tabUrl(tab), browser.runtime.getURL('/newtab.html'))
      ? tab
      : undefined;
  };

  const focusTab = (tabId: number, windowId: number, shouldContinue: () => boolean) => {
    ledger.expectActivation(windowId, tabId);
    return focusTabInWindow(tabId, windowId, windowId, browser, async () => shouldContinue());
  };

  const activateUngroupedSpace = async (
    space: Space,
    windowId: number,
    rememberedBackingToken: string | undefined,
    preferActiveTab: boolean,
    emptySpaceTab: EmptySpaceTab,
    shouldContinue: () => boolean,
    token: string,
  ) => {
    const windowTabs = await browser.tabs.query({ windowId });
    await restoreMissingSpaceTabs(space, windowTabs, true, shouldContinue, false, token);
    if (!shouldContinue()) return;
    await restoreSpaceTabOrder(space, windowId, shouldContinue);
    if (!shouldContinue()) return;
    const refreshedTabs = await browser.tabs.query({ windowId });
    const ownerships = await loadTabOwnerships(refreshedTabs);
    let targetTabs = refreshedTabs.filter((tab) =>
      tab.id !== undefined && ownerships[tab.id]?.spaceId === space.id);
    let provisionalTabId: number | undefined;
    try {
      if (targetTabs.length === 0) {
        if (emptySpaceTab === 'none' || !shouldContinue()) return;
        const taken = emptySpaceTab === 'take' ? await focusedNewTab(windowId) : undefined;
        const tab = taken ?? await createProvisionalTab(windowId);
        if (tab.id === undefined) return;
        if (!taken) provisionalTabId = tab.id;
        if (!shouldContinue()) return;
        await dependencies.routeTabToSpace(tab.id, space.id);
        if (!shouldContinue()) return;
        targetTabs = [tab];
      }
      const target = spaceTabActivationTarget(
        targetTabs,
        await loadTabOwnerships(targetTabs),
        rememberedBackingToken,
        preferActiveTab,
      );
      if (!shouldContinue()) return;
      if (target?.id !== undefined && !target.active) await focusTab(target.id, windowId, shouldContinue);
      provisionalTabId = undefined;
    } finally {
      if (provisionalTabId !== undefined) {
        await browser.tabs.remove(provisionalTabId).catch(() => undefined);
      }
    }
  };

  const activateGroupedSpace = async (
    space: Space,
    windowId: number,
    shouldContinue: () => boolean,
    recoverGroup: boolean,
    emptySpaceTab: EmptySpaceTab,
    token: string,
  ): Promise<number | undefined> => {
    let provisionalTabId: number | undefined;
    let committed = false;
    try {
      const restoredTabIds = await restoreMissingSpaceTabs(
        space,
        await browser.tabs.query({ windowId }),
        false,
        shouldContinue,
        recoverGroup,
        token,
      );
      if (!shouldContinue()) return undefined;
      let groupId = await ensureSpaceGroup(
        space,
        await browser.tabs.query({ windowId }),
        restoredTabIds,
        shouldContinue,
      );
      if (!shouldContinue()) return undefined;
      if (groupId === undefined) {
        if (emptySpaceTab === 'none') return undefined;
        const taken = emptySpaceTab === 'take' ? await focusedNewTab(windowId) : undefined;
        // An empty space gets no blank tab while a tab is still being placed in the window.
        if (!taken && await hasUnplacedTab(windowId)) return undefined;
        if (!taken) provisionalTabId = (await createProvisionalTab(windowId)).id;
        const tabId = taken?.id ?? provisionalTabId;
        if (tabId === undefined || !shouldContinue()) return undefined;
        // A taken tab changes space now, so leaving its old space cannot dispose of it.
        if (taken) await dependencies.routeTabToSpace(tabId, space.id);
        groupId = await ensureSpaceGroup(
          space,
          await browser.tabs.query({ windowId }),
          [tabId],
          shouldContinue,
        );
      }
      if (groupId === undefined || !shouldContinue()) return undefined;
      await restoreSpaceTabOrder(space, windowId, shouldContinue);
      if (!shouldContinue()) return undefined;
      committed = true;
      return groupId;
    } finally {
      if (provisionalTabId !== undefined && !committed) {
        await browser.tabs.remove(provisionalTabId).catch(() => undefined);
      }
    }
  };

  const focusSpaceGroupTab = async (
    space: Space,
    groupId: number,
    windowId: number,
    rememberedBackingToken: string | undefined,
    preferActiveTab: boolean,
    shouldContinue: () => boolean,
  ): Promise<number | undefined> => {
    const targetTabs = (await browser.tabs.query({ groupId }))
      .filter((tab) => tab.windowId === windowId);
    if (!shouldContinue()) return undefined;
    const target = spaceTabActivationTarget(
      targetTabs,
      await loadTabOwnerships(targetTabs),
      rememberedBackingToken,
      preferActiveTab,
    );
    if (target?.id === undefined) throw new Error(`The ${space.title} space has no tab to focus.`);
    if (!shouldContinue()) return undefined;
    if (preferActiveTab) {
      const [currentActiveTab] = await browser.tabs.query({ active: true, windowId });
      if (
        currentActiveTab?.id !== undefined &&
        targetTabs.some((candidate) => candidate.id === currentActiveTab.id)
      ) {
        await rememberActiveTab(currentActiveTab.id);
        return currentActiveTab.id;
      }
      // A tab no space owns, such as a pinned one, keeps focus: restoring a space never pulls the user off it.
      if (
        currentActiveTab?.id !== undefined &&
        (currentActiveTab.pinned || !(await loadTabOwnerships([currentActiveTab]))[currentActiveTab.id])
      ) return undefined;
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (!await focusTab(target.id, windowId, shouldContinue)) return undefined;
      const [activeTab] = await browser.tabs.query({ active: true, windowId });
      if (!shouldContinue()) return undefined;
      if (activeTab?.id === target.id) {
        if (preferActiveTab) await rememberActiveTab(target.id);
        return target.id;
      }
    }
    throw new Error(`The ${space.title} space tab could not be focused.`);
  };

  const reconcileOwnedSpaceGroups = async (
    spaces: Space[],
    activeSpace: Space,
    windowId: number,
    activeGroupId: number | undefined,
    shouldContinue: () => boolean,
  ) => {
    const groups = tabGroupApi();
    if (!groups) return;
    const windowTabs = await browser.tabs.query({ windowId });
    for (const space of spaces) {
      if (!shouldContinue()) return;
      try {
        const groupId = space.id === activeSpace.id
          ? activeGroupId
          : await findSpaceGroup(space, windowTabs);
        if (groupId === undefined || !shouldContinue()) continue;
        await updateGroup(windowId, groupId, {
          collapsed: space.id !== activeSpace.id,
          title: hyperGroupTitle(space.index),
        });
      } catch (error) {
        console.error(`Unable to reconcile the tab group for ${space.title}.`, error);
      }
    }
  };

  const liveActivationTarget = async (
    space: Space,
    windowId: number,
    rememberedBackingToken: string | undefined,
  ): Promise<{ group: OwnedGroup; tabId: number } | undefined> => {
    const groups = tabGroupApi();
    const groupId = await spaceGroupId(space.id, windowId);
    if (!groups || groupId === undefined) return undefined;
    const group = await groups.get(groupId).catch(() => undefined);
    if (group?.windowId !== windowId) return undefined;
    const groupTabs = (await browser.tabs.query({ windowId }))
      .filter((tab) => tab.id !== undefined && tab.groupId === groupId && !tab.pinned)
      .sort((left, right) => left.index - right.index);
    if (groupTabs.length === 0) return undefined;
    const [ownerships, backings] = await Promise.all([
      loadTabOwnerships(groupTabs),
      windowTabBackings(space.id, windowId),
    ]);
    const plan = planLiveSpaceActivation({
      backingIds: backings.map((backing) => backing.id),
      groupTabs,
      ownerships,
      ...(rememberedBackingToken === undefined ? {} : { rememberedBackingToken }),
      spaceId: space.id,
      windowId,
    });
    return plan ? { group, tabId: plan.tabId } : undefined;
  };

  /**
   * Selects a space for a window. A reconcile restores the space the window has
   * already selected and lets an active tab it owns keep focus; a switch focuses
   * the destination's remembered tab first and only then collapses its siblings,
   * so no collapse can move focus off the tab the switch restores. A space with
   * no tab in the window opens a blank one unless `blankTab` is false, or takes
   * the window's focused new tab page if `takeNewTab` is set and there is one.
   */
  const select = async (
    spaceId: string,
    windowId: number,
    options: { blankTab?: boolean; reconcile: boolean; takeNewTab?: boolean },
  ): Promise<void> => {
    const token = crypto.randomUUID();
    dependencies.activationTokens.set(windowId, token);
    switching.set(windowId, token);
    const shouldContinue = () => dependencies.activationTokens.get(windowId) === token;
    const superseded = () => new SupersededTargetError(spaceTarget(spaceId));
    const emptySpaceTab: EmptySpaceTab = options.blankTab === false
      ? 'none'
      : options.takeNewTab ? 'take' : 'open';
    try {
      const spaces = deriveSpaces(await browser.bookmarks.getTree());
      const space = openableSpace(spaces, spaceId);
      const previousSpaceId = await getWindowActiveSpaceId(windowId);
      // A reconcile read before the window moved on must not drag it back.
      if (options.reconcile && previousSpaceId && previousSpaceId !== spaceId) throw superseded();
      if (!options.reconcile && previousSpaceId && previousSpaceId !== spaceId) {
        const [leaving] = await browser.tabs.query({ active: true, windowId });
        if (leaving?.id !== undefined) await rememberActiveTab(leaving.id);
      }
      const spaceBookmark = await bookmarkById(space.id);
      const rememberedBackingToken = spaceBookmark
        ? spaceLastActiveTabToken(spaceBookmark, windowId)
        : undefined;
      if (!shouldContinue()) throw superseded();
      // Tabs parked when the space's last window closed reopen wherever it opens next.
      const adopted = dependencies.canAdoptParkedTabs()
        ? await adoptParkedTabBackings(space.id, windowId)
        : 0;
      if (!shouldContinue()) throw superseded();

      const live = options.reconcile || !tabGroupApi() || adopted > 0
        ? undefined
        : await liveActivationTarget(space, windowId, rememberedBackingToken);
      if (live) {
        if (await focusTab(live.tabId, windowId, shouldContinue) && shouldContinue()) {
          await dependencies.activateLiveGroup(live.group, token, live.tabId);
        }
        if (!shouldContinue()) throw superseded();
        return;
      }

      if (!options.reconcile) await dependencies.persistWindowActiveSpace(windowId, space.id);
      if (!shouldContinue()) throw superseded();
      if (!tabGroupApi()) {
        await activateUngroupedSpace(
          space,
          windowId,
          rememberedBackingToken,
          options.reconcile,
          emptySpaceTab,
          shouldContinue,
          token,
        );
      } else {
        const groupId = await activateGroupedSpace(
          space,
          windowId,
          shouldContinue,
          // Adopted tabs are new here, so there is no restored group to wait for.
          options.reconcile && adopted === 0,
          emptySpaceTab,
          token,
        );
        const focusedTabId = groupId !== undefined && shouldContinue()
          ? await focusSpaceGroupTab(
              space,
              groupId,
              windowId,
              rememberedBackingToken,
              options.reconcile,
              shouldContinue,
            )
          : undefined;
        const displacementsBefore = ledger.claimedDisplacements(windowId);
        await reconcileOwnedSpaceGroups(spaces, space, windowId, groupId, shouldContinue);
        if (!shouldContinue()) throw superseded();
        if (focusedTabId !== undefined) {
          const [activeTab] = await browser.tabs.query({ active: true, windowId });
          // Only a displacement this switch caused may be undone; a tab the user chose stands.
          if (
            shouldContinue() &&
            activeTab?.id !== focusedTabId &&
            ledger.claimedDisplacements(windowId) > displacementsBefore
          ) {
            await focusTab(focusedTabId, windowId, shouldContinue);
          }
        }
      }
      if (!shouldContinue()) throw superseded();
      if (!options.reconcile && previousSpaceId && previousSpaceId !== space.id) {
        await dependencies.disposeSpaceNewTabs(previousSpaceId, windowId, token);
      }
      if (!shouldContinue()) throw superseded();
    } finally {
      if (switching.get(windowId) === token) switching.delete(windowId);
    }
  };

  return {
    /** Records an admitted space choice and supersedes any switch already running. */
    admit(windowId: number, spaceId: string) {
      latestAdmissions.set(windowId, spaceId);
      supersede(windowId);
    },
    /** A choice runs only while it is still the window's latest; an older one would undo the newer. */
    async runIfLatest(windowId: number, spaceId: string, run: () => Promise<void>) {
      if (latestAdmissions.get(windowId) !== spaceId) {
        throw new SupersededTargetError(spaceTarget(spaceId));
      }
      await run();
    },
    /** Whether Hyper caused this activation; an unclaimed one supersedes a switch in flight. */
    claimActivation(windowId: number, tabId: number): boolean {
      if (ledger.claim(windowId, tabId)) return true;
      if (switching.has(windowId)) supersede(windowId);
      return false;
    },
    collapseGroup: (windowId: number, groupId: number) =>
      updateGroup(windowId, groupId, { collapsed: true }),
    /** Forgets a closed window's session state; its backings stay parked under its window ID. */
    async closeWindow(windowId: number) {
      const cleanup = await Promise.allSettled([
        removeWindowActiveSpaceId(windowId),
        forgetWindowSpaceGroups(windowId),
      ]);
      const failures = cleanup.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : []);
      if (failures.length > 0) {
        throw new AggregateError(failures, 'Unable to fully clean up the closed window.');
      }
    },
    expectActivation: (windowId: number, tabId: number) =>
      ledger.expectActivation(windowId, tabId),
    isSwitching: (windowId: number) => switching.has(windowId),
    /** A space already open in a window takes back tabs parked when another of its windows closed. */
    async reopenParkedTabs(preferredWindowId: number | undefined) {
      const windowIds = [...normalWindowIds(await browser.windows.getAll())].sort((left, right) =>
        Number(right === preferredWindowId) - Number(left === preferredWindowId));
      for (const windowId of windowIds) {
        const spaceId = await getWindowActiveSpaceId(windowId);
        if (!spaceId || !await hasParkedTabBackings(spaceId)) continue;
        // Only parked tabs reopen; a window event never opens a blank tab the user did not ask for.
        await select(spaceId, windowId, { blankTab: false, reconcile: true }).catch(() => undefined);
      }
    },
    /** Tells views a new tab was shown, unless it is Hyper's own provisional one showing first. */
    relayNewTabShown(tab: Browser.tabs.Tab) {
      if (tab.id === undefined || provisionalTabIds.delete(tab.id)) return;
      void browser.runtime.sendMessage({ type: userNewTabShownMessageType, windowId: tab.windowId })
        .catch(() => undefined);
    },
    select,
  };
}

export type SpaceSwitchController = ReturnType<typeof createSpaceSwitchController>;
