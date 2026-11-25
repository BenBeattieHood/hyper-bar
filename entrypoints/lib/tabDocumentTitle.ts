interface TabDocumentTitleBrowser {
  scripting?: {
    executeScript?: (details: {
      args: [string];
      func: (nextTitle: string) => void;
      target: { tabId: number };
    }) => Promise<unknown>;
  };
  tabs?: {
    executeScript?: (tabId: number, details: { code: string }) => Promise<unknown>;
  };
}

/**
 * The backing rename remains useful when a page cannot accept a content script,
 * so setting its visible title is deliberately best-effort.
 */
export async function renameTabDocumentTitle(
  tabId: number,
  title: string,
  runtimeBrowser: TabDocumentTitleBrowser = (
    globalThis as unknown as { browser?: TabDocumentTitleBrowser }
  ).browser ?? {},
): Promise<boolean> {
  try {
    if (runtimeBrowser.scripting?.executeScript) {
      await runtimeBrowser.scripting.executeScript({
        args: [title],
        func: (nextTitle: string) => {
          document.title = nextTitle;
        },
        target: { tabId },
      });
      return true;
    }
    if (runtimeBrowser.tabs?.executeScript) {
      await runtimeBrowser.tabs.executeScript(tabId, {
        code: `document.title = ${JSON.stringify(title)}`,
      });
      return true;
    }
  } catch {
    return false;
  }
  return false;
}