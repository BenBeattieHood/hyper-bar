import { deriveSpaces, shownSpaces, type Space } from './bookmarks';
import { ownershipNamesAnotherWindow } from './tabDisposition';
import {
  hyperGroupOrdinal,
  hyperGroupTitle,
  resolveHyperGroupForSpace,
  tabGroupApi,
  withHyperGroupLock,
  type ProgrammaticGroupUpdates,
  type TabGroupApi,
} from './tabGroups';
import { newSpaceGroupColour } from './spaceGroupColours';
import { getTabOwnership } from './tabOwnership';
import { findTabTargetSpace, tabById } from './tabs';
import { forgetSpaceGroup, rememberSpaceGroup, windowSpaceGroups } from './spaceGroupStore';
import { getWindowActiveSpaceId } from './windowState';

type TabGroup = Browser.tabGroups.TabGroup;

/** How often, and for how long, placing a dragged tab waits for the drag to let go of the tab strips. */
const TAB_DRAG_RETRY_MS = 250;
const TAB_DRAG_RETRIES = 240;

/** Chrome refuses every tab strip edit while the user is dragging a tab. */
export function tabStripLocked(error: unknown): boolean {
  return error instanceof Error && error.message.includes('cannot be edited right now');
}

export interface TabRouterDependencies extends ProgrammaticGroupUpdates {
  activateSpaceGroup(group: TabGroup, tabId: number): Promise<void>;
  ensureStructure(): Promise<unknown>;
  syncTabBacking(tab: Browser.tabs.Tab, spaceId: string): Promise<void>;
}

export interface TabRoute {
  /**
   * Places a tab the browser moved into another window: it joins the space that
   * window shows, or keeps its own in a window that shows none.
   */
  placeAttached(tabId: number, windowId: number): Promise<void>;
  /** Joins the tab to the space it should show in, its group, and its backing. */
  route(tabId: number, assignToActiveSpaceWhenUnmatched: boolean, fallbackSpaceId?: string): Promise<void>;
}

interface RouteRead {
  activeSpaceId?: string;
  currentSpaceId?: string;
  spaces: Space[];
  tab: Browser.tabs.Tab;
  targetSpace?: Space;
  windowGroups: Map<string, number>;
}

/**
 * Places a tab into a space: the space's native group in the tab's window where
 * groups exist, and its exact backing everywhere.
 */
