import { expect, test, type Frame, type Locator, type Page } from '@playwright/test';
import { waitForActivationQuiescence } from './fixtures/activation';
import { seedActiveSpaceId } from './fixtures/activeSpace';
import { createSecondSpaceSharedBookmark, launchMotionFixture } from './helpers/motion';
import { waitForTabSpaceGroup } from './helpers/spaces';
import { activeTabId, createTab, navigateTab, openTabIds, tabUrl } from './helpers/tabs';
import type { ExtensionGlobal } from './helpers/extensionGlobal';
import { tabRowSelector } from './helpers/rows';
import { openPageSearch, openSidepanel, withProfile } from './helpers/extension';
import { spaceDotById } from './helpers/sidebar';

test('activates space-indicator tabs and closes open bookmark tabs', () => withProfile('space-indicator-focus', async (profile) => {
  const { fixture, page, worker } = await launchMotionFixture(profile, 'Indicator focus fixture');
  await openSidepanel(page, worker);
  const secondSpaceBookmarkId = await createSecondSpaceSharedBookmark(worker, fixture);

  const firstTabRow = page.locator(tabRowSelector(fixture.firstTabId));
  await expect(firstTabRow).toBeVisible();
  await firstTabRow.locator('.bookmark-space-link').click();
  await expect(spaceDotById(page, fixture.secondSpaceId)).toHaveAttribute('aria-current', 'page');
  await waitForActivationQuiescence(worker);
  await expect.poll(() => activeTabId(worker)).toBe(fixture.secondTabId);

  const secondSpaceBookmarkRow = page.locator(
    `[data-bookmark-node-id="${secondSpaceBookmarkId}"]`,
  );
  await expect(secondSpaceBookmarkRow).toBeVisible();
  await expect(secondSpaceBookmarkRow.locator('.tab-count')).toHaveCount(0);
  await expect(secondSpaceBookmarkRow.locator('.bookmark-current-space-indicator')).toHaveCount(0);
  const openBookmarkTab = secondSpaceBookmarkRow.locator(
    ':scope > .tab-bookmark-indicator.is-open',
  );
  await expect(openBookmarkTab).toHaveAccessibleName(/Focus open tab for /);
  const openBookmarkIcon = openBookmarkTab.locator('.tab-bookmark-icon');
  await expect(openBookmarkIcon).toHaveAttribute('data-bookmark-icon-state', 'open');
  const openBookmarkDot = openBookmarkIcon.locator('.tab-bookmark-open-dot');
  await expect(openBookmarkDot).toBeVisible();
  const activeSpaceLabel = spaceDotById(page, fixture.secondSpaceId).locator('.space-pagination-label');
  expect(await openBookmarkDot.evaluate((dot) => getComputedStyle(dot).backgroundColor))
    .toBe(await activeSpaceLabel.evaluate((label) => getComputedStyle(label).color));
  await secondSpaceBookmarkRow.hover();
  const [bookmarkCloseBounds, otherSpaceBounds, openBookmarkBounds] = await Promise.all([
    secondSpaceBookmarkRow.locator('.bookmark-close').boundingBox(),
    secondSpaceBookmarkRow.locator('.bookmark-space-link').boundingBox(),
    openBookmarkTab.boundingBox(),
  ]);
  expect(bookmarkCloseBounds).not.toBeNull();
  expect(otherSpaceBounds).not.toBeNull();
  expect(openBookmarkBounds).not.toBeNull();
  expect(bookmarkCloseBounds!.x).toBeLessThan(otherSpaceBounds!.x);
  expect(otherSpaceBounds!.x).toBeLessThan(openBookmarkBounds!.x);
  await secondSpaceBookmarkRow.locator('.bookmark-space-link').click();
  await expect(spaceDotById(page, fixture.firstSpaceId)).toHaveAttribute('aria-current', 'page');
  await waitForActivationQuiescence(worker);
  await expect.poll(() => activeTabId(worker)).toBe(fixture.firstTabId);
  const bookmarkRow = page.locator(`[data-bookmark-node-id="${fixture.bookmarkId}"]`);

  const originalUrl = 'https://motion.test/shared';
  const updatedUrl = 'https://motion.test/shared?updated=1';
  const updateTabUrl = (url: string) => navigateTab(worker, fixture.firstTabId, url);
  const firstTabUrl = () => tabUrl(worker, fixture.firstTabId);

  await updateTabUrl(updatedUrl);
  await expect.poll(firstTabUrl).toBe(updatedUrl);
  const updateBookmark = bookmarkRow.locator(
    ':scope > .tab-bookmark-indicator.is-update',
  );
  await expect(updateBookmark).toHaveAccessibleName(/Update bookmark to /);
  await expect(updateBookmark.locator('.tab-bookmark-icon'))
    .toHaveAttribute('data-bookmark-icon-state', 'update');
  const primaryModifier = process.platform === 'darwin' ? 'Meta' : 'Control';
  await updateBookmark.hover();
  await expect(updateBookmark).toBeFocused();
  await page.keyboard.down(primaryModifier);
  const revertBookmark = bookmarkRow.locator(
    ':scope > .tab-bookmark-indicator.is-revert',
  );
  await expect(revertBookmark).toHaveAccessibleName(/Revert .* to bookmarked page/);
  await expect(revertBookmark.locator('.tab-bookmark-icon'))
    .toHaveAttribute('data-bookmark-icon-state', 'revert');
  await page.keyboard.up(primaryModifier);
  await expect(updateBookmark).toBeVisible();
  await page.keyboard.down(primaryModifier);
  await revertBookmark.click();
  await page.keyboard.up(primaryModifier);
  await expect.poll(firstTabUrl).toBe(originalUrl);

  await updateTabUrl(updatedUrl);
  await expect.poll(firstTabUrl).toBe(updatedUrl);
  await updateBookmark.click();
  await expect.poll(() => worker.evaluate(async (bookmarkId) => {
    const extension = globalThis as unknown as ExtensionGlobal;
    return (await extension.chrome.bookmarks.get(bookmarkId))[0]?.url;
  }, fixture.bookmarkId)).toBe(updatedUrl);
  await worker.evaluate(async ({ bookmarkId, tabId, url }) => {
    const extension = globalThis as unknown as ExtensionGlobal;
    await Promise.all([
      extension.chrome.bookmarks.update(bookmarkId, { url }),
      extension.chrome.tabs.update(tabId, { url }),
    ]);
  }, {
    bookmarkId: fixture.bookmarkId,
    tabId: fixture.firstTabId,
    url: originalUrl,
  });
  await expect.poll(firstTabUrl).toBe(originalUrl);

  const closeBookmarkTabs = bookmarkRow.locator('.bookmark-close');
  await expect(closeBookmarkTabs).toHaveAccessibleName(/^Close tabs for /);
  await closeBookmarkTabs.click();
  await expect.poll(async () =>
    (await openTabIds(worker, [fixture.firstTabId, fixture.secondTabId])).length > 0)
    .toBe(false);
  await expect(bookmarkRow).toBeVisible();
  await expect(bookmarkRow.locator('.bookmark-close')).toHaveCount(0);
  await expect(bookmarkRow.locator(':scope > .tab-bookmark-indicator')).toHaveCount(0);
}));

