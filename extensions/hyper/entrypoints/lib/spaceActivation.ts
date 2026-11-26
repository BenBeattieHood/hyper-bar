import { deriveSpaces, openableSpace } from './bookmarks';
import { ensureHyperBookmarkStructure } from './bookmarkStorage';
import { classifyLiveTab } from './model';
import { spaceGroupId, windowSpaceGroups } from './spaceGroupStore';
import type { SpaceSwitchController } from './spaceSwitch';
import type { SpaceTabRestore } from './spaceTabRestore';
import { activationSpaceId } from './tabDisposition';
import { nativeTabGroups, tabActivationCanSelectSpace } from './tabGroups';
import { getTabOwnership } from './tabOwnership';
import { tabById } from './tabs';
import { getWindowActiveSpaceId } from './windowState';

export interface SpaceActivationDependencies {
  /** Each window's current space activation; the latest one to start wins. */
  activationTokens: Map<number, string>;
  disposeSpaceNewTabs(spaceId: string, windowId: number, activationToken?: string): Promise<void>;
  markIntentionalTab(tabId: number): void;
  persistWindowActiveSpace(windowId: number, spaceId: string): Promise<void>;
  queueMutation<Result>(operation: () => Promise<Result>): Promise<Result>;
  restoreSpaceTabs: SpaceTabRestore;
  routeTabToSpace(tabId: number, spaceId: string): Promise<void>;
  spaceSwitch: Pick<SpaceSwitchController, 'collapseGroup' | 'expectActivation'>;
}

