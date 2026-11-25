import { showPageSearchOverlayMessageType } from './pageShortcut';
import { showSidebarDestination } from './sidebarDestination';

type SidebarDestination = 'tabs' | 'search';

const runtimeBrowser = () => browser as unknown as {
  action?: {
    onClicked?: {
      addListener: (listener: (tab: Browser.tabs.Tab) => void) => void;
    };
  };
  browserAction?: {
    onClicked?: {
      addListener: (listener: () => void) => void;
    };
  };
  sidebarAction?: {
    open?: () => Promise<void>;
  };
  sidePanel?: {
    open?: (options: { windowId: number }) => Promise<void>;
  };
};

export const enableActionToggle = async () => {
  const sidePanel = (browser as unknown as {
    sidePanel?: { setPanelBehavior?: typeof browser.sidePanel.setPanelBehavior };
  }).sidePanel;
  if (!sidePanel?.setPanelBehavior) return;
  await sidePanel
    .setPanelBehavior({ openPanelOnActionClick: false })
    .catch((error) => console.error('Unable to configure the side panel.', error));
};

/**
 * Opens the Hyper sidebar in the window the user is in. The focused normal
 * window is cached from focus events, because a side panel may only be opened
 * synchronously within the user gesture that asked for it.
 */
export function createSidebarOpener() {
  let lastFocusedNormalWindowId: number | undefined;
  let focusedWindowGeneration = 0;

  /** Caches the window a lookup finds, unless a later focus change has superseded it. */
  const cacheLookup = (lookup: Promise<Browser.windows.Window>, onFailure?: () => void) => {
    const generation = ++focusedWindowGeneration;
    void lookup.then((window) => {
      if (generation !== focusedWindowGeneration) return;
      lastFocusedNormalWindowId = window.type === 'normal' && window.focused
        ? window.id
        : undefined;
    }).catch(() => {
      if (generation === focusedWindowGeneration) onFailure?.();
    });
  };
  const cacheFocusedNormalWindow = (windowId: number | undefined) => {
    lastFocusedNormalWindowId = undefined;
    if (windowId === undefined || windowId === browser.windows.WINDOW_ID_NONE) {
      ++focusedWindowGeneration;
      return;
    }
    cacheLookup(browser.windows.get(windowId), () => { lastFocusedNormalWindowId = undefined; });
  };
  const resolveFocusedNormalWindow = async (): Promise<number> => {
    while (true) {
      if (lastFocusedNormalWindowId !== undefined) return lastFocusedNormalWindowId;
      const generation = focusedWindowGeneration;
      const window = await browser.windows.getLastFocused({ windowTypes: ['normal'] });
      if (generation !== focusedWindowGeneration) continue;
      if (window.id === undefined || window.type !== 'normal' || !window.focused) {
        throw new Error('The active browser window could not be identified.');
      }
      lastFocusedNormalWindowId = window.id;
      return window.id;
    }
  };
  const openHyperInWindow = async (
    windowId: number,
    destination: SidebarDestination = 'tabs',
  ): Promise<void> => {
    const runtime = runtimeBrowser();
    const openPanel = runtime.sidePanel?.open
      ? runtime.sidePanel.open({ windowId })
      : runtime.sidebarAction?.open?.();
    if (!openPanel) {
      throw new Error('This browser cannot open the Hyper sidebar.');
    }
    await openPanel;
    await showSidebarDestination(windowId, destination);
  };
  const openHyper = (
    tab?: Browser.tabs.Tab,
    destination: SidebarDestination = 'tabs',
  ): Promise<void> => {
    const immediateWindowId = tab?.windowId ?? lastFocusedNormalWindowId;
    if (immediateWindowId !== undefined) {
      return openHyperInWindow(immediateWindowId, destination);
    }
    return resolveFocusedNormalWindow().then((windowId) =>
      openHyperInWindow(windowId, destination));
  };
  const openPageSearchOverlay = async (sourceTab: Browser.tabs.Tab): Promise<void> => {
    if (sourceTab.id === undefined || sourceTab.windowId === undefined) {
      throw new Error('The page requesting Search could not be identified.');
    }
    await browser.tabs.sendMessage(sourceTab.id, {
      type: showPageSearchOverlayMessageType,
      sourceTabId: sourceTab.id,
      sourceWindowId: sourceTab.windowId,
    }, {
      frameId: 0,
    });
  };
  const registerActionClick = () => {
    const runtime = runtimeBrowser();
    if (runtime.action?.onClicked) {
      runtime.action.onClicked.addListener((tab) => {
        void openHyper(tab).catch((error) =>
          console.error('Unable to open Hyper.', error));
      });
    } else if (runtime.sidebarAction?.open) {
      runtime.browserAction?.onClicked?.addListener(() => {
        void runtime.sidebarAction?.open?.().catch((error) =>
          console.error('Unable to open the sidebar.', error));
      });
    }
  };

  cacheLookup(browser.windows.getLastFocused({ windowTypes: ['normal'] }));

  return {
    focusChanged: cacheFocusedNormalWindow,
    forgetWindow: (windowId: number) => {
      focusedWindowGeneration += 1;
      if (lastFocusedNormalWindowId === windowId) lastFocusedNormalWindowId = undefined;
    },
    lastFocusedNormalWindowId: () => lastFocusedNormalWindowId,
    openHyper,
    openPageSearchOverlay,
    registerActionClick,
  };
}