/** Middle-clicks the row's space dot and waits for that space's copy to close. */
async function closeSpaceCopy(
  row: Locator,
  openTabs: () => Promise<number[]>,
  remainingTabIds: number[],
): Promise<void> {
  await expect(row.locator('.bookmark-space-link')).toHaveCount(1);
  await row.locator('.bookmark-space-link').click({ button: 'middle' });
  await expect.poll(openTabs).toEqual(remainingTabIds);
  await expect(row.locator('.bookmark-space-link')).toHaveCount(0);
}

test('middle-clicking a space dot closes the page in that space only', () => withProfile('space-indicator-close', async (profile) => {
  const { fixture, page, worker } = await launchMotionFixture(
    profile,
    'Indicator close fixture',
    { channel: process.env.HYPER_BROWSER_CHANNEL },
  );
  await openSidepanel(page, worker);
  const openTabs = () => openTabIds(
    worker,
    [fixture.firstTabId, fixture.secondTabId, fixture.nestedTabId],
  );
  const firstSpaceCurrent = spaceDotById(page, fixture.firstSpaceId);

  // The first space's tab row shows the shared page's copy in the second space.
  const firstTabRow = page.locator(tabRowSelector(fixture.firstTabId));
  await closeSpaceCopy(firstTabRow, openTabs, [fixture.firstTabId, fixture.nestedTabId]);
  // A failed close reports itself once it settles, which is by now.
  await page.waitForTimeout(500);
  await expect(page.locator('.countdown-notice.is-error')).toHaveCount(0);
  await expect(firstSpaceCurrent).toHaveAttribute('aria-current', 'page');

  // A bookmark row closes its page in that space the same way.
  const nestedBookmarkRow = page.locator(
    `[data-bookmark-node-id="${fixture.nestedBookmarkId}"]`,
  );
  await closeSpaceCopy(nestedBookmarkRow, openTabs, [fixture.firstTabId]);
  await expect(firstSpaceCurrent).toHaveAttribute('aria-current', 'page');
}));

