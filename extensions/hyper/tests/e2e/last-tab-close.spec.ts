import { expect, test } from '@playwright/test';
import { readActiveSpaceId } from './fixtures/activeSpace';
import { callChrome } from './helpers/chrome';
import { withHyper } from './helpers/extension';
import { firstUrl, nativeTabBackingState, secondUrl } from './helpers/restoration';
import { spaceIdByTitle } from './helpers/spaces';
import { createTab, holdTabDrag, tabOwnershipSummary } from './helpers/tabs';
import type { ExtensionGlobal } from './helpers/extensionGlobal';

type TabEvent = { at: number; event: string; tabId?: number; url?: string; windowId?: number };

for (const { dragMs, title } of [
  { dragMs: 0, title: 'a tab dragged out into its own window closes that window when the tab closes' },
  { dragMs: 1_500, title: 'a tab closed just after its drag out of the strip closes its window' },
]) test(title, async () => {
  test.setTimeout(60_000);
  await withHyper('dragged-tab-close', async ({ worker }) => {
    const spaceId = await spaceIdByTitle(worker, 'Space 1');
    const firstTabId = await createTab(worker, firstUrl);
    const secondTabId = await createTab(worker, secondUrl);
    await expect.poll(() => tabOwnershipSummary(worker, [firstTabId, secondTabId]))
      .toEqual({ allOwned: true, spaceCount: 1 });

    // Every tab and window event from here on, to show what reacted to the close.
    await worker.evaluate(() => {
      const { chrome } = globalThis as unknown as ExtensionGlobal;
      const recorded = globalThis as unknown as { lastTabEvents: TabEvent[] };
      recorded.lastTabEvents = [];
      const push = (event: TabEvent) => recorded.lastTabEvents.push({ ...event, at: Date.now() });
      chrome.tabs.onCreated.addListener((tab) => push({
        at: 0, event: 'tabCreated', tabId: tab.id, url: tab.pendingUrl ?? tab.url, windowId: tab.windowId,
      }));
      chrome.tabs.onRemoved.addListener((tabId, info) => push({
        at: 0, event: info.isWindowClosing ? 'tabRemovedClosingWindow' : 'tabRemoved', tabId, windowId: info.windowId,
      }));
      chrome.windows.onCreated.addListener((window) => push({ at: 0, event: 'windowCreated', windowId: window.id }));
      chrome.windows.onRemoved.addListener((windowId) => push({ at: 0, event: 'windowRemoved', windowId }));
    });

    // Dragging a tab out of the tab strip opens a new window holding just that tab, as this does,
    // and the drag holds every tab strip until it ends.
    if (dragMs > 0) await holdTabDrag(worker, true);
    const windowId = (await callChrome<{ id?: number }>(worker, 'windows.create', { focused: true, tabId: secondTabId })).id;
    if (windowId === undefined) throw new Error('The browser did not create the window.');
    if (dragMs > 0) {
      await new Promise((resolveWait) => setTimeout(resolveWait, dragMs));
      await holdTabDrag(worker, false);
    }
    await expect.poll(() => readActiveSpaceId(worker, windowId), { timeout: 15_000 }).toBe(spaceId);
    await expect.poll(() => nativeTabBackingState(worker, secondTabId, secondUrl)).toMatchObject({
      ownership: { spaceId, windowId },
      tab: { groupId: expect.any(Number), windowId },
    });
    // The window holds only the dragged tab, so closing it leaves nothing to keep the window open.
    expect((await callChrome<Array<{ id?: number }>>(worker, 'tabs.query', { windowId })).map((tab) => tab.id))
      .toEqual([secondTabId]);

    // A middle click in the tab strip closes the tab as an ordinary close does.
    await callChrome(worker, 'tabs.remove', secondTabId);

    const windowOpen = async () =>
      (await callChrome<Array<{ id?: number }>>(worker, 'windows.getAll')).some((window) => window.id === windowId);
    const events = () => worker.evaluate(() =>
      (globalThis as unknown as { lastTabEvents: TabEvent[] }).lastTabEvents);
    await expect.poll(windowOpen, { timeout: 10_000 }).toBe(false);
    // Nothing reopens the window or the tab once it has gone.
    await new Promise((resolveWait) => setTimeout(resolveWait, 2_500));
    const recorded = await events();
    expect(recorded.filter((event) => event.event === 'tabCreated'), JSON.stringify(recorded)).toEqual([]);
  }, { closeInitialPage: true });
});
