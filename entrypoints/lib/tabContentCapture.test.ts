import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  capturePageTextMessageType,
  captureTabContent,
  captureTabContents,
} from './tabContentCapture';

afterEach(() => vi.unstubAllGlobals());

describe('tab content capture', () => {
  it('asks the page script in the tab top frame for its text', async () => {
    const sendMessage = vi.fn(async () => ({
      text: 'Heading and body',
      url: 'https://example.test/page',
    }));
    vi.stubGlobal('browser', { tabs: { sendMessage } });

    await expect(captureTabContent(7)).resolves.toEqual({
      text: 'Heading and body',
      url: 'https://example.test/page',
    });
    expect(sendMessage).toHaveBeenCalledWith(7, { type: capturePageTextMessageType }, { frameId: 0 });
  });

  it('captures only selected eligible tabs whose page script answers', async () => {
    const sendMessage = vi.fn(async (tabId: number) => {
      if (tabId === 5) throw new Error('Receiving end does not exist.');
      return { text: `Text ${tabId}`, url: `https://example.test/${tabId}` };
    });
    vi.stubGlobal('browser', { tabs: { sendMessage } });

    await expect(captureTabContents([
      { id: 1, url: 'https://example.test/1' } as Browser.tabs.Tab,
      { id: 2, url: 'https://example.test/2' } as Browser.tabs.Tab,
      { id: 3, url: 'chrome://settings' } as Browser.tabs.Tab,
      { id: 4, url: 'https://private.test', incognito: true } as Browser.tabs.Tab,
      { id: 5, url: 'https://opened-before-hyper.test' } as Browser.tabs.Tab,
    ], { 1: 4, 2: 9 }, new Set([2, 3, 4, 5]))).resolves.toStrictEqual({
      2: { navigationVersion: 9, text: 'Text 2', url: 'https://example.test/2' },
    });
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });
});