test('middle-clicking a space dot closes that space\'s copy in another window', () => withProfile('space-indicator-remote-close', async (profile) => {
  const { fixture, page, worker } = await launchMotionFixture(
    profile,
    'Indicator remote close fixture',
    { channel: process.env.HYPER_BROWSER_CHANNEL },
  );
  await openSidepanel(page, worker);
  const otherWindowId = await worker.evaluate(async () => {
    const extension = globalThis as unknown as ExtensionGlobal;
    const created = await extension.chrome.windows.create({ focused: false, url: 'about:blank' });
    if (created?.id === undefined) throw new Error('The other window was not created');
    return created.id;
  });
  await seedActiveSpaceId(worker, otherWindowId, fixture.secondSpaceId);
  const remoteTabId = await createTab(worker, 'https://motion.test/shared', { windowId: otherWindowId });
  await waitForTabSpaceGroup(worker, remoteTabId, fixture.secondSpaceId);
  const openTabs = () => openTabIds(worker, [fixture.firstTabId, fixture.secondTabId, remoteTabId]);

  const firstTabRow = page.locator(tabRowSelector(fixture.firstTabId));
  await closeSpaceCopy(firstTabRow, openTabs, [fixture.firstTabId]);
  await page.waitForTimeout(500);
  await expect(page.locator('.countdown-notice.is-error')).toHaveCount(0);
}));

test('middle-clicking a Search result\'s space dot closes the page there and keeps Search open', () => withProfile('search-space-indicator-close', async (profile) => {
  const { context, fixture, page, worker } = await launchMotionFixture(
    profile,
    'Search indicator close fixture',
    { channel: process.env.HYPER_BROWSER_CHANNEL },
  );
  await openSidepanel(page, worker);
  const openTabs = () => openTabIds(
    worker,
    [fixture.firstTabId, fixture.secondTabId, fixture.nestedTabId],
  );
  const searchName = { name: 'Search tabs, bookmarks, history, or commands' };
  const secondSpaceDot = (search: Frame | Page) => search
    .getByRole('listbox', { name: 'Command bar results' })
    .getByRole('button', { name: / in Second space$/ });

  // Sidebar Search closes the shared page's copy in the second space without leaving the first.
  await page.getByRole('button', { name: 'Search tabs and history' }).click();
  const sidebarSearch = page.getByRole('combobox', searchName);
  await sidebarSearch.fill('motion.test/shared');
  await expect(secondSpaceDot(page)).toHaveCount(1);
  await secondSpaceDot(page).click({ button: 'middle' });
  await expect.poll(openTabs).toEqual([fixture.firstTabId, fixture.nestedTabId]);
  await expect(secondSpaceDot(page)).toHaveCount(0);
  await expect(sidebarSearch).toBeFocused();
  await expect(sidebarSearch).toHaveValue('motion.test/shared');
  await page.waitForTimeout(500);
  await expect(page.locator('.countdown-notice.is-error')).toHaveCount(0);
  await expect(spaceDotById(page, fixture.firstSpaceId)).toHaveAttribute('aria-current', 'page');
  expect(await activeTabId(worker)).toBe(fixture.uiTabId);

  // Page Search, over a first-space page, closes the nested page in the second space the same way.
  const webpage = await context.newPage();
  await webpage.goto('https://motion.test/search-host');
  const hostTabId = await activeTabId(worker);
  expect(hostTabId).toBeDefined();
  await webpage.mouse.click(200, 200);
  await expect.poll(() => webpage.evaluate(() => document.hasFocus())).toBe(true);
  const pageSearch = await openPageSearch(webpage);
  const pageSearchField = pageSearch.getByRole('combobox', searchName);
  await pageSearchField.fill('motion.test/nested');
  await expect(secondSpaceDot(pageSearch)).toHaveCount(1);
  await secondSpaceDot(pageSearch).click({ button: 'middle' });
  await expect.poll(openTabs).toEqual([fixture.firstTabId]);
  await expect(secondSpaceDot(pageSearch)).toHaveCount(0);
  await expect(pageSearchField).toBeFocused();
  await expect(pageSearchField).toHaveValue('motion.test/nested');
  await webpage.waitForTimeout(500);
  await expect(pageSearch.locator('.newtab-notice')).toBeEmpty();
  await expect(webpage.locator('#hyper-search-overlay-host')).toHaveAttribute('data-open', 'true');
  expect(await activeTabId(worker)).toBe(hostTabId);
}));
