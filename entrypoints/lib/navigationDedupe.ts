import { createKeyedCoalescer } from './async';
import { findReusableTab, focusTabInWindow, isBlankTabPage, pendingTabOperationIsCurrent, sameNavigationUrl, tabById } from './tabs';
import { getTabOwnership, loadTabOwnerships } from './tabOwnership';
import type { TimedMessages } from './timedMessages';
import { normaliseUrl, tabUrl } from './urlIdentity';
import { windowById } from './windowState';

/** The least time between one tab's updates for navigations that only change its fragment. */
export const FRAGMENT_UPDATE_INTERVAL_MS = 250;

/** One URL change of a tab, as the background hands it on for dedupe and routing. */
export interface NavigationUpdate {
  generation: number;
  newTabNavigation: boolean;
  previousUrl?: string;
  url: string;
}

/** Folds a newer navigation into one still waiting: it ends where the newer does, but began where the waiting one did. */
export function mergeNavigationUpdates(
  waiting: NavigationUpdate,
  next: NavigationUpdate,
): NavigationUpdate {
  if (next.generation < waiting.generation) return waiting;
  return {
    ...next,
    newTabNavigation: waiting.newTabNavigation || next.newTabNavigation,
    previousUrl: waiting.previousUrl,
  };
}

/**
 * Hands each tab's navigations to `run` through `enqueue`, folding those that
 * pile up meanwhile into one. A page that only rewrites its fragment, as some
 * do nonstop, is also held to one update per `FRAGMENT_UPDATE_INTERVAL_MS`.
 */
export function createNavigationUpdateQueue(
  enqueue: (operation: () => Promise<void>) => Promise<void>,
  run: (tabId: number, update: NavigationUpdate) => Promise<void>,
): (tabId: number, update: NavigationUpdate) => Promise<void> {
  const documents = createKeyedCoalescer(enqueue, run, { merge: mergeNavigationUpdates });
  const fragments = createKeyedCoalescer(enqueue, run, {
    merge: mergeNavigationUpdates,
    minIntervalMs: FRAGMENT_UPDATE_INTERVAL_MS,
  });
  return (tabId, update) => (
    update.previousUrl !== undefined && normaliseUrl(update.previousUrl) === normaliseUrl(update.url)
      ? fragments
      : documents
  )(tabId, update);
}

/** A tab sent back (or closed) because the page it opened is already open in its space. */
export interface PendingDeduplicatedBack {
  sourceGeneration: number;
  sourceOpenerTabId?: number;
  sourceWasActive: boolean;
  sourceWasNewTab: boolean;
  sourceTabId: number;
  sourceUrl: string;
  sourceWindowId: number;
  targetGeneration: number | undefined;
  targetSpaceId: string;
  targetTabId: number;
  targetUrl: string;
  targetWindowId: number;
  tabUpdates: NavigationUpdate[];
}

export interface NavigationDedupeDependencies {
  /** Each tab's navigation generation, advanced by the background on every navigation. */
  generations: ReadonlyMap<number, number>;
  /** A tab Hyper opens itself is not the user's new tab, so it is never deduped or offered dedupe. */
  markIntentionalTab(tabId: number): void;
  messages: Pick<TimedMessages, 'offer'>;
  newTabUrl: string;
  persistWindowActiveSpace(windowId: number, spaceId: string): Promise<void>;
  queueMutation<Result>(operation: () => Promise<Result>): Promise<Result>;
}

export const DEDUPLICATED_TAB_TEXT = 'Deduplicated tab';

const PENDING_BACK_TIMEOUT_MS = 500;

const tabShows = (tab: Browser.tabs.Tab, url: string) => sameNavigationUrl(tabUrl(tab) ?? '', url);

/** Both tabs, if a deduplicated back's source and target still show their pages in its space with the target in front. */
async function deduplicatedBackHolds(pending: PendingDeduplicatedBack, crossWindow: boolean) {
  const [source, sourceOwnership, target, targetOwnership, targetWindow] = await Promise.all([
    tabById(pending.sourceTabId),
    getTabOwnership(pending.sourceTabId),
    tabById(pending.targetTabId),
    getTabOwnership(pending.targetTabId),
    windowById(pending.targetWindowId),
  ]);
  const holds = source?.windowId === pending.sourceWindowId &&
    tabShows(source, pending.sourceUrl) &&
    sourceOwnership?.spaceId === pending.targetSpaceId &&
    target?.windowId === pending.targetWindowId &&
    tabShows(target, pending.targetUrl) &&
    targetOwnership?.spaceId === pending.targetSpaceId &&
    target.active &&
    (!crossWindow || targetWindow?.focused);
  return holds ? { source, target } : undefined;
}

