import { expect, test } from '@playwright/test';
import { callChrome } from './helpers/chrome';
import { withHyper } from './helpers/extension';
import { dragWithPointer, selectSpace, spaceDot } from './helpers/sidebar';
import { createSecondSpace } from './helpers/spaces';
import { createTab } from './helpers/tabs';

const firstUrl = 'https://space-race.test/first-group-projection';
const secondUrl = 'https://space-race.test/second-group-projection';
const tabRow = (url: string) =>
  `.tab-row:not([data-tab-node-id^="unsupported-tab:"]):has(.tab-main[data-url="${url}"])`;

test('browser activation uses the newly active space group after sidebar grouping', async () => {
  await withHyper('active-group-projection', async ({ page, worker }) => {
    await page.setViewportSize({ width: 900, height: 900 });
    await createSecondSpace(worker);

    await selectSpace(page, 'Second space');
    const secondTabId = await createTab(worker, secondUrl);
    await expect(page.locator(tabRow(secondUrl))).toBeVisible();

    await selectSpace(page, 'Space 1');
    const firstTabId = await createTab(worker, firstUrl);
    await expect(page.locator(tabRow(firstUrl))).toBeVisible();

    // Re-grouping in the active space leaves a local activeGroupId in the view.
    await dragWithPointer(
      page,
      page.locator(tabRow(firstUrl)),
      spaceDot(page, 'Space 1'),
    );
    const groupIds = await Promise.all([firstTabId, secondTabId].map(async (tabId) =>
      (await callChrome<{ groupId: number }>(worker, 'tabs.get', tabId)).groupId));
    expect(groupIds[0]).toBeGreaterThanOrEqual(0);
    expect(groupIds[1]).toBeGreaterThanOrEqual(0);
    expect(groupIds[0]).not.toBe(groupIds[1]);

    await callChrome(worker, 'tabs.update', secondTabId, { active: true });
    await expect(spaceDot(page, 'Second space'))
      .toHaveAttribute('aria-current', 'page');
    await expect(page.locator(tabRow(secondUrl))).toBeVisible();
    await expect(page.locator(tabRow(firstUrl))).toHaveCount(0);
  });
});