export function createTabRouter(dependencies: TabRouterDependencies): TabRoute {
  const routeWithoutGroups = async (
    tabId: number,
    assignToActiveSpaceWhenUnmatched: boolean,
    fallbackSpaceId: string | undefined,
  ) => {
    const tab = await tabById(tabId);
    if (!tab || tab.pinned) return;
    const [activeSpaceId, bookmarkTree, ownership] = await Promise.all([
      getWindowActiveSpaceId(tab.windowId),
      browser.bookmarks.getTree(),
      getTabOwnership(tabId),
    ]);
    const requestedSpaceId = fallbackSpaceId
      ?? ownership?.spaceId
      ?? (assignToActiveSpaceWhenUnmatched ? activeSpaceId : undefined);
    if (requestedSpaceId && shownSpaces(deriveSpaces(bookmarkTree)).some((space) => space.id === requestedSpaceId)) {
      await dependencies.syncTabBacking(tab, requestedSpaceId);
    }
  };

  const readRoute = async (
    groups: TabGroupApi,
    tabId: number,
    assignToActiveSpaceWhenUnmatched: boolean,
    fallbackSpaceId: string | undefined,
  ): Promise<RouteRead | undefined> => {
    const tab = await tabById(tabId);
    if (!tab || tab.pinned) return undefined;
    const [bookmarkTree, activeSpaceId, windowGroups, ownership] = await Promise.all([
      browser.bookmarks.getTree(),
      getWindowActiveSpaceId(tab.windowId),
      windowSpaceGroups(tab.windowId),
      getTabOwnership(tabId),
    ]);
    const spaces = deriveSpaces(bookmarkTree);
    let currentSpaceId = tab.groupId >= 0
      ? [...windowGroups].find(([, groupId]) => groupId === tab.groupId)?.[0]
      : undefined;
    if (!currentSpaceId && ownership && spaces.some((space) => space.id === ownership.spaceId)) {
      currentSpaceId = ownership.spaceId;
    }
    if (!currentSpaceId && tab.groupId >= 0) {
      const ordinal = hyperGroupOrdinal((await groups.get(tab.groupId).catch(() => undefined))?.title);
      currentSpaceId = ordinal ? spaces[ordinal - 1]?.id : undefined;
    }
    if (!currentSpaceId && tab.groupId < 0) currentSpaceId = activeSpaceId;
    return {
      ...(activeSpaceId === undefined ? {} : { activeSpaceId }),
      ...(currentSpaceId === undefined ? {} : { currentSpaceId }),
      spaces,
      tab,
      // No tab joins an archived space: its tabs wait parked until it returns.
      targetSpace: findTabTargetSpace(shownSpaces(spaces), {
        activeSpaceId,
        assignUnmatchedToActiveSpace: assignToActiveSpaceWhenUnmatched,
        currentSpaceId,
        fallbackSpaceId,
      }),
      windowGroups,
    };
  };

  /** The space's group in the tab's window, adopting a matching one when none is recorded. */
  const resolveTargetGroup = async (groups: TabGroupApi, read: RouteRead, space: Space) => {
    const windowId = read.tab.windowId;
    const storedGroupId = read.windowGroups.get(space.id);
    let group = storedGroupId === undefined
      ? undefined
      : await groups.get(storedGroupId).catch(() => undefined);
    if (group?.windowId !== windowId) {
      group = undefined;
      if (storedGroupId !== undefined) await forgetSpaceGroup(space.id, windowId);
    }
    if (group) return group;
    const claimedGroupIds = new Set([...read.windowGroups].flatMap(([spaceId, groupId]) =>
      spaceId === space.id ? [] : [groupId]));
    group = resolveHyperGroupForSpace(
      await groups.query(windowId),
      space.index,
      undefined,
      [read.tab.groupId, storedGroupId].filter(
        (groupId): groupId is number => groupId !== undefined && groupId >= 0,
      ),
      claimedGroupIds,
    ).group;
    if (group) await rememberSpaceGroup(space.id, windowId, group.id);
    return group;
  };

  /** Moves the tab into the group, creating it in the tab's own window when there is none. */
  const joinGroup = async (
    groups: TabGroupApi,
    tab: Browser.tabs.Tab,
    space: Space,
    targetGroup: TabGroup | undefined,
  ): Promise<TabGroup> => {
    const tabId = tab.id as number;
    let groupId = targetGroup?.id;
    let moved = false;
    const colour = targetGroup ? undefined : await newSpaceGroupColour(space.id, tab.windowId);
    if (groupId !== undefined) dependencies.beginProgrammaticGroupUpdate(groupId);
    try {
      groupId = await groups.group({
        // A new group otherwise opens in the last focused window, taking the tab with it.
        ...(groupId !== undefined ? { groupId } : { createProperties: { windowId: tab.windowId } }),
        tabIds: tabId,
      });
      moved = true;
      if (!targetGroup) dependencies.beginProgrammaticGroupUpdate(groupId);
      const activeSpaceId = await getWindowActiveSpaceId(tab.windowId);
      const group = await groups.update(groupId, {
        title: hyperGroupTitle(space.index),
        ...(colour ? { color: colour } : {}),
        collapsed: !tab.active && activeSpaceId !== space.id,
      });
      await rememberSpaceGroup(space.id, tab.windowId, groupId);
      return group;
    } catch (error) {
      if (moved) {
        try {
          if (tab.groupId >= 0) {
            await groups.group({ groupId: tab.groupId, tabIds: tabId }).catch(() => groups.ungroup(tabId));
          } else {
            await groups.ungroup(tabId);
          }
        } catch (rollbackError) {
          console.error('Unable to roll back a failed bookmark-space route.', rollbackError);
        }
      }
      throw error;
    } finally {
      if (groupId !== undefined) await dependencies.endProgrammaticGroupUpdate(groupId);
    }
  };

  const route: TabRoute['route'] = async (
    tabId,
    assignToActiveSpaceWhenUnmatched,
    fallbackSpaceId,
  ) => {
    await dependencies.ensureStructure();
    if (fallbackSpaceId === undefined) {
      // Only the move that carried a tab here may place it; incidental routing waits for that.
      const [current, ownership] = await Promise.all([
        tabById(tabId),
        getTabOwnership(tabId),
      ]);
      if (current && ownershipNamesAnotherWindow(current, ownership)) return;
    }
    const groups = tabGroupApi();
    if (!groups) {
      await routeWithoutGroups(tabId, assignToActiveSpaceWhenUnmatched, fallbackSpaceId);
      return;
    }
    // The target is re-proved inside the window lock; a change between reads retries.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const initial = await readRoute(groups, tabId, assignToActiveSpaceWhenUnmatched, fallbackSpaceId);
      const targetSpaceId = initial?.targetSpace?.id;
      if (!initial || !targetSpaceId) return;
      // A tab that leaves the locked window is placed by its attach, and joining a group
      // resolved here would carry it back.
      const leftWindow = (read: RouteRead | undefined) =>
        read !== undefined && read.tab.windowId !== initial.tab.windowId;
      const settled = await withHyperGroupLock(initial.tab.windowId, async () => {
        const read = await readRoute(groups, tabId, assignToActiveSpaceWhenUnmatched, fallbackSpaceId);
        if (leftWindow(read)) return true;
        if (read?.targetSpace?.id !== targetSpaceId) return false;
        let targetGroup = await resolveTargetGroup(groups, read, read.targetSpace);
        const latest = await readRoute(groups, tabId, assignToActiveSpaceWhenUnmatched, fallbackSpaceId);
        if (leftWindow(latest)) return true;
        if (latest?.targetSpace?.id !== targetSpaceId) return false;
        const latestStoredGroupId = latest.windowGroups.get(targetSpaceId);
        if (latestStoredGroupId !== undefined && latestStoredGroupId !== targetGroup?.id) {
          const stored = await groups.get(latestStoredGroupId).catch(() => undefined);
          if (stored?.windowId === latest.tab.windowId) targetGroup = stored;
        }
        const { tab } = latest;
        const space = latest.targetSpace;
        if (targetGroup?.id !== tab.groupId) targetGroup = await joinGroup(groups, tab, space, targetGroup);
        await dependencies.syncTabBacking(tab, space.id);
        if (tab.active && targetGroup) await dependencies.activateSpaceGroup(targetGroup, tabId);
        return true;
      });
      if (settled) return;
    }
  };

  const placeAttached: TabRoute['placeAttached'] = async (tabId, windowId) => {
    for (let attempt = 0; ; attempt += 1) {
      const tab = await tabById(tabId);
      // A tab that moved on again is placed by its next attach.
      if (tab?.windowId !== windowId) return;
      const [shownSpaceId, ownership] = await Promise.all([
        getWindowActiveSpaceId(windowId),
        getTabOwnership(tabId),
      ]);
      const spaceId = shownSpaceId ?? ownership?.spaceId;
      try {
        await route(tabId, spaceId !== undefined, spaceId);
        return;
      } catch (error) {
        // A tab dragged out of a tab strip arrives while the drag still holds them all.
        if (!tabStripLocked(error) || attempt >= TAB_DRAG_RETRIES) throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, TAB_DRAG_RETRY_MS));
    }
  };

  return { placeAttached, route };
}
