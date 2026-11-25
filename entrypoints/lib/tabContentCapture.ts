import type { BrowserTab } from './bookmarks';
import { isRecord } from './collections';
import type { TabContentSnapshot, TabContentSnapshots } from './tabContent';
import { isHttpUrl, tabUrl } from './urlIdentity';

export interface CapturedTabContent {
  text: string;
  url: string;
}

/** Asks Hyper's page script in a tab's top frame for that page's text. */
export const capturePageTextMessageType = 'hyper:capture-page-text';

/** Whether a message asks the page script for its page's text. */
export function isCapturePageTextMessage(message: unknown): boolean {
  return isRecord(message) && message.type === capturePageTextMessageType;
}

function isCapturedTabContent(value: unknown): value is CapturedTabContent {
  if (!isRecord(value)) return false;
  const candidate = value as Partial<CapturedTabContent>;
  return typeof candidate.url === 'string' && typeof candidate.text === 'string';
}

/** Runs in the page script; waits for the document to be parsed, as the page's own text arrives then. */
export async function capturePageText(): Promise<CapturedTabContent> {
  if (document.readyState === 'loading') {
    await new Promise((resolve) => document.addEventListener('DOMContentLoaded', resolve, { once: true }));
  }
  const headings = Array.from(document.querySelectorAll('h1, h2, h3'))
    .map((heading) => heading.textContent)
    .filter(Boolean)
    .join('\n');
  return {
    url: location.href,
    text: `${document.title}\n${headings}\n${document.body?.innerText ?? ''}`
      .slice(0, 30_000),
  };
}

/** Rejects when the tab has no page script to answer, such as a page opened before Hyper loaded. */
export async function captureTabContent(tabId: number): Promise<CapturedTabContent> {
  const result: unknown = await browser.tabs.sendMessage(
    tabId,
    { type: capturePageTextMessageType },
    { frameId: 0 },
  );
  return isCapturedTabContent(result) ? result : { text: '', url: '' };
}

/** Captures only live, non-private HTTP(S) tabs the caller has selected. */
export async function captureTabContents(
  tabs: readonly BrowserTab[],
  navigationVersions: Readonly<Record<number, number>>,
  selectedTabIds?: ReadonlySet<number>,
): Promise<TabContentSnapshots> {
  const entries = await Promise.all(tabs.map(async (tab): Promise<
    [number, TabContentSnapshot] | undefined
  > => {
    const url = tabUrl(tab);
    if (
      tab.id === undefined ||
      tab.incognito ||
      tab.discarded ||
      !isHttpUrl(url) ||
      selectedTabIds && !selectedTabIds.has(tab.id)
    ) return undefined;
    try {
      const captured = await captureTabContent(tab.id);
      if (!captured.url) return undefined;
      return [tab.id, {
        ...captured,
        navigationVersion: navigationVersions[tab.id] ?? 0,
      }];
    } catch {
      return undefined;
    }
  }));
  return Object.fromEntries(entries.filter((entry) => entry !== undefined));
}
