import type { BrowserTab } from './bookmarks';
import type { NewTabOrigin } from './duplicateController';
import type { NavigationUpdate } from './navigationDedupe';
import { focusTabInWindow, isBlankTabPage, tabById, tabsInBrowsingContext } from './tabs';
import { getTabOwnership, loadTabOwnerships, type TabOwnership } from './tabOwnership';
import type { TimedMessages } from './timedMessages';
import { normaliseUrl, tabUrl } from './urlIdentity';

/** The offer's text, naming the space that already shows the page. */
export function alreadyOpenText(spaceTitle: string | undefined): string {
  return `Already open in ${spaceTitle?.trim() || 'another space'}. Switch instead?`;
}

/** Hyper's own tabs, a restored session and a native Duplicate are not the user opening a page. */
export function offersSwitchOnFirstLoad(origin: NewTabOrigin): boolean {
  return origin !== 'hyper' && origin !== 'restored' && origin !== 'duplicate';
}

function isWebPage(identity: string): boolean {
  return /^(?:https?|file):/.test(identity);
}

/**
 * The tab another space shows this page in, preferring the source's window,
 * then a tab its window shows, then the oldest. None when the source's own
 * space already shows the page anywhere: same-space duplicates are
 * `navigationDedupe.ts` and `duplicateController.ts` business.
 */
export function otherSpaceTab(
  source: { id: number; incognito: boolean; spaceId: string; windowId: number },
  identity: string,
  tabs: readonly BrowserTab[],
  ownerships: Readonly<Record<number, Pick<TabOwnership, 'spaceId'>>>,
): { spaceId: string; tab: BrowserTab & { id: number } } | undefined {
  const showing = tabsInBrowsingContext([...tabs], source.incognito).filter((tab): tab is BrowserTab & { id: number } =>
    tab.id !== undefined &&
    tab.id !== source.id &&
    ownerships[tab.id] !== undefined &&
    normaliseUrl(tabUrl(tab)) === identity);
  if (showing.some((tab) => ownerships[tab.id]?.spaceId === source.spaceId)) return undefined;
  const rank = (tab: BrowserTab & { id: number }) =>
    (tab.windowId === source.windowId ? 0 : 2) + (tab.active ? 0 : 1);
  const [tab] = showing.sort((left, right) => (rank(left) - rank(right)) || (left.id - right.id));
  const spaceId = tab && ownerships[tab.id]?.spaceId;
  return tab && spaceId ? { spaceId, tab } : undefined;
}

interface PendingSwitch {
  /** The tab came new to this page, so taking it back closes it. */
  fromNewTab: boolean;
  identity: string;
  previousUrl?: string;
  sourceTabId: number;
  sourceWindowId: number;
  spaceTitle: string | undefined;
  targetSpaceId: string;
  targetTabId: number;
}

interface ChoosingClient {
  role: string;
  windowId: number;
}

export interface CrossSpaceDuplicatesDependencies {
  messages: Pick<TimedMessages, 'offer'>;
  newTabUrl: string;
  queueMutation<Result>(operation: () => Promise<Result>): Promise<Result>;
  spaceTitle(spaceId: string): string | undefined;
  /** Takes a window to the space a tab belongs to, as a tab click in the sidebar does. */
  tabSpaceSwitch: {
    admit(tabId: number, client: ChoosingClient): void;
    run(tabId: number, client: ChoosingClient): Promise<void>;
  };
}

/**
 * Offers to show the tab another space already has open for a page the user
 * just opened (build spec §13.6). The offer is opt-in: the user may well want
 * the page in this space too, so nothing happens unless they press the tick.
 * Then the window goes to that space and tab, and the tab the user just used
 * goes back, or closes if the page opened it.
 */
