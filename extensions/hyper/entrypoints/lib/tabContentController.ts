import { createCoalescedAsyncRunner } from './async';
import { hyperModelAtom, type HyperModelStore } from './model';
import { tabContentRefreshIds, type TabContentSnapshots } from './tabContent';
import { captureTabContents } from './tabContentCapture';

export interface TabContentControllerDependencies {
  reconcile(): Promise<unknown>;
  store: HyperModelStore;
}

export interface TabContentController {
  markNavigation(tabId: number): void;
  removeTab(tabId: number): void;
  refresh(): Promise<void>;
  runtimeSignals(): {
    contentSnapshots: TabContentSnapshots;
    contentVersions: Readonly<Record<number, number>>;
  };
}

/**
 * Holds discardable page-text cache data beside the background model while the
 * `pageTextSearch` preference is on. A fresh reconciliation filters every entry
 * against the current tab URL and navigation version before it can enter a projection.
 */
export function createTabContentController(
  dependencies: TabContentControllerDependencies,
): TabContentController {
  let capturedSnapshots: TabContentSnapshots = {};
  const contentVersions = new Map<number, number>();
  // A tab is asked once per navigation version and load status, so a capture sent
  // before the new page's script was listening is retried once the page loads.
  const attemptedCaptures = new Map<number, string>();

  const clearSnapshots = () => {
    capturedSnapshots = {};
    attemptedCaptures.clear();
  };

  const refresh = createCoalescedAsyncRunner(async () => {
    const snapshot = dependencies.store.get(hyperModelAtom);
    if (!snapshot.runtime.preferences.pageTextSearch) {
      if (Object.keys(capturedSnapshots).length > 0 || attemptedCaptures.size > 0) {
        clearSnapshots();
        await dependencies.reconcile();
      }
      return;
    }
    const { tabContentVersions } = snapshot.runtime;
    const attemptKeys = new Map(snapshot.browser.tabs.flatMap((tab) => tab.id === undefined
      ? []
      : [[tab.id, `${tabContentVersions[tab.id] ?? 0}:${tab.status ?? ''}`] as const]));
    const refreshIds = tabContentRefreshIds(
      snapshot.browser.tabs,
      tabContentVersions,
      capturedSnapshots,
    ).filter((tabId) => attemptedCaptures.get(tabId) !== attemptKeys.get(tabId));
    if (refreshIds.length === 0) return;

    for (const tabId of refreshIds) attemptedCaptures.set(tabId, attemptKeys.get(tabId) ?? '');
    const nextSnapshots = await captureTabContents(
      snapshot.browser.tabs,
      tabContentVersions,
      new Set(refreshIds),
    );
    if (Object.keys(nextSnapshots).length === 0) return;
    capturedSnapshots = { ...capturedSnapshots, ...nextSnapshots };
    await dependencies.reconcile();
  });

  dependencies.store.sub(hyperModelAtom, () => {
    void refresh().catch((error) => {
      console.error('Unable to refresh page-content search.', error);
    });
  });

  const forgetTab = (tabId: number) => {
    const nextSnapshots = { ...capturedSnapshots };
    delete nextSnapshots[tabId];
    capturedSnapshots = nextSnapshots;
    attemptedCaptures.delete(tabId);
  };

  return {
    markNavigation(tabId) {
      contentVersions.set(tabId, (contentVersions.get(tabId) ?? 0) + 1);
      forgetTab(tabId);
    },
    removeTab(tabId) {
      forgetTab(tabId);
      contentVersions.delete(tabId);
    },
    refresh,
    runtimeSignals: () => ({
      contentSnapshots: capturedSnapshots,
      contentVersions: Object.fromEntries(contentVersions),
    }),
  };
}
