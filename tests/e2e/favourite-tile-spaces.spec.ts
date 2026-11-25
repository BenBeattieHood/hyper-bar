import { expect, test, type Locator, type Page, type Worker } from '@playwright/test';
import { waitForActivationQuiescence } from './fixtures/activation';
import { seedActiveSpaceId } from './fixtures/activeSpace';
import { saveHyperPreference } from './fixtures/preferences';
import { callChrome } from './helpers/chrome';
import { routeHtml, sidepanelUrl, withExtension } from './helpers/extension';
import { createMotionFixture, settleMotionFixture, type MotionFixture } from './helpers/motion';
import { waitForTabSpaceGroup } from './helpers/spaces';
import { createTab } from './helpers/tabs';
import { spaceDotById } from './helpers/sidebar';

const SHARED = 'https://motion.test/shared';
const NESTED = 'https://motion.test/nested';
const UNOPENED = 'https://motion.test/unopened';
const REMOTE = 'https://motion.test/remote';

async function pinFavourites(worker: Worker, favouritesId: string, urls: string[]) {
  for (const [slot, url] of urls.entries()) {
    await callChrome(worker, 'bookmarks.create', {
      parentId: favouritesId,
      title: `Favourite ${slot} ${JSON.stringify({ hyper: { favouriteSlot: slot } })}`,
      url,
    });
  }
}

const activeTabId = async (worker: Worker, windowId: number) =>
  (await callChrome<Array<{ id?: number }>>(worker, 'tabs.query', { active: true, windowId }))[0]?.id;

const colourOf = (locator: Locator, property: string) =>
  locator.evaluate((element, property) =>
    getComputedStyle(element).getPropertyValue(property).trim(), property);

const spaceColour = (page: Page, spaceId: string) => colourOf(spaceDotById(page, spaceId), '--space-dot-colour');

async function expectTileInSpace(page: Page, url: string, spaceId: string) {
  const tile = page.locator(`.favourite-tile[data-url="${url}"]`);
  await expect(tile).toHaveAttribute('data-space-id', spaceId);
  await expect(tile).toHaveClass(/\bis-open\b/);
  const colour = await spaceColour(page, spaceId);
  expect(colour).not.toBe('');
  expect(await colourOf(tile, '--tile-space-colour')).toBe(colour);
}

// The shared page is open in both spaces; the nested page only in the second.
async function withSpaces(
  run: (page: Page, worker: Worker, fixture: MotionFixture) => Promise<void>,
  { favourites = [] as string[], grouped = false } = {},
) {
  await withExtension('favourite-tile-spaces', async ({ context, worker }) => {
    const page = await context.newPage();
    await page.setViewportSize({ width: 900, height: 900 });
    await routeHtml(context, 'https://motion.test/**', '<!doctype html><title>Favourite tile space fixture</title>');
    const fixture = await createMotionFixture(worker);
    await settleMotionFixture(worker, fixture);
    // Every fixture page is on one site, so tests of single tiles turn grouping off.
    if (!grouped) await saveHyperPreference(worker, 'groupFavouritesByDomain', false);
    await pinFavourites(worker, fixture.favouritesId, favourites);
    await page.goto(sidepanelUrl(worker));
    await expect(spaceDotById(page, fixture.firstSpaceId)).toHaveAttribute('aria-current', 'page');
    await run(page, worker, fixture);
  }, { closeInitialPage: true });
}

