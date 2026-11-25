export interface BrowserCommandCapabilities {
  available: boolean;
  duplicateTab: boolean;
  navigateBack: boolean;
  navigateForward: boolean;
  restoreClosedTab: boolean;
  /** How many tabs one split view can show side by side; 0 where tabs cannot be split. */
  splitViewTabs: number;
  tabZoom: boolean;
}

export const noBrowserCommandCapabilities: BrowserCommandCapabilities = {
  available: false,
  duplicateTab: false,
  navigateBack: false,
  navigateForward: false,
  restoreClosedTab: false,
  splitViewTabs: 0,
  tabZoom: false,
};

interface RuntimeBrowser {
  sessions?: { restore?: unknown };
  tabs?: {
    createSplit?: unknown;
    duplicate?: unknown;
    getZoom?: unknown;
    goBack?: unknown;
    goForward?: unknown;
    setZoom?: unknown;
    unsplit?: unknown;
  };
  windows?: unknown;
}

export function readBrowserCommandCapabilities(
  runtimeBrowser: RuntimeBrowser = (
    globalThis as unknown as { browser?: RuntimeBrowser }
  ).browser ?? {},
): BrowserCommandCapabilities {
  const tabs = runtimeBrowser.tabs;
  return {
    available: Boolean(tabs && runtimeBrowser.windows),
    duplicateTab: typeof tabs?.duplicate === 'function',
    navigateBack: typeof tabs?.goBack === 'function',
    navigateForward: typeof tabs?.goForward === 'function',
    restoreClosedTab: typeof runtimeBrowser.sessions?.restore === 'function',
    // Chrome's createSplit pairs exactly two tabs.
    splitViewTabs: typeof tabs?.createSplit === 'function' && typeof tabs?.unsplit === 'function'
      ? 2
      : 0,
    tabZoom: typeof tabs?.getZoom === 'function' && typeof tabs?.setZoom === 'function',
  };
}