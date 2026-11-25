import type { browser } from 'wxt/browser';

type Browser = typeof browser;

/**
 * The extension's `globalThis` for code passed to `worker.evaluate` or
 * `page.evaluate`. Type-only, so it is safe inside serialized callbacks.
 * Firefox-only session tab and window values are optional because Chromium
 * lacks them.
 */
export interface ExtensionGlobal {
  chrome: Omit<Browser, 'sessions'> & {
    sessions: Browser['sessions'] & {
      getTabValue?: (tabId: number, key: string) => Promise<unknown>;
      getWindowValue?: (windowId: number, key: string) => Promise<unknown>;
      removeTabValue?: (tabId: number, key: string) => Promise<void>;
      removeWindowValue?: (windowId: number, key: string) => Promise<void>;
      setTabValue?: (tabId: number, key: string, value: unknown) => Promise<void>;
      setWindowValue?: (windowId: number, key: string, value: unknown) => Promise<void>;
    };
  };
}
