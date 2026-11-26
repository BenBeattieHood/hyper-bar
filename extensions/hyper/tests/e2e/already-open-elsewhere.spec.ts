import { expect, test, type Page, type Worker } from '@playwright/test';
import { routeLinkPage, withHyper } from './helpers/extension';
import { answerNotice, selectSpace, spaceDot } from './helpers/sidebar';
import { createSecondSpace } from './helpers/spaces';
import { createTab, navigationState, pageAtUrl, tabOwnershipSummary, tabsUnder } from './helpers/tabs';

const ORIGINAL = 'https://already-open.test/one';
const LINK_PAGE = 'https://already-open.test/two';

/** Opens the original page in Space 1 and a page linking to it in Second space, which shows. */
async function withPageOpenInAnotherSpace(
  run: (hyper: { original: number; page: Page; source: Page; sourceTab: number; worker: Worker }) => Promise<void>,
) {
  await withHyper('already-open', async ({ context, page, worker }) => {
    await routeLinkPage(context, /^https:\/\/already-open\.test\//, 'Already open page', ORIGINAL);
    await page.setViewportSize({ width: 720, height: 900 });
    const original = await createTab(worker, ORIGINAL);
    await expect.poll(() => tabOwnershipSummary(worker, [original])).toEqual({ allOwned: true, spaceCount: 1 });
    await createSecondSpace(worker);
    await selectSpace(page, 'Second space');
    const sourceTab = await createTab(worker, LINK_PAGE);
    await expect.poll(() => tabOwnershipSummary(worker, [original, sourceTab]))
      .toEqual({ allOwned: true, spaceCount: 2 });
    const source = await pageAtUrl(context, LINK_PAGE);
    await run({ original, page, source, sourceTab, worker });
  }, { closeInitialPage: true });
}

const acceptSwitch = (page: Page) =>
  answerNotice(page, 'Already open in Space 1. Switch instead?', 'Yes, do it', 'lucide-check');

const pageTabs = async (worker: Worker) =>
  (await tabsUnder(worker, 'https://already-open.test/')).map(({ id, url }) => ({ id, url }));

test('following a link to a page open in another space offers it, and the tick switches and sends the tab back', async () => {
  await withPageOpenInAnotherSpace(async ({ original, page, source, sourceTab, worker }) => {
    await source.click('#same');
    await expect.poll(() => navigationState(worker, [original, sourceTab])).toMatchObject({
      activeTabId: sourceTab,
      urlsByTabId: { [original]: ORIGINAL, [sourceTab]: ORIGINAL },
    });

    await acceptSwitch(page);

    await expect.poll(() => navigationState(worker, [original, sourceTab])).toMatchObject({
      activeTabId: original,
      urlsByTabId: { [original]: ORIGINAL, [sourceTab]: LINK_PAGE },
    });
    await expect(spaceDot(page, 'Space 1'))
      .toHaveAttribute('aria-current', 'page');
    // Going back is Hyper's own navigation, so it offers nothing.
    await page.waitForTimeout(1_000);
    await expect(page.locator('.topbar .countdown-notice')).toHaveCount(0);
  });
});

test('a link opening a page open in another space in a new tab offers it, and the tick closes the new tab', async () => {
  await withPageOpenInAnotherSpace(async ({ original, page, source, worker }) => {
    await source.click('#new');
    await expect.poll(async () => (await pageTabs(worker)).length).toBe(3);

    await acceptSwitch(page);

    await expect.poll(() => pageTabs(worker)).toEqual(expect.arrayContaining([
      { id: original, url: ORIGINAL },
      expect.objectContaining({ url: LINK_PAGE }),
    ]));
    await expect.poll(async () => (await pageTabs(worker)).length).toBe(2);
    await expect.poll(async () => (await navigationState(worker, [original])).activeTabId).toBe(original);
  });
});
