import { expect, test, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { callChrome } from './helpers/chrome';
import { routeLinkPage, withHyper } from './helpers/extension';
import { answerNotice } from './helpers/sidebar';
import { createTab, navigationState, pageAtUrl, tabOwnershipSummary, tabsUnder } from './helpers/tabs';

const ORIGINAL = 'https://dedupe.test/one';
const LINK_PAGE = 'https://dedupe.test/two';

async function activate(worker: Worker, tabId: number) {
  const tab = await callChrome<{ windowId: number }>(worker, 'tabs.get', tabId);
  await callChrome(worker, 'tabs.update', tabId, { active: true });
  await callChrome(worker, 'windows.update', tab.windowId, { focused: true });
}

/** Opens the original page and a page linking to it, with the link page active. */
async function withDuplicateLink(
  run: (hyper: { context: BrowserContext; original: number; page: Page; source: Page; sourceTab: number; worker: Worker }) => Promise<void>,
) {
  await withHyper('dedupe-cancel', async ({ context, page, worker }) => {
    await routeLinkPage(context, /^https:\/\/dedupe\.test\//, 'Dedupe page', ORIGINAL);
    await page.setViewportSize({ width: 720, height: 900 });
    await expect(page.locator('.space-pagination-dot')).toHaveCount(1);
    const original = await createTab(worker, ORIGINAL);
    const sourceTab = await createTab(worker, LINK_PAGE);
    await expect.poll(() => tabOwnershipSummary(worker, [original, sourceTab]))
      .toEqual({ allOwned: true, spaceCount: 1 });
    await activate(worker, sourceTab);
    await expect.poll(async () => (await navigationState(worker, [original, sourceTab])).activeTabId).toBe(sourceTab);
    const source = await pageAtUrl(context, LINK_PAGE);
    await run({ context, original, page, source, sourceTab, worker });
  }, { closeInitialPage: true });
}

const cancelDedupe = (page: Page) => answerNotice(page, 'Deduplicated tab', 'No, cancel it', 'lucide-x');

const allTabUrls = (worker: Worker) => tabsUnder(worker, 'https://dedupe.test/');

test('following a link to a page already open dedupes, and the cross lets the link open after all', async () => {
  await withDuplicateLink(async ({ original, page, source, sourceTab, worker }) => {
    await source.click('#same');

    await expect.poll(() => navigationState(worker, [original, sourceTab])).toMatchObject({
      activeTabId: original,
      urlsByTabId: { [original]: ORIGINAL, [sourceTab]: LINK_PAGE },
    });
    await cancelDedupe(page);

    await expect.poll(() => navigationState(worker, [original, sourceTab])).toMatchObject({
      activeTabId: sourceTab,
      urlsByTabId: { [original]: ORIGINAL, [sourceTab]: ORIGINAL },
    });
    // The kept duplicate is the user's choice, so it is neither deduped again nor offered dedupe.
    await page.waitForTimeout(1_500);
    expect((await navigationState(worker, [original, sourceTab])).urlsByTabId[sourceTab]).toBe(ORIGINAL);
    await expect(page.locator('.topbar .countdown-notice')).toHaveCount(0);
  });
});

test('a page opening a tab already open closes it, and the cross reopens it', async () => {
  await withDuplicateLink(async ({ original, page, source, sourceTab, worker }) => {
    await source.click('#new');

    await expect.poll(() => navigationState(worker, [original, sourceTab])).toMatchObject({ activeTabId: original });
    await expect.poll(async () => (await allTabUrls(worker)).length).toBe(2);
    await cancelDedupe(page);

    await expect.poll(async () => (await allTabUrls(worker)).filter((tab) => tab.url === ORIGINAL))
      .toEqual([
        { active: false, id: original, url: ORIGINAL },
        expect.objectContaining({ active: true, url: ORIGINAL }),
      ]);
    await page.waitForTimeout(1_500);
    expect((await allTabUrls(worker)).length).toBe(3);
    await expect(page.locator('.topbar .countdown-notice')).toHaveCount(0);
  });
});