export function createCrossSpaceDuplicates(dependencies: CrossSpaceDuplicatesDependencies) {
  // How a tab's first page should be treated, until that page arrives.
  const firstLoads = new Map<number, 'exempt' | 'user'>();
  // The page each tab Hyper sent back is expected to show next.
  const returning = new Map<number, string | null>();

  /** Sends the source back where it was, unless it has already left the page. */
  const returnSource = async (pending: PendingSwitch) => {
    const source = await tabById(pending.sourceTabId);
    if (source?.id === undefined || normaliseUrl(tabUrl(source)) !== pending.identity) return;
    if (pending.fromNewTab) {
      await browser.tabs.remove(source.id).catch(() => undefined);
      return;
    }
    const runtimeTabs = browser.tabs as typeof browser.tabs & { goBack?: (tabId: number) => Promise<void> };
    if (!runtimeTabs.goBack) return;
    returning.set(source.id, normaliseUrl(pending.previousUrl));
    await runtimeTabs.goBack(source.id).catch(() => void returning.delete(source.id as number));
  };

  const switchToExisting = async (pending: PendingSwitch) => {
    const [target, ownership] = await Promise.all([
      tabById(pending.targetTabId),
      getTabOwnership(pending.targetTabId),
    ]);
    if (
      target?.id === undefined ||
      normaliseUrl(tabUrl(target)) !== pending.identity ||
      ownership?.spaceId !== pending.targetSpaceId
    ) throw new Error(`That page is no longer open in ${pending.spaceTitle?.trim() || 'that space'}.`);
    // The tick is pressed in a sidebar, so the switch goes as that sidebar's tab click would.
    const client = { role: 'sidebar', windowId: target.windowId };
    dependencies.tabSpaceSwitch.admit(target.id, client);
    await dependencies.tabSpaceSwitch.run(target.id, client);
    await focusTabInWindow(target.id, target.windowId, pending.sourceWindowId);
    await dependencies.queueMutation(() => returnSource(pending));
  };

  return {
    /** Whether this navigation is Hyper sending a tab back; it is never offered or deduped. */
    consumeReturn(tabId: number, url: string): boolean {
      if (!returning.has(tabId)) return false;
      const expected = returning.get(tabId);
      returning.delete(tabId);
      return expected === normaliseUrl(url);
    },

    forgetTab(tabId: number) {
      firstLoads.delete(tabId);
      returning.delete(tabId);
    },

    /** Called as a tab is created, before its first page arrives. */
    noteNewTab(tabId: number, origin: NewTabOrigin) {
      firstLoads.set(tabId, offersSwitchOnFirstLoad(origin) ? 'user' : 'exempt');
    },

    /** Offers the switch if another space already shows the page this navigation reached. */
    async offerSwitch(tabId: number, { newTabNavigation, previousUrl, url }: NavigationUpdate): Promise<boolean> {
      const identity = normaliseUrl(url);
      if (!identity || isBlankTabPage(url, dependencies.newTabUrl)) return false;
      const firstLoad = firstLoads.get(tabId);
      firstLoads.delete(tabId);
      if (firstLoad === 'exempt' || !isWebPage(identity)) return false;
      const fromNewTab = firstLoad === 'user' || newTabNavigation || !previousUrl ||
        isBlankTabPage(previousUrl, dependencies.newTabUrl);
      // A reload or a fragment change is not opening a page.
      if (!fromNewTab && normaliseUrl(previousUrl) === identity) return false;
      const source = await tabById(tabId);
      if (source?.id === undefined || normaliseUrl(tabUrl(source)) !== identity) return false;
      // Ownerships are read only for the tabs showing the page, so a busy browser costs one query.
      const tabs = (await browser.tabs.query({}))
        .filter((candidate) => normaliseUrl(tabUrl(candidate)) === identity);
      if (!tabs.some((candidate) => candidate.id !== source.id)) return false;
      const ownerships = await loadTabOwnerships(tabs);
      const sourceSpaceId = ownerships[source.id]?.spaceId;
      if (!sourceSpaceId) return false;
      const found = otherSpaceTab(
        { id: source.id, incognito: source.incognito, spaceId: sourceSpaceId, windowId: source.windowId },
        identity,
        tabs,
        ownerships,
      );
      if (!found) return false;
      const spaceTitle = dependencies.spaceTitle(found.spaceId);
      const pending: PendingSwitch = {
        fromNewTab,
        identity,
        ...(previousUrl ? { previousUrl } : {}),
        sourceTabId: source.id,
        sourceWindowId: source.windowId,
        spaceTitle,
        targetSpaceId: found.spaceId,
        targetTabId: found.tab.id,
      };
      dependencies.messages.offer(source.windowId, {
        act: () => switchToExisting(pending),
        ...(found.tab.title ? { detail: found.tab.title } : {}),
        kind: 'opt-in',
        tabId: source.id,
        text: alreadyOpenText(spaceTitle),
      });
      return true;
    },
  };
}

export type CrossSpaceDuplicates = ReturnType<typeof createCrossSpaceDuplicates>;
