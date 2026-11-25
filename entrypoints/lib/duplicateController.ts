import type { TabOwnership } from './tabOwnership';
import type { TimedMessages } from './timedMessages';
import { isBlankTabPage, tabById } from './tabs';
import { normaliseUrl, pageIdentity, tabUrl } from './urlIdentity';

// Bounds how long a new tab's first load, with its redirects, may take to settle.
const CANDIDATE_MS = 10_000;
const COMMIT_WAIT_MS = 500;

/**
 * How a tab came to exist, as far as the browser lets the background tell.
 *
 * `blank` tabs take a typed address, and `foreground-link` tabs are what a page
 * opens for itself, so both stay subject to automatic dedupe; the rest are
 * copies the user asked for.
 */
export type NewTabOrigin =
  | 'background-link'
  | 'blank'
  | 'duplicate'
  | 'external'
  | 'foreground-link'
  | 'hyper'
  | 'restored';

export function newTabOrigin(facts: {
  copiedOwnership: boolean;
  intentional: boolean;
  newTabUrl: string;
  restored: boolean;
  tab: Pick<Browser.tabs.Tab, 'active' | 'openerTabId' | 'pendingUrl' | 'url'>;
}): NewTabOrigin {
  const { tab } = facts;
  if (facts.intentional) return 'hyper';
  if (facts.copiedOwnership) return 'duplicate';
  if (facts.restored) return 'restored';
  if (tab.openerTabId !== undefined) {
    // Chromium's Duplicate names the active tab as opener, but arrives showing its page; a link arrives empty.
    if (tab.url && !isBlankTabPage(tab.url, facts.newTabUrl)) return 'duplicate';
    // A ctrl/cmd or middle click, or Open link in new tab, leaves its tab in the background.
    return tab.active ? 'foreground-link' : 'background-link';
  }
  return isBlankTabPage(tabUrl(tab), facts.newTabUrl) ? 'blank' : 'external';
}

export function allowsDuplicate(origin: NewTabOrigin): boolean {
  return origin === 'background-link' || origin === 'duplicate' || origin === 'external';
}

/** A countdown is only offered while its tab is still in the window it was offered to. */
type DuplicateTab = Pick<Browser.tabs.Tab, 'id' | 'pendingUrl' | 'url' | 'windowId'>;

interface OwnedTab {
  ownership?: Pick<TabOwnership, 'spaceId'>;
  tab: DuplicateTab;
}

/** The oldest older tab of the same space and window showing the same address and query; tab IDs only grow. */
export function duplicateOriginal(
  subject: OwnedTab,
  candidates: readonly OwnedTab[],
): DuplicateTab | undefined {
  const identity = normaliseUrl(tabUrl(subject.tab));
  const spaceId = subject.ownership?.spaceId;
  if (!identity || !spaceId || subject.tab.id === undefined) return undefined;
  return candidates
    .filter(({ ownership, tab }) =>
      tab.id !== undefined &&
      tab.id < (subject.tab.id as number) &&
      tab.windowId === subject.tab.windowId &&
      ownership?.spaceId === spaceId &&
      normaliseUrl(tabUrl(tab)) === identity)
    .map(({ tab }) => tab)
    .sort((left, right) => (left.id as number) - (right.id as number))[0];
}

export interface DuplicateControllerDependencies {
  getTabOwnership(tabId: number): Promise<TabOwnership | undefined>;
  messages: Pick<TimedMessages, 'offer'>;
  now?: () => number;
  queueMutation<Result>(operation: () => Promise<Result>): Promise<Result>;
}

export interface DuplicateController {
  /** Keeps a copy the user asked for, offering a brief chance to dedupe it. */
  allow(tabId: number): Promise<boolean>;
  /** Whether a tab is still settling on the page the user opened it for. */
  isCandidate(tabId: number): boolean;
  /** Asked once the commit of `url` has been seen, since a URL update can outrun it. */
  isCandidateAt(tabId: number, url: string): Promise<boolean>;
  /** `url` is the page the tab was opened for, when the browser has said. */
  markCandidate(tabId: number, url?: string): void;
  /** A navigation after the first load, unless a redirect, is the user's own. */
  noteCommit(details: {
    frameId: number;
    tabId: number;
    transitionQualifiers?: readonly string[];
    url: string;
  }): void;
  removeTab(tabId: number): void;
  /**
   * A wrapper page such as Safe Links hands over to the real destination by
   * redirect, so a tab reaching one is still settling. Answers whether it was one.
   */
  restartAtWrapperPage(tabId: number, url: string | undefined): boolean;
}