/** Another tab in the same window and space already showing this page. */
async function sameSpaceTabShowing(
  source: { id: number; incognito: boolean; windowId: number },
  spaceId: string,
  identity: string,
) {
  const windowTabs = (await browser.tabs.query({ windowId: source.windowId }))
    .filter((tab) => tab.id !== undefined && tab.id !== source.id);
  const ownerships = await loadTabOwnerships(windowTabs);
  return findReusableTab(
    windowTabs.filter((tab) => ownerships[tab.id as number]?.spaceId === spaceId),
    identity,
    { incognito: source.incognito, windowId: source.windowId },
    'window',
  );
}

/**
 * Keeps one tab per page in a space and window: a tab that navigates to, or
 * opens, a page its space already shows hands focus to the existing tab and is
 * sent back or closed. Every step re-reads both tabs, so any change the user
 * makes meanwhile wins over the dedupe.
 */
export function createNavigationDedupe(dependencies: NavigationDedupeDependencies) {
  const { generations } = dependencies;
  const pendingBacks = new Map<number, PendingDeduplicatedBack>();
  // The page each tab was let keep after the user cancelled its dedupe, until it shows another.
  const kept = new Map<number, string>();

  /** Whether the user chose to keep this tab on this page; showing any other page ends that choice. */
  const keptDuplicate = (tabId: number, identity: string) => {
    const page = kept.get(tabId);
    if (page === identity) return true;
    if (page !== undefined) kept.delete(tabId);
    return false;
  };

  /**
   * Cancels a dedupe: the source tab makes the navigation it was taken back
   * from, or, if it was closed, opens again where it was.
   */
  const cancelDedupe = async (pending: PendingDeduplicatedBack, sourceIndex: number) => {
    const identity = normaliseUrl(pending.sourceUrl);
    if (!identity) throw new Error('That page can no longer be opened.');
    if (pendingBacks.get(pending.sourceTabId) === pending) pendingBacks.delete(pending.sourceTabId);
    const source = await tabById(pending.sourceTabId);
    if (source?.id !== undefined && source.windowId === pending.sourceWindowId) {
      kept.set(source.id, identity);
      await browser.tabs.update(source.id, { active: true, url: pending.sourceUrl });
    } else {
      if (!await windowById(pending.sourceWindowId)) {
        throw new Error('The window that tab was in has closed.');
      }
      const reopened = await browser.tabs.create({
        active: true,
        index: sourceIndex,
        url: pending.sourceUrl,
        windowId: pending.sourceWindowId,
      });
      if (reopened.id === undefined) return;
      dependencies.markIntentionalTab(reopened.id);
      kept.set(reopened.id, identity);
    }
    if (pending.sourceWindowId !== pending.targetWindowId) {
      await browser.windows.update(pending.sourceWindowId, { focused: true });
    }
  };

  /** Deduping is a best guess the user can cancel (build spec §27 case b). */
  const offerCancel = (pending: PendingDeduplicatedBack, sourceIndex: number, title?: string) => {
    dependencies.messages.offer(pending.targetWindowId, {
      act: () => dependencies.queueMutation(() => cancelDedupe(pending, sourceIndex)),
      ...(title ? { detail: title } : {}),
      kind: 'opt-out',
      tabId: pending.targetTabId,
      text: DEDUPLICATED_TAB_TEXT,
    });
  };

  const focusTarget = async (
    pending: PendingDeduplicatedBack,
    expectedSourceUrl: string,
    expectedSourceGeneration?: number,
    sourceUrlConfirmed = false,
  ): Promise<boolean> => {
    const readVisibility = async () => {
      const [source, sourceWindow, sourceOwnership, target, targetWindow, targetOwnership] =
        await Promise.all([
          tabById(pending.sourceTabId),
          windowById(pending.sourceWindowId),
          getTabOwnership(pending.sourceTabId),
          tabById(pending.targetTabId),
          windowById(pending.targetWindowId),
          getTabOwnership(pending.targetTabId),
        ]);
      const sourceMatches = Boolean(
        source?.windowId === pending.sourceWindowId &&
        (sourceUrlConfirmed ||
          tabShows(source, expectedSourceUrl)) &&
        sourceOwnership?.spaceId === pending.targetSpaceId &&
        (expectedSourceGeneration === undefined ||
          generations.get(pending.sourceTabId) === expectedSourceGeneration)
      );
      const targetMatches = Boolean(
        target?.id === pending.targetTabId &&
        target.windowId === pending.targetWindowId &&
        tabShows(target, pending.targetUrl) &&
        targetOwnership?.spaceId === pending.targetSpaceId &&
        generations.get(pending.targetTabId) === pending.targetGeneration
      );
      return {
        sourceIsActive: Boolean(sourceMatches && source?.active),
        sourceIsVisible: Boolean(sourceMatches && source?.active && sourceWindow?.focused),
        target,
        targetIsActive: Boolean(targetMatches && target?.active),
        targetIsVisible: Boolean(targetMatches && target?.active && targetWindow?.focused),
        targetMatches,
      };
    };
    const rememberTargetSpace = () => {
      void dependencies.persistWindowActiveSpace(pending.targetWindowId, pending.targetSpaceId)
        .catch(() => undefined);
    };
    const initial = await readVisibility();
    if (!initial.targetMatches) return false;
    const sameWindow = pending.sourceWindowId === pending.targetWindowId;
    if (initial.targetIsActive) {
      rememberTargetSpace();
      return true;
    }
    if (sameWindow) {
      if (!initial.sourceIsActive && !pending.sourceWasActive) return false;
    } else if (!initial.sourceIsVisible || initial.targetIsVisible) return false;
    try {
      const focused = await focusTabInWindow(
        pending.targetTabId,
        pending.targetWindowId,
        pending.sourceWindowId,
        browser,
        async () => {
          const current = await readVisibility();
          return current.targetMatches && (sameWindow
            ? pending.sourceWasActive || current.sourceIsActive || current.targetIsActive
            : current.sourceIsVisible || current.targetIsVisible);
        },
      );
      if (!focused) return false;
      const final = await readVisibility();
      if (!final.targetIsActive || (!sameWindow && !final.targetIsVisible)) return false;
      rememberTargetSpace();
      return true;
    } catch {
      return false;
    }
  };

  /** Closes the source once its back navigation has settled, if nothing has moved on. */
  const closeSourceAfterBack = (tabId: number, pendingBack: PendingDeduplicatedBack) => {
    setTimeout(() => {
      void (async () => {
        const expectedGenerations = [
          [tabId, pendingBack.sourceGeneration],
          [pendingBack.targetTabId, pendingBack.targetGeneration],
        ] as const;
        const isCurrent = () => pendingTabOperationIsCurrent(
          pendingBacks,
          tabId,
          pendingBack,
          generations,
          expectedGenerations,
        );
        if (!isCurrent()) return;
        const held = await deduplicatedBackHolds(
          pendingBack,
          pendingBack.sourceWindowId !== pendingBack.targetWindowId,
        );
        if (!isCurrent() || !held || held.source.openerTabId !== pendingBack.sourceOpenerTabId) return;
        pendingBacks.delete(tabId);
        await browser.tabs.remove(tabId).catch(() => undefined);
      })();
    }, PENDING_BACK_TIMEOUT_MS);
  };

  /** A tab that navigated to a page its space already shows goes back, and the existing tab takes focus. */
  const focusExistingSameSpaceNavigation = async (
    tabId: number,
    url: string,
    generation: number,
    previousUrl?: string,
    newTabNavigation = false,
  ): Promise<boolean> => {
    const identity = normaliseUrl(url);
    if (!identity || keptDuplicate(tabId, identity)) return false;
    const [tab, ownership] = await Promise.all([
      tabById(tabId),
      getTabOwnership(tabId),
    ]);
    const priorUrl = previousUrl ?? ownership?.url;
    if (
      !tab ||
      !tab.active ||
      generations.get(tabId) !== generation ||
      normaliseUrl(tabUrl(tab)) !== identity ||
      !ownership ||
      !priorUrl ||
      (!newTabNavigation && sameNavigationUrl(priorUrl, url))
    ) return false;
    const reusable = await sameSpaceTabShowing(
      { id: tabId, incognito: tab.incognito, windowId: tab.windowId },
      ownership.spaceId,
      identity,
    );
    if (reusable?.id === undefined) return false;
    const [latestSource, latestSourceWindow, latestTarget, latestTargetOwnership] = await Promise.all([
      tabById(tabId),
      windowById(tab.windowId),
      tabById(reusable.id),
      getTabOwnership(reusable.id),
    ]);
    const sameWindow = reusable.windowId === tab.windowId;
    if (
      !latestSource?.active ||
      (!sameWindow && !latestSourceWindow?.focused) ||
      generations.get(tabId) !== generation ||
      normaliseUrl(tabUrl(latestSource)) !== identity ||
      normaliseUrl(tabUrl(latestTarget)) !== identity ||
      latestTargetOwnership?.spaceId !== ownership.spaceId
    ) return false;
    const runtimeTabs = browser.tabs as typeof browser.tabs & {
      goBack?: (tabId: number) => Promise<void>;
    };
    if (!runtimeTabs.goBack) return false;
    const pendingBack: PendingDeduplicatedBack = {
      sourceGeneration: generation,
      sourceOpenerTabId: latestSource.openerTabId,
      sourceWasActive: true,
      sourceWasNewTab: newTabNavigation,
      sourceTabId: tabId,
      sourceUrl: tabUrl(latestSource) ?? url,
      sourceWindowId: latestSource.windowId,
      targetGeneration: generations.get(reusable.id),
      targetSpaceId: ownership.spaceId,
      targetTabId: reusable.id,
      targetUrl: tabUrl(latestTarget) ?? url,
      targetWindowId: reusable.windowId,
      tabUpdates: [],
    };
    if (!await focusTarget(
      pendingBack,
      pendingBack.sourceUrl,
      pendingBack.sourceGeneration,
    )) return false;
    const final = await deduplicatedBackHolds(pendingBack, !sameWindow);
    if (
      !final ||
      generations.get(tabId) !== generation ||
      generations.get(pendingBack.targetTabId) !== pendingBack.targetGeneration
    ) return false;
    if (pendingBack.sourceWasNewTab) {
      try {
        await browser.tabs.remove(tabId);
        offerCancel(pendingBack, latestSource.index, final.target.title);
        return true;
      } catch {
        // Fall through to history restoration if the source changed before removal.
      }
    }
    pendingBacks.set(tabId, pendingBack);
    try {
      await runtimeTabs.goBack(tabId);
    } catch {
      if (pendingBacks.get(tabId) !== pendingBack) return true;
      pendingBacks.delete(tabId);
      return focusTarget(
        pendingBack,
        pendingBack.sourceUrl,
        pendingBack.sourceGeneration,
      );
    }
    offerCancel(pendingBack, latestSource.index, final.target.title);
    closeSourceAfterBack(tabId, pendingBack);
    return true;
  };

  /** A new tab opened on a page its space already shows closes, and the existing tab takes focus. */
  const closeNewlyGroupedDuplicate = async (
    tabId: number,
    confirmedNavigation?: { generation: number; url: string },
    activeAtCreation = false,
  ): Promise<boolean> => {
    const [source, sourceOwnership] = await Promise.all([
      tabById(tabId),
      getTabOwnership(tabId),
    ]);
    const sourceUrl = tabUrl(source);
    if (!confirmedNavigation && isBlankTabPage(sourceUrl, dependencies.newTabUrl)) return false;
    const identity = normaliseUrl(confirmedNavigation?.url ?? sourceUrl);
    if (
      !source ||
      (!source.active && !activeAtCreation) ||
      !sourceOwnership ||
      !identity ||
      keptDuplicate(tabId, identity) ||
      (confirmedNavigation && generations.get(tabId) !== confirmedNavigation.generation)
    ) return false;
    const target = await sameSpaceTabShowing(
      { id: tabId, incognito: source.incognito, windowId: source.windowId },
      sourceOwnership.spaceId,
      identity,
    );
    if (target?.id === undefined) return false;
    const pending: PendingDeduplicatedBack = {
      sourceGeneration: confirmedNavigation?.generation ?? generations.get(tabId) ?? 0,
      sourceOpenerTabId: source.openerTabId,
      sourceWasActive: source.active || activeAtCreation,
      sourceWasNewTab: true,
      sourceTabId: tabId,
      sourceUrl: confirmedNavigation?.url ?? tabUrl(source) ?? '',
      sourceWindowId: source.windowId,
      targetGeneration: generations.get(target.id),
      targetSpaceId: sourceOwnership.spaceId,
      targetTabId: target.id,
      targetUrl: tabUrl(target) ?? '',
      targetWindowId: target.windowId,
      tabUpdates: [],
    };
    if (!await focusTarget(
      pending,
      pending.sourceUrl,
      confirmedNavigation?.generation,
      Boolean(confirmedNavigation),
    )) return false;
    const [latestSource, latestTarget, latestTargetOwnership] = await Promise.all([
      tabById(tabId),
      tabById(target.id),
      getTabOwnership(target.id),
    ]);
    if (
      (confirmedNavigation
        ? generations.get(tabId) !== confirmedNavigation.generation
        : normaliseUrl(tabUrl(latestSource)) !== identity) ||
      normaliseUrl(tabUrl(latestTarget)) !== identity ||
      latestTargetOwnership?.spaceId !== sourceOwnership.spaceId ||
      !latestTarget?.active
    ) return false;
    await browser.tabs.remove(tabId);
    offerCancel(pending, source.index, latestTarget.title);
    return true;
  };

  return {
    closeNewlyGroupedDuplicate,
    focusExistingSameSpaceNavigation,
    focusTarget,
    /** Forgets a closed tab's kept duplicate. */
    forgetTab(tabId: number) {
      kept.delete(tabId);
    },
    pendingBacks,
  };
}
