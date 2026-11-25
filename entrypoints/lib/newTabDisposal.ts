import { runConcurrentOperations } from './async';
import { addToMapList } from './collections';
import { spaceGroupId } from './spaceGroupStore';
import { getTabOwnership } from './tabOwnership';
import { cleanupRestoredTabsInWindow, isBlankTabPage, tabById } from './tabs';
import { tabUrl } from './urlIdentity';

export interface NewTabDisposalDependencies {
  /** Each window's current space activation; a disposal begun under an older one stops. */
  activationTokens: ReadonlyMap<number, string>;
  /** Navigations per tab: a blank tab that has navigated since it was chosen is no longer spare. */
  generations: ReadonlyMap<number, number>;
  markIntentionalTab(tabId: number): void;
  newTabUrl: string;
}

/**
 * Removes the blank new tabs Hyper would otherwise leave behind: those a space
 * switch opened, once the window leaves that space, and those the browser
 * restores at startup.
 */
export function createNewTabDisposal(dependencies: NewTabDisposalDependencies) {
  const isBlank = (tab: Browser.tabs.Tab) =>
    isBlankTabPage(tabUrl(tab), dependencies.newTabUrl);

  const disposeSpaceNewTabs = async (
    spaceId: string,
    windowId: number,
    activationToken?: string,
  ): Promise<void> => {
    const shouldContinue = () => activationToken === undefined ||
      dependencies.activationTokens.get(windowId) === activationToken;
    if (!shouldContinue()) return;
    const [tabs, groupId] = await Promise.all([
      browser.tabs.query({ windowId }),
      spaceGroupId(spaceId, windowId),
    ]);
    if (!shouldContinue()) return;
    const inSpace = (tab: Browser.tabs.Tab, ownerSpaceId: string | undefined) =>
      typeof groupId === 'number' ? tab.groupId === groupId : ownerSpaceId === spaceId;
    const candidates = (await Promise.all(tabs.flatMap((tab) =>
      tab.id === undefined || tab.pinned || !isBlank(tab)
        ? []
        : [getTabOwnership(tab.id).then((ownership) => inSpace(tab, ownership?.spaceId)
          ? { generation: dependencies.generations.get(tab.id as number), tabId: tab.id as number }
          : undefined)],
    ))).filter((candidate) => candidate !== undefined);
    if (!shouldContinue()) return;
    // Recheck each candidate: the user may have navigated or moved it meanwhile.
    const disposableTabIds = (await Promise.all(candidates.map(async (candidate) => {
      const [tab, ownership] = await Promise.all([
        tabById(candidate.tabId),
        getTabOwnership(candidate.tabId),
      ]);
      return tab &&
        !tab.pinned &&
        tab.windowId === windowId &&
        dependencies.generations.get(candidate.tabId) === candidate.generation &&
        isBlank(tab) &&
        inSpace(tab, ownership?.spaceId)
        ? candidate.tabId
        : undefined;
    }))).filter((tabId) => tabId !== undefined);
    if (!shouldContinue()) return;
    if (disposableTabIds.length > 0) await browser.tabs.remove(disposableTabIds);
  };

  const disposeRestoredNewTabs = async (
    tabs: Browser.tabs.Tab[],
    generations: ReadonlyMap<number, number | undefined>,
  ): Promise<void> => {
    const disposableByWindow = new Map<number, number[]>();
    for (const tab of tabs) {
      if (tab.id === undefined || tab.incognito || tab.pinned || !isBlank(tab)) continue;
      addToMapList(disposableByWindow, tab.windowId, tab.id);
    }
    await runConcurrentOperations(
      [...disposableByWindow],
      ([windowId, disposableTabIds]) => cleanupRestoredTabsInWindow(
        windowId,
        new Map(disposableTabIds.map((tabId) => [tabId, generations.get(tabId)])),
        dependencies.newTabUrl,
        {
          create: (properties) => browser.tabs.create(properties),
          query: (properties) => browser.tabs.query(properties),
          remove: (tabIds) => browser.tabs.remove(tabIds),
        },
        (tabId) => dependencies.generations.get(tabId),
        dependencies.markIntentionalTab,
      ),
      'Unable to clean up restored tabs in every window.',
    );
  };

  return { disposeRestoredNewTabs, disposeSpaceNewTabs };
}
