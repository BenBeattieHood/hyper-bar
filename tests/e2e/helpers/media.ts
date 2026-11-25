import type { Page, Worker } from '@playwright/test';

/**
 * Headless Chromium never reports a tab as audible, so the tab query the model
 * reads is answered as though the motion page were playing. The query is in the
 * service worker while the tab event the sidebar listens for is in the panel, so
 * a simulated change has to reach both.
 */
export async function exposeMotionTabsAsAudible(page: Page, worker: Worker) {
  await page.addInitScript(() => {
    type TestTab = { id?: number; audible?: boolean };
    type TabUpdatedListener = (
      tabId: number,
      changeInfo: Record<string, unknown>,
      tab: TestTab,
    ) => void;
    const extension = globalThis as unknown as {
      chrome?: {
        tabs?: {
          group?: unknown;
          onUpdated?: {
            addListener: (listener: TabUpdatedListener) => void;
            removeListener: (listener: TabUpdatedListener) => void;
          };
        };
      };
    };
    if (!extension.chrome?.tabs) return;
    Object.defineProperty(extension.chrome.tabs, 'group', {
      configurable: true,
      value: undefined,
    });
    const onUpdated = extension.chrome.tabs.onUpdated;
    if (!onUpdated) return;
    const addListener = onUpdated.addListener.bind(onUpdated);
    const removeListener = onUpdated.removeListener.bind(onUpdated);
    const registeredListeners = new Set<TabUpdatedListener>();
    Object.defineProperty(onUpdated, 'addListener', {
      configurable: true,
      value: (listener: TabUpdatedListener) => {
        registeredListeners.add(listener);
        addListener(listener);
      },
    });
    Object.defineProperty(onUpdated, 'removeListener', {
      configurable: true,
      value: (listener: TabUpdatedListener) => {
        registeredListeners.delete(listener);
        removeListener(listener);
      },
    });
    Object.defineProperty(globalThis, 'dispatchMotionTabUpdatedForTest', {
      configurable: true,
      value: (tabId: number, changeInfo: Record<string, unknown>, tab: TestTab) => {
        registeredListeners.forEach((listener) => listener(tabId, changeInfo, tab));
      },
    });
  });
  await worker.evaluate(() => {
    type TestTab = {
      id?: number;
      audible?: boolean;
      pendingUrl?: string;
      url?: string;
    };
    const extension = globalThis as unknown as {
      chrome: {
        storage: { session: { set: (items: object) => Promise<void> } };
        tabs: { query: (options: object) => Promise<TestTab[]> };
      };
    };
    const tabs = extension.chrome.tabs;
    const query = tabs.query.bind(tabs);
    const audibleTabIds = new Set<number>();
    let defaultAudibleTabId: number | undefined;
    let audibleStateInitialised = false;
    const motionTabId = (queriedTabs: TestTab[]) => queriedTabs.find((tab) =>
      tab.id !== undefined &&
      (tab.pendingUrl ?? tab.url)?.startsWith('https://motion.test/shared'))?.id;
    const withAudibleMotionTab = (tab: TestTab): TestTab =>
      tab.id !== undefined && audibleTabIds.has(tab.id)
        ? { ...tab, audible: true }
        : { ...tab, audible: false };
    Object.defineProperty(tabs, 'query', {
      configurable: true,
      value: async (options: object) => {
        const queriedTabs = await query(options);
        defaultAudibleTabId ??= motionTabId(queriedTabs);
        if (defaultAudibleTabId !== undefined && !audibleStateInitialised) {
          audibleTabIds.add(defaultAudibleTabId);
          audibleStateInitialised = true;
        }
        return queriedTabs.map(withAudibleMotionTab);
      },
    });
    Object.defineProperty(globalThis, 'setMotionTabAudibleForTest', {
      configurable: true,
      value: async (nextAudible: boolean, requestedTabId?: number) => {
        const queriedTabs = await query({});
        defaultAudibleTabId ??= motionTabId(queriedTabs);
        const targetTabId = requestedTabId ?? defaultAudibleTabId;
        if (targetTabId === undefined) return undefined;
        if (nextAudible) audibleTabIds.add(targetTabId);
        else audibleTabIds.delete(targetTabId);
        // A real audible change would reach the model as a tab event; a stored
        // value is the harness equivalent it already watches for.
        await extension.chrome.storage.session.set({
          hyperTestAudibleGeneration: Date.now(),
        });
        const tab = queriedTabs.find((candidate) => candidate.id === targetTabId);
        return tab ? { tab: withAudibleMotionTab(tab), tabId: targetTabId } : undefined;
      },
    });
  });
}

export async function setMotionTabAudible(
  page: Page,
  worker: Worker,
  audible: boolean,
  tabId?: number,
) {
  const updated = await worker.evaluate(async ({ nextAudible, targetTabId }) => {
    const runtime = globalThis as unknown as {
      setMotionTabAudibleForTest: (
        value: boolean,
        tabId?: number,
      ) => Promise<{ tab: { id?: number }; tabId: number } | undefined>;
    };
    return runtime.setMotionTabAudibleForTest(nextAudible, targetTabId);
  }, { nextAudible: audible, targetTabId: tabId });
  if (!updated) return;
  await page.evaluate(({ nextAudible, tab, updatedTabId }) => {
    const runtime = globalThis as unknown as {
      dispatchMotionTabUpdatedForTest: (
        tabId: number,
        changeInfo: Record<string, unknown>,
        tab: object,
      ) => void;
    };
    runtime.dispatchMotionTabUpdatedForTest(
      updatedTabId,
      { audible: nextAudible },
      tab,
    );
  }, { nextAudible: audible, tab: updated.tab, updatedTabId: updated.tabId });
}
