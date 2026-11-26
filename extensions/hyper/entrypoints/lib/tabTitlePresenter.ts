import type { BrowserTab } from './bookmarks';
import type { HyperModelSnapshot } from './model';
import { tabNameText, type TabBookmarkLink, type TabName } from './tabBookmarkLink';
import { isHttpUrl } from './urlIdentity';

const REAPPLY_INTERVAL_MS = 1_000;

export type TabTitleUpdate =
  | { kind: 'name'; tabId: number; title: string }
  | { kind: 'restore'; tabId: number; title: string };

function isWebPage(tab: BrowserTab): boolean {
  return isHttpUrl(tab.url) && !tab.incognito && !tab.discarded;
}

/**
 * Which tabs' document titles should change: a tab with a name shows it, and a
 * tab whose name Hyper applied but which no longer has one gets its page title
 * back. A bookmark's name waits until the link is recorded on the tab, so the
 * backing can always tell the name from the page's own title.
 */
export function tabTitleUpdates(
  tabs: readonly BrowserTab[],
  names: ReadonlyMap<number, TabName>,
  links: ReadonlyMap<number, TabBookmarkLink>,
  applied: ReadonlyMap<number, string>,
  pageTitles: ReadonlyMap<number, string> = new Map(),
): TabTitleUpdate[] {
  return tabs.flatMap((tab): TabTitleUpdate[] => {
    if (tab.id === undefined || !isWebPage(tab)) return [];
    const name = names.get(tab.id);
    const presentable = name && (name.source === 'tab' || links.get(tab.id)?.persisted);
    if (presentable) {
      const title = tabNameText(name);
      return tab.title === title ? [] : [{ kind: 'name', tabId: tab.id, title }];
    }
    // Until the backing keeps the page's title, the name stays rather than be restored to nothing.
    const pageTitle = pageTitles.get(tab.id);
    return applied.has(tab.id) && applied.get(tab.id) === tab.title && pageTitle !== undefined
      ? [{ kind: 'restore', tabId: tab.id, title: pageTitle }]
      : [];
  });
}

export interface TabTitlePresenterDependencies {
  now?: () => number;
  setDocumentTitle(tabId: number, title: string): Promise<boolean>;
}

/**
 * Keeps the browser's tab strip showing the names Hyper shows. Pages rewrite
 * their own titles as they load or update, so a name is re-applied whenever the
 * page changes it, at most once a second per tab.
 */
export function createTabTitlePresenter(dependencies: TabTitlePresenterDependencies) {
  const now = dependencies.now ?? Date.now;
  const applied = new Map<number, string>();
  const appliedAt = new Map<number, number>();
  // A page the browser will not let Hyper script stays unscripted until it navigates.
  const unscriptable = new Map<number, string | undefined>();
  const timers = new Map<number, ReturnType<typeof setTimeout>>();
  let latest: HyperModelSnapshot | undefined;

  const run = async (update: TabTitleUpdate, url: string | undefined) => {
    const { title } = update;
    appliedAt.set(update.tabId, now());
    if (!await dependencies.setDocumentTitle(update.tabId, title)) {
      unscriptable.set(update.tabId, url);
      return;
    }
    if (update.kind === 'name') applied.set(update.tabId, title);
    else applied.delete(update.tabId);
  };

  const present = (snapshot: HyperModelSnapshot) => {
    latest = snapshot;
    const urls = new Map(snapshot.browser.tabs.map((tab) => [tab.id, tab.url] as const));
    for (const [tabId, url] of unscriptable) {
      if (urls.get(tabId) !== url) unscriptable.delete(tabId);
    }
    const updates = tabTitleUpdates(
      snapshot.browser.tabs,
      snapshot.derived.tabNames,
      snapshot.derived.tabBookmarkLinks,
      applied,
      snapshot.derived.tabPageTitles,
    );
    for (const update of updates) {
      if (unscriptable.has(update.tabId) || timers.has(update.tabId)) continue;
      const wait = (appliedAt.get(update.tabId) ?? -Infinity) + REAPPLY_INTERVAL_MS - now();
      if (wait > 0) {
        timers.set(update.tabId, setTimeout(() => {
          timers.delete(update.tabId);
          if (latest) present(latest);
        }, wait));
        continue;
      }
      void run(update, urls.get(update.tabId)).catch(() => undefined);
    }
  };

  return {
    present,
    removeTab(tabId: number) {
      applied.delete(tabId);
      appliedAt.delete(tabId);
      unscriptable.delete(tabId);
      clearTimeout(timers.get(tabId));
      timers.delete(tabId);
    },
  };
}