/** Selects a window's space from its group, from Search, or from the tab the user activated. */
export function createSpaceActivation(dependencies: SpaceActivationDependencies) {
  const {
    activationTokens: spaceActivationTokens,
    disposeSpaceNewTabs,
    persistWindowActiveSpace,
    spaceSwitch,
  } = dependencies;

  const activateSpaceGroup = async (
    group: { id: number; windowId: number; collapsed: boolean },
    activationToken?: string,
    requiredActiveTabId?: number,
    forceReconcile = false,
  ) => {
    const tabGroups = nativeTabGroups('get', 'update');
    if (!tabGroups) return;

    const windowGroups = await windowSpaceGroups(group.windowId);
    const spaceId = [...windowGroups].find(([, groupId]) => groupId === group.id)?.[0];
    if (spaceId === undefined) return;
    const currentGroup = await tabGroups.get(group.id).catch(() => undefined);
    if (!currentGroup || currentGroup.windowId !== group.windowId) {
      return;
    }

    const activeSpaceId = await getWindowActiveSpaceId(group.windowId);
    if (!forceReconcile && activeSpaceId === spaceId && !currentGroup.collapsed) return;
    if (requiredActiveTabId !== undefined) {
      const activeTab = await tabById(requiredActiveTabId);
      if (
        !activeTab?.active ||
        activeTab.windowId !== group.windowId ||
        activeTab.groupId !== group.id
      ) return;
    }
    const operationToken = activationToken ?? crypto.randomUUID();
    if (activationToken === undefined) {
      spaceActivationTokens.set(group.windowId, operationToken);
    }
    const shouldContinue = () =>
      spaceActivationTokens.get(group.windowId) === operationToken;
    if (!shouldContinue()) return;
    if (currentGroup.collapsed) {
      await tabGroups.update(group.id, { collapsed: false });
    }
    if (!shouldContinue()) return;
    await persistWindowActiveSpace(group.windowId, spaceId);
    if (!shouldContinue()) return;
    await Promise.allSettled(
      [...windowGroups.values()].flatMap((groupId) =>
        groupId !== group.id
          ? [spaceSwitch.collapseGroup(group.windowId, groupId)]
          : []),
    );
    if (!shouldContinue()) return;
    if (forceReconcile && requiredActiveTabId !== undefined) {
      const target = await tabById(requiredActiveTabId);
      if (
        target &&
        !target.active &&
        target.windowId === group.windowId &&
        target.groupId === group.id
      ) {
        spaceSwitch.expectActivation(group.windowId, requiredActiveTabId);
        await browser.tabs.update(requiredActiveTabId, { active: true });
      }
    }
    if (!shouldContinue()) return;
    if (activeSpaceId && activeSpaceId !== spaceId) {
      await disposeSpaceNewTabs(activeSpaceId, group.windowId, operationToken);
    }
  };

  const activateSpaceFromSearch = async (spaceId: string, windowId: number) => {
    await ensureHyperBookmarkStructure();
    openableSpace(deriveSpaces(await browser.bookmarks.getTree()), spaceId);
    const activationToken = crypto.randomUUID();
    spaceActivationTokens.set(windowId, activationToken);
    const shouldContinue = () => spaceActivationTokens.get(windowId) === activationToken;
    const previousSpaceId = await getWindowActiveSpaceId(windowId);
    if (!shouldContinue()) return;
    const groupId = await spaceGroupId(spaceId, windowId);
    if (!shouldContinue()) return;
    const group = groupId !== undefined
      ? await nativeTabGroups('get')?.get(groupId).catch(() => undefined)
      : undefined;
    if (!shouldContinue()) return;
    if (group?.windowId === windowId) {
      await activateSpaceGroup(group, activationToken);
      if (!shouldContinue()) return;
      const groupTabs = await browser.tabs.query({ groupId: group.id, windowId });
      if (!shouldContinue()) return;
      const targetTab = groupTabs.find((tab) => !tab.discarded) ?? groupTabs[0];
      if (targetTab?.id !== undefined) {
        await browser.tabs.update(targetTab.id, { active: true });
      }
      if (!shouldContinue()) return;
      await browser.windows.update(windowId, { focused: true }).catch(() => undefined);
      return;
    }

    await persistWindowActiveSpace(windowId, spaceId);
    if (!shouldContinue()) return;
    const windowTabs = await browser.tabs.query({ windowId });
    const ownedTabs = (await Promise.all(windowTabs.map(async (tab) => ({
      tab,
      ownership: tab.id === undefined ? undefined : await getTabOwnership(tab.id),
    })))).filter(({ ownership }) => ownership?.spaceId === spaceId);
    if (!shouldContinue()) return;
    let target: Browser.tabs.Tab | undefined =
      ownedTabs.find(({ tab }) => !tab.discarded)?.tab ?? ownedTabs[0]?.tab;
    if (target?.id === undefined) {
      const restoredIds = await dependencies.restoreSpaceTabs(
        spaceId,
        windowId,
        [],
        undefined,
        activationToken,
      );
      if (!shouldContinue()) return;
      const restoredTabs = await Promise.all(restoredIds.map((tabId) =>
        tabById(tabId),
      ));
      if (!shouldContinue()) return;
      target = restoredTabs.find((tab): tab is Browser.tabs.Tab => Boolean(tab));
    }
    if (target?.id === undefined) {
      if (!shouldContinue()) return;
      const created = await browser.tabs.create({ active: true, windowId });
      if (!shouldContinue()) {
        if (created.id !== undefined) {
          await browser.tabs.remove(created.id).catch(() => undefined);
        }
        return;
      }
      if (created.id !== undefined) {
        dependencies.markIntentionalTab(created.id);
        await dependencies.routeTabToSpace(created.id, spaceId);
      }
    } else {
      await browser.tabs.update(target.id, { active: true });
    }
    if (!shouldContinue()) return;
    await browser.windows.update(windowId, { focused: true }).catch(() => undefined);
    if (!shouldContinue()) return;
    if (previousSpaceId && previousSpaceId !== spaceId) {
      await disposeSpaceNewTabs(previousSpaceId, windowId, activationToken);
    }
  };

  const queueSpaceGroupActivation = (operation: () => Promise<void>) => {
    void dependencies.queueMutation(operation).catch(() => undefined);
  };

  const queueBrowserTabActivation = (tabId: number, windowId: number) => {
    const activationToken = spaceActivationTokens.get(windowId);
    queueSpaceGroupActivation(async () => {
      if (spaceActivationTokens.get(windowId) !== activationToken) return;
      const tab = await tabById(tabId);
      if (!tab?.active || tab.windowId !== windowId) return;
      const [ownership, bookmarkTree] = await Promise.all([
        getTabOwnership(tabId),
        browser.bookmarks.getTree(),
      ]);
      if (spaceActivationTokens.get(windowId) !== activationToken) return;
      // A tab moved here from another window selects nothing until its routing settles it.
      const disposition = classifyLiveTab(bookmarkTree, browser.runtime.getURL(''), tab, ownership);
      if (disposition.status === 'in-transit') return;
      if (tab.groupId < 0) {
        const spaceId = activationSpaceId(disposition);
        if (spaceId) await persistWindowActiveSpace(windowId, spaceId);
        return;
      }
      const group = await browser.tabGroups?.get(tab.groupId).catch(() => undefined);
      if (tabActivationCanSelectSpace(tab, group, windowId)) {
        await activateSpaceGroup(group, undefined, tabId);
      }
    });
  };

  return {
    activateSpaceFromSearch,
    activateSpaceGroup,
    queueBrowserTabActivation,
    queueSpaceGroupActivation,
  };
}
