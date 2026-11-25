import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { withHyper } from './helpers/extension';
import { createTab } from './helpers/tabs';
import type { ExtensionGlobal } from './helpers/extensionGlobal';
import { tabRowSelector } from './helpers/rows';

// Chrome stops an idle extension worker, and the sidebar reconnects while it
// wakes. A click made in that gap must still happen rather than do nothing.
async function sleepBackgroundWorker(context: BrowserContext, page: Page) {
  const devtools = await context.newCDPSession(page);
  await devtools.send('ServiceWorker.enable');
  await devtools.send('ServiceWorker.stopAllWorkers');
}

// The stopped worker's handle never answers, and the sidebar is an extension page too.
async function isActive(sidebar: Page, tabId: number) {
  return sidebar.evaluate(async (id) => {
    const extension = globalThis as unknown as ExtensionGlobal;
    return (await extension.chrome.tabs.get(id)).active;
  }, tabId);
}

async function countTabs(sidebar: Page) {
  return sidebar.evaluate(async () => {
    const extension = globalThis as unknown as ExtensionGlobal;
    return (await extension.chrome.tabs.query({})).length;
  });
}

test('a click made while the background worker wakes still happens', async () => {
  await withHyper('sleeping-worker', async ({ context, page: sidebar, worker }) => {
    const firstTabId = await createTab(worker, 'https://space-race.test/one');
    const secondTabId = await createTab(worker, 'https://space-race.test/two');
    await sidebar.bringToFront();

    await sidebar.getByRole('button', { name: 'Search tabs and history' }).click();
    await sidebar.getByRole('combobox', { name: 'Search tabs, bookmarks, history, or commands' })
      .fill('space-race.test/one');
    const result = sidebar.locator('.command-bar-results [role="option"]', {
      hasText: 'space-race.test/one',
    }).filter({ hasNotText: 'Go to' });
    await expect(result).toHaveCount(1);
    const tabCount = await countTabs(sidebar);
    await sleepBackgroundWorker(context, sidebar);
    await result.click();
    await expect.poll(() => isActive(sidebar, firstTabId)).toBe(true);
    expect(await countTabs(sidebar)).toBe(tabCount);
    await expect(sidebar.locator('.command-bar')).toHaveCount(0);

    const treeRow = sidebar.locator(
      `${tabRowSelector(secondTabId)} .tab-main`,
    );
    await expect(treeRow).toBeVisible();
    await sleepBackgroundWorker(context, sidebar);
    await treeRow.click();
    await expect.poll(() => isActive(sidebar, secondTabId)).toBe(true);
    await expect(sidebar.getByText('could not be', { exact: false })).toHaveCount(0);
  });
});
