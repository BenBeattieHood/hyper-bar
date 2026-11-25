import type { CrossSpaceDuplicates } from './crossSpaceDuplicates';
import type { DuplicateController } from './duplicateController';
import { allowsDuplicate, newTabOrigin } from './duplicateController';
import {
  createNavigationUpdateQueue,
  type createNavigationDedupe,
  type NavigationUpdate,
} from './navigationDedupe';
import type { TabBookmarkLinkController } from './tabBookmarkLinkController';
import { getTabOwnership } from './tabOwnership';
import { advanceTabGeneration, isBlankTabPage, isHistoryNavigationCommit, retainRecentEntries, sameNavigationUrl, tabById } from './tabs';
import { tabStatusAnnouncementIsCurrent } from './tabStatus';
import { normaliseUrl, tabUrl } from './urlIdentity';

type NavigationDedupe = ReturnType<typeof createNavigationDedupe>;
type ListenerDetails<Event extends { addListener(listener: (...args: never[]) => unknown): void }> =
  Parameters<Parameters<Event['addListener']>[0]>;

export interface TabNavigationIngressDependencies {
  backingClaimedByAnotherLiveTab(tabId: number, backing: { backingId: string }): Promise<boolean>;
  crossSpaceDuplicates: Pick<CrossSpaceDuplicates, 'consumeReturn' | 'forgetTab' | 'noteNewTab' | 'offerSwitch'>;
  duplicateController: Pick<DuplicateController,
    'allow' | 'isCandidateAt' | 'markCandidate' | 'noteCommit' | 'restartAtWrapperPage'>;
  /** Navigations per tab; this module advances it on every creation and URL change. */
  generations: Map<number, number>;
  /** Whether each tab open when the worker started already had an ownership then. */
  initialTabOwnerships: Promise<ReadonlyMap<number, boolean>>;
  /** Tabs Hyper opened itself, which are never treated as the user's new tab. */
  intentionalNewTabIds: Set<number>;
  maxTrackedTabs: number;
  navigationDedupe: Pick<NavigationDedupe,
    'closeNewlyGroupedDuplicate' | 'focusExistingSameSpaceNavigation' | 'focusTarget' | 'forgetTab' | 'pendingBacks'>;
  newTabUrl: string;
  queueMutation<Result>(operation: () => Promise<Result>): Promise<Result>;
  retryPendingBackingCleanup(): Promise<void>;
  /** Clears a reused tab id from the removed-tab record. */
  forgetRemoval(tabId: number): void;
  routeTab(tabId: number, assignToActiveSpaceWhenUnmatched: boolean, fallbackSpaceId?: string): Promise<void>;
  scheduleReconciliation(): void;
  syncSameDomainNavigation(tabId: number, url: string, generation: number): Promise<boolean>;
  tabBookmarkLinks: Pick<TabBookmarkLinkController, 'followNavigation' | 'whileNavigating'>;
  /** Navigation events reach here before a tab query would report them. */
  tabStatuses: Map<number, 'complete' | 'loading'>;
}

/**
 * Follows each tab from creation through its navigations: routes it to a
 * space, dedupes a page its space already shows, offers the tab another
 * space has open for it, and records load status.
 */