test('favourite tiles wear the colour of the space their tab is in, and open it there', async () => {
  await withSpaces(async (page, worker, fixture) => {

    await expectTileInSpace(page, SHARED, fixture.firstSpaceId);
    await expectTileInSpace(page, NESTED, fixture.secondSpaceId);
    const unopened = page.locator(`.favourite-tile[data-url="${UNOPENED}"]`);
    await expect(unopened).not.toHaveAttribute('data-space-id');
    await expect(unopened).not.toHaveClass(/\bis-open\b/);

    // A page open only in another window still colours its tile.
    const otherWindowId = (await callChrome<{ id?: number }>(
      worker, 'windows.create', { focused: false, url: 'about:blank' },
    )).id;
    if (otherWindowId === undefined) throw new Error('The other window was not created');
    await seedActiveSpaceId(worker, otherWindowId, fixture.secondSpaceId);
    const remoteTabId = await createTab(worker, 'https://motion.test/remote', { windowId: otherWindowId });
    await waitForTabSpaceGroup(worker, remoteTabId, fixture.secondSpaceId);
    await expectTileInSpace(page, REMOTE, fixture.secondSpaceId);
    // Active only in the other window, so it is not this window's current tab.
    await expect(page.locator(`.favourite-tile[data-url="${REMOTE}"]`)).not.toHaveClass(/\bis-active\b/);

    // Open only in another space: the click takes the window to that space and its tab.
    await page.locator(`.favourite-tile[data-url="${NESTED}"]`).click();
    await expect(spaceDotById(page, fixture.secondSpaceId)).toHaveAttribute('aria-current', 'page');
    await waitForActivationQuiescence(worker);
    await expect.poll(() => activeTabId(worker, fixture.windowId)).toBe(fixture.nestedTabId);

    // Open in the current space too: the current space wins.
    await expectTileInSpace(page, SHARED, fixture.secondSpaceId);
    await page.locator(`.favourite-tile[data-url="${SHARED}"]`).click();
    await waitForActivationQuiescence(worker);
    await expect.poll(() => activeTabId(worker, fixture.windowId)).toBe(fixture.secondTabId);
    await expect(spaceDotById(page, fixture.secondSpaceId)).toHaveAttribute('aria-current', 'page');

    // A recent tab wears its own space's colour, and clicking it from another space goes there.
    const recentTabId = await createTab(worker, 'https://motion.test/recent', { active: false, windowId: fixture.windowId });
    await waitForTabSpaceGroup(worker, recentTabId, fixture.secondSpaceId);
    await spaceDotById(page, fixture.firstSpaceId).click();
    await expect(spaceDotById(page, fixture.firstSpaceId)).toHaveAttribute('aria-current', 'page');
    await waitForActivationQuiescence(worker);
    const recentTile = page.locator(`.favourite-tile.is-recent[data-url="https://motion.test/recent"]`);
    await expect(recentTile).toHaveAttribute('data-space-id', fixture.secondSpaceId);
    expect(await colourOf(recentTile, '--tile-space-colour')).toBe(await spaceColour(page, fixture.secondSpaceId));
    await recentTile.click();
    await expect(spaceDotById(page, fixture.secondSpaceId)).toHaveAttribute('aria-current', 'page');
    await waitForActivationQuiescence(worker);
    await expect.poll(() => activeTabId(worker, fixture.windowId)).toBe(recentTabId);
  }, { favourites: [SHARED, NESTED, UNOPENED, REMOTE] });
});

test('a grouped tile lists its tabs by space, spaces ranked by their most recent tab, each row in its space\'s colour', async () => {
  await withSpaces(async (page, worker, fixture) => {
    const activate = async (tabId: number) => {
      await callChrome(worker, 'tabs.update', tabId, { active: true });
      await waitForActivationQuiescence(worker);
      await expect.poll(() => activeTabId(worker, fixture.windowId)).toBe(tabId);
    };
    // Most recent first: the second space's shared tab, the first space's, then the nested tab in the second space.
    await activate(fixture.nestedTabId);
    await activate(fixture.firstTabId);
    await activate(fixture.secondTabId);

    const tile = page.locator('.favourite-tile.is-group[data-group-domain="motion.test"]');
    await tile.hover();
    const rows = page.locator('.favourite-group-list .favourite-group-row');
    const order = () => rows.evaluateAll((elements) => elements.map((row) =>
      `${row.getAttribute('data-url')} ${row.getAttribute('data-space-id')}`));
    await expect.poll(order).toEqual([
      `${SHARED} ${fixture.secondSpaceId}`,
      `${NESTED} ${fixture.secondSpaceId}`,
      `${SHARED} ${fixture.firstSpaceId}`,
    ]);
    await expect(rows.first()).toHaveClass(/\bis-current\b/);
    for (const [index, spaceId] of [fixture.secondSpaceId, fixture.secondSpaceId, fixture.firstSpaceId].entries()) {
      const colour = await spaceColour(page, spaceId);
      expect(colour).not.toBe('');
      expect(await colourOf(rows.nth(index), '--row-space-colour')).toBe(colour);
    }
    // The two second-space rows share one unbroken bar; the first-space row's bar stands apart.
    const bars = await rows.evaluateAll((elements) => elements.map((row) => {
      const rect = row.getBoundingClientRect();
      const bar = getComputedStyle(row, '::before');
      return { top: rect.top + parseFloat(bar.top), bottom: rect.bottom - parseFloat(bar.bottom) };
    }));
    const [second, nested, first] = bars as [typeof bars[0], typeof bars[0], typeof bars[0]];
    expect(nested.top).toBeCloseTo(second.bottom, 1);
    expect(first.top - nested.bottom).toBeGreaterThan(10);
  }, { grouped: true });
});