/** Safe Links wraps links opened from Teams or Outlook outside the browser. */
function isRedirectWrapperPage(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' &&
      parsed.hostname === 'teams.public.onecdn.static.microsoft' &&
      parsed.pathname === '/evergreen-assets/safelinks/2/atp-safelinks.html';
  } catch {
    return false;
  }
}

export function createDuplicateController(
  dependencies: DuplicateControllerDependencies,
): DuplicateController {
  const now = dependencies.now ?? Date.now;
  const loads = new Map<number, {
    candidate: boolean;
    commits: number;
    deadline: number;
    url?: string;
  }>();
  // Counted for every tab, so a commit that outruns the candidate mark still counts as the first.
  const commits = new Map<number, { count: number; url: string }>();
  const commitWaiters = new Map<number, Set<() => void>>();
  const isCandidate = (tabId: number) => {
    const load = loads.get(tabId);
    return Boolean(load?.candidate && load.deadline > now());
  };
  const committed = (tabId: number, url: string) => new Promise<void>((resolve) => {
    if (commits.get(tabId)?.url === url) {
      resolve();
      return;
    }
    const waiters = commitWaiters.get(tabId) ?? new Set<() => void>();
    commitWaiters.set(tabId, waiters);
    const settle = () => {
      clearTimeout(timer);
      waiters.delete(check);
      if (waiters.size === 0) commitWaiters.delete(tabId);
      resolve();
    };
    const check = () => {
      if (commits.get(tabId)?.url === url) settle();
    };
    const timer = setTimeout(settle, COMMIT_WAIT_MS);
    waiters.add(check);
  });
  const findOriginal = async (tabId: number) => {
    const tab = await tabById(tabId);
    if (!tab || tab.incognito) return undefined;
    const candidates = await Promise.all(
      (await browser.tabs.query({ windowId: tab.windowId })).map(async (candidate) => ({
        ownership: candidate.id === undefined
          ? undefined
          : await dependencies.getTabOwnership(candidate.id),
        tab: candidate,
      })),
    );
    const subject = { ownership: await dependencies.getTabOwnership(tabId), tab };
    const original = duplicateOriginal(subject, candidates);
    return original && { original, subject };
  };

  /** Closes the copy the user kept, showing them the tab it copied if they were on it. */
  const dedupe = (tabId: number, windowId: number) => dependencies.queueMutation(async () => {
    const found = await findOriginal(tabId);
    if (!found || found.subject.tab.windowId !== windowId) {
      throw new Error('This tab no longer duplicates another tab here.');
    }
    if (found.subject.tab.active && found.original.id !== undefined) {
      await browser.tabs.update(found.original.id, { active: true });
    }
    await browser.tabs.remove(tabId);
  });

  return {
    async allow(tabId) {
      const found = await findOriginal(tabId);
      if (!found) return false;
      const { windowId } = found.subject.tab;
      dependencies.messages.offer(windowId, {
        act: () => dedupe(tabId, windowId),
        kind: 'opt-in',
        tabId,
        text: 'Deduplicate?',
      });
      return true;
    },
    isCandidate,
    async isCandidateAt(tabId, url) {
      if (!loads.has(tabId)) return false;
      await committed(tabId, url);
      return isCandidate(tabId);
    },
    markCandidate(tabId, url) {
      loads.set(tabId, {
        candidate: true,
        commits: 0,
        deadline: now() + CANDIDATE_MS,
        ...(url ? { url } : {}),
      });
    },
    noteCommit({ frameId, tabId, transitionQualifiers = [], url }) {
      if (frameId !== 0) return;
      const count = (commits.get(tabId)?.count ?? 0) + 1;
      commits.set(tabId, { count, url });
      const load = loads.get(tabId);
      const redirected = transitionQualifiers.includes('client_redirect') ||
        transitionQualifiers.includes('server_redirect');
      // Navigating elsewhere before the first load commits aborts it, so that load is never counted.
      const elsewhere = load?.url !== undefined && pageIdentity(load.url) !== pageIdentity(url);
      if (load && !redirected && (count - load.commits > 1 || elsewhere)) loads.delete(tabId);
      for (const resolve of commitWaiters.get(tabId) ?? []) resolve();
    },
    removeTab(tabId) {
      loads.delete(tabId);
      commits.delete(tabId);
    },
    restartAtWrapperPage(tabId, url) {
      if (!isRedirectWrapperPage(url)) return false;
      loads.set(tabId, {
        candidate: true,
        commits: commits.get(tabId)?.count ?? 0,
        deadline: now() + CANDIDATE_MS,
      });
      return true;
    },
  };
}