export function createTabNavigationIngress(dependencies: TabNavigationIngressDependencies) {
  const {
    crossSpaceDuplicates,
    duplicateController,
    generations: tabNavigationGenerations,
    navigationDedupe,
    newTabUrl: hyperNewTabUrl,
    queueMutation: queueGroupMutation,
    routeTab: routeTabToBookmarkSpace,
    scheduleReconciliation: scheduleHyperModelReconciliation,
    tabBookmarkLinks,
  } = dependencies;
  const pendingDeduplicatedBacks = navigationDedupe.pendingBacks;
  const tabNavigationUrls = new Map<number, string>();
  const newTabNavigationIds = new Set<number>();
  const suppressedDeduplicatedBackUrls = new Map<number, {
    close: boolean;
    expectedGeneration: number;
    url: string;
  }>();

  const retryExternalDuplicateCleanup = (
    tabId: number,
    activeAtCreation: boolean,
    attemptsRemaining = 2,
  ) => {
    void queueGroupMutation(() => navigationDedupe.closeNewlyGroupedDuplicate(
      tabId,
      undefined,
      activeAtCreation,
    )).then((closed) => {
      if (!closed && attemptsRemaining > 1) {
        retryExternalDuplicateCleanup(tabId, activeAtCreation, attemptsRemaining - 1);
      }
    }).catch(() => undefined);
  };

  const seedNavigationUrls = () => void browser.tabs.query({}).then((tabs) => {
    for (const tab of tabs) {
      const url = tabUrl(tab);
      if (tab.id !== undefined && url && !tabNavigationUrls.has(tab.id)) {
        tabNavigationUrls.set(tab.id, url);
      }
    }
  }).catch(() => undefined);

  const tabCreated = (tab: Browser.tabs.Tab) => {
    if (tab.id === undefined) return;
    advanceTabGeneration(tabNavigationGenerations, tab.id);
    retainRecentEntries(tabNavigationGenerations, dependencies.maxTrackedTabs);
    const ownershipAtCreation = getTabOwnership(tab.id);
    const restoredAtCreation = Promise.all([
      dependencies.initialTabOwnerships,
      ownershipAtCreation,
    ]).then(([initialOwnership, ownership]) => initialOwnership.has(tab.id as number)
      ? initialOwnership.get(tab.id as number) === true
      : Boolean(ownership));
    const url = tabUrl(tab);
    if (url) tabNavigationUrls.set(tab.id, url);
    if (tab.openerTabId !== undefined) {
      newTabNavigationIds.add(tab.id);
    }
    dependencies.forgetRemoval(tab.id);
    void queueGroupMutation(dependencies.retryPendingBackingCleanup);
    void queueGroupMutation(async () => {
      const intentional = dependencies.intentionalNewTabIds.delete(tab.id as number);
      const restored = await restoredAtCreation;
      const copied = restored ? await ownershipAtCreation : undefined;
      const origin = newTabOrigin({
        // Firefox's Duplicate copies its source's ownership; a reopened tab's source is gone.
        copiedOwnership: Boolean(copied?.backingId) &&
          await dependencies.backingClaimedByAnotherLiveTab(tab.id as number, { backingId: copied?.backingId as string }),
        intentional,
        newTabUrl: hyperNewTabUrl,
        restored,
        tab,
      });
      crossSpaceDuplicates.noteNewTab(tab.id as number, origin);
      await routeTabToBookmarkSpace(tab.id as number, true);
      if (allowsDuplicate(origin)) {
        duplicateController.markCandidate(tab.id as number, tabUrl(tab));
        await duplicateController.allow(tab.id as number);
        return;
      }
      if (origin !== 'foreground-link') return;
      const latest = await tabById(tab.id as number);
      if (!tabUrl(latest) || (!latest?.active && !tab.active)) return;
      const closed = await navigationDedupe.closeNewlyGroupedDuplicate(
        tab.id as number,
        undefined,
        tab.active,
      );
      if (!closed) {
        queueMicrotask(() => retryExternalDuplicateCleanup(tab.id as number, tab.active));
      }
    }).catch(() => undefined);
  };

  const runNavigationUpdate = createNavigationUpdateQueue(queueGroupMutation, async (
    tabId: number,
    update: NavigationUpdate,
  ) => {
    const { generation, newTabNavigation, previousUrl, url } = update;
    // The tab has moved on, and the newer navigation's own update will follow it.
    if (tabNavigationGenerations.get(tabId) !== generation) return;
    // Hyper sending a tab back is neither deduped nor offered anything.
    const returning = crossSpaceDuplicates.consumeReturn(tabId, url);
    const candidate = await duplicateController.isCandidateAt(tabId, url);
    const reused = !candidate && !returning && await navigationDedupe.focusExistingSameSpaceNavigation(
      tabId,
      url,
      generation,
      previousUrl,
      newTabNavigation,
    );
    if (!reused && tabNavigationGenerations.get(tabId) === generation) {
      const current = await tabById(tabId);
      if (normaliseUrl(tabUrl(current)) !== normaliseUrl(url)) return;
      await tabBookmarkLinks.followNavigation(tabId, previousUrl, async () => {
        const syncedInPlace = await dependencies.syncSameDomainNavigation(tabId, url, generation);
        if (!syncedInPlace) await routeTabToBookmarkSpace(tabId, false);
      });
      const offeredDedupe = candidate && await duplicateController.allow(tabId);
      if (!offeredDedupe && !returning && tabNavigationGenerations.get(tabId) === generation) {
        await crossSpaceDuplicates.offerSwitch(tabId, update);
      }
    }
  });
  const queueNavigationUpdate = (tabId: number, update: NavigationUpdate) => void tabBookmarkLinks
    .whileNavigating(tabId, () => runNavigationUpdate(tabId, update)).catch(() => undefined);
  const queueRecoveredNavigation = (tabId: number, generation: number) => {
    void queueGroupMutation(async () => {
      if (tabNavigationGenerations.get(tabId) === generation) {
        await routeTabToBookmarkSpace(tabId, false);
      }
    }).catch(() => undefined);
  };
  const releasePendingBack = (tabId: number): boolean => {
    const pending = pendingDeduplicatedBacks.get(tabId);
    pendingDeduplicatedBacks.delete(tabId);
    const latestUpdate = pending?.tabUpdates.at(-1);
    if (!latestUpdate) return false;
    queueNavigationUpdate(tabId, latestUpdate);
    return true;
  };
  const historyNavigation = (
    details: Browser.webNavigation.WebNavigationTransitionCallbackDetails,
  ) => {
    // A frame inside a page changes nothing the model shows, and busy pages load frames constantly.
    if (details.frameId !== 0) return;
    scheduleHyperModelReconciliation();
    duplicateController.noteCommit(details);
    suppressedDeduplicatedBackUrls.delete(details.tabId);
    const pending = pendingDeduplicatedBacks.get(details.tabId);
    if (!pending) return;
    const historyCommit = isHistoryNavigationCommit(details, details.tabId);
    if (sameNavigationUrl(details.url, pending.sourceUrl)) return;
    if (!historyCommit) {
      releasePendingBack(details.tabId);
      return;
    }
    pendingDeduplicatedBacks.delete(details.tabId);
    const matchingUpdate = pending.tabUpdates.findLast(
      (update) => sameNavigationUrl(update.url, details.url),
    );
    const latestUpdate = pending.tabUpdates.at(-1);
    void navigationDedupe.focusTarget(
      pending,
      details.url,
      matchingUpdate?.generation,
    );
    if (latestUpdate && latestUpdate !== matchingUpdate) {
      queueNavigationUpdate(details.tabId, latestUpdate);
    }
    if (isBlankTabPage(details.url, hyperNewTabUrl)) {
      if (matchingUpdate) {
        void browser.tabs.get(details.tabId).then((tab) => {
          if (
            tabNavigationGenerations.get(details.tabId) === matchingUpdate.generation &&
            sameNavigationUrl(tabUrl(tab) ?? '', details.url)
          ) return browser.tabs.remove(details.tabId);
        }).catch(() => undefined);
      } else {
        suppressedDeduplicatedBackUrls.set(details.tabId, {
          close: true,
          expectedGeneration: (tabNavigationGenerations.get(details.tabId) ?? 0) + 1,
          url: details.url,
        });
        void browser.tabs.get(details.tabId).then((tab) => {
          if (sameNavigationUrl(tabUrl(tab) ?? '', details.url)) {
            suppressedDeduplicatedBackUrls.delete(details.tabId);
            return browser.tabs.remove(details.tabId);
          }
        }).catch(() => undefined);
      }
      return;
    }
    if (matchingUpdate) {
      queueRecoveredNavigation(details.tabId, matchingUpdate.generation);
    } else {
      suppressedDeduplicatedBackUrls.set(details.tabId, {
        close: false,
        expectedGeneration: (tabNavigationGenerations.get(details.tabId) ?? 0) + 1,
        url: details.url,
      });
    }
  };
  const recordTabStatus = (
    tabId: number,
    status: 'loading' | 'complete',
    incognito?: boolean,
  ) => {
    const record = () => {
      dependencies.tabStatuses.set(tabId, status);
      scheduleHyperModelReconciliation();
    };
    if (incognito !== undefined) {
      record();
      return;
    }
    // A navigation event can arrive after the tab has already moved on, and
    // adopting it would leave the model describing a page that has been left.
    void browser.tabs.get(tabId).then((tab) =>
      tabStatusAnnouncementIsCurrent(status, tab.status) ? record() : undefined,
    ).catch(() => undefined);
  };
  const beforeNavigate = (details: ListenerDetails<typeof browser.webNavigation.onBeforeNavigate>[0]) => {
    if (details.frameId !== 0) return;
    scheduleHyperModelReconciliation();
    recordTabStatus(details.tabId, 'loading');
  };
  const navigationCompleted = (details: ListenerDetails<typeof browser.webNavigation.onCompleted>[0]) => {
    if (details.frameId !== 0) return;
    scheduleHyperModelReconciliation();
    recordTabStatus(details.tabId, 'complete');
    // A wrapper page is still on its way to the page the tab was opened for.
    if (duplicateController.restartAtWrapperPage(details.tabId, details.url)) return;
    if (!isBlankTabPage(details.url, hyperNewTabUrl)) newTabNavigationIds.delete(details.tabId);
  };
  const navigationFailed = (details: ListenerDetails<typeof browser.webNavigation.onErrorOccurred>[0]) => {
    if (details.frameId !== 0) return;
    scheduleHyperModelReconciliation();
    // A failed load has still ended; one replaced by a newer navigation has not.
    if (details.error !== 'net::ERR_ABORTED') duplicateController.noteCommit(details);
    recordTabStatus(details.tabId, 'complete');
    if (!isBlankTabPage(details.url, hyperNewTabUrl)) newTabNavigationIds.delete(details.tabId);
    const pending = pendingDeduplicatedBacks.get(details.tabId);
    if (pending && !sameNavigationUrl(details.url, pending.sourceUrl)) releasePendingBack(details.tabId);
  };
  const tabUpdated = (
    tabId: number,
    changeInfo: ListenerDetails<typeof browser.tabs.onUpdated>[1],
    tab: Browser.tabs.Tab,
  ) => {
    if (changeInfo.status === 'loading' || changeInfo.status === 'complete') {
      recordTabStatus(tabId, changeInfo.status, tab.incognito);
    }
    if (changeInfo.url !== undefined) {
      const previousUrl = tabNavigationUrls.get(tabId);
      tabNavigationUrls.set(tabId, changeInfo.url);
      duplicateController.restartAtWrapperPage(tabId, changeInfo.url);
      const generation = advanceTabGeneration(tabNavigationGenerations, tabId);
      const newTabNavigation = newTabNavigationIds.has(tabId);
      const suppressed = suppressedDeduplicatedBackUrls.get(tabId);
      if (
        suppressed?.expectedGeneration === generation &&
        sameNavigationUrl(suppressed.url, changeInfo.url)
      ) {
        suppressedDeduplicatedBackUrls.delete(tabId);
        if (suppressed.close) {
          void browser.tabs.get(tabId).then((currentTab) => {
            if (
              tabNavigationGenerations.get(tabId) === generation &&
              isBlankTabPage(tabUrl(currentTab), hyperNewTabUrl)
            ) return browser.tabs.remove(tabId);
          }).catch(() => undefined);
        } else {
          queueRecoveredNavigation(tabId, generation);
        }
      } else {
        if (suppressed) suppressedDeduplicatedBackUrls.delete(tabId);
        const pending = pendingDeduplicatedBacks.get(tabId);
        if (pending) {
          pending.tabUpdates.push({
            generation,
            newTabNavigation,
            previousUrl,
            url: changeInfo.url,
          });
        } else {
          queueNavigationUpdate(tabId, { generation, newTabNavigation, previousUrl, url: changeInfo.url });
        }
      }
    } else if ('groupId' in changeInfo) {
      void queueGroupMutation(() => routeTabToBookmarkSpace(tabId, false)).catch(() => undefined);
    }
  };
  const tabRemoved = (tabId: number) => {
    tabNavigationUrls.delete(tabId);
    dependencies.tabStatuses.delete(tabId);
    dependencies.intentionalNewTabIds.delete(tabId);
    newTabNavigationIds.delete(tabId);
    pendingDeduplicatedBacks.delete(tabId);
    suppressedDeduplicatedBackUrls.delete(tabId);
    navigationDedupe.forgetTab(tabId);
    crossSpaceDuplicates.forgetTab(tabId);
  };

  return {
    beforeNavigate,
    historyNavigation,
    navigationCompleted,
    navigationFailed,
    seedNavigationUrls,
    tabCreated,
    tabRemoved,
    tabUpdated,
  };
}
