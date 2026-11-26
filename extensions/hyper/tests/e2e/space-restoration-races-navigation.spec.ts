import { expect, test } from '@playwright/test';
import { callChrome } from './helpers/chrome';
import { saveHyperPreference } from './fixtures/preferences';
import { safeLinksUrl } from './helpers/restoration';
import { renderedTabOrder } from './helpers/sidebar';
import {
  activateTab,
  createTab,
  currentWindowTabIds,
  matchingTabState,
  navigateTab,
  navigationState,
  pageAtUrl,
  tabOwnershipSummary,
  waitForNewPage,
} from './helpers/tabs';
import type { ExtensionGlobal } from './helpers/extensionGlobal';
import { withProfile } from './helpers/extension';

test('same-domain navigation preserves order and deduplication focuses its destination', () => withProfile('tab-navigation', async (profile) => {
  const { context, page, worker } = await profile.launchHyper({ closeInitialPage: true });
  await expect(page.locator('.space-pagination-dot')).toHaveCount(1);
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  await saveHyperPreference(worker, 'autofolders', true);

  const firstTabId = await createTab(worker, 'https://space-race.test/one');
  const secondTabId = await createTab(worker, 'https://space-race.test/two');
  const thirdTabId = await createTab(worker, 'https://space-race.test/three');
  const tabIds = [firstTabId, secondTabId, thirdTabId];
  await expect.poll(() => tabOwnershipSummary(worker, tabIds)).toEqual({
    allOwned: true,
    spaceCount: 1,
  });
  await worker.evaluate(async (tabId) => {
    const extension = globalThis as unknown as ExtensionGlobal;
    const tab = await extension.chrome.tabs.get(tabId);
    await extension.chrome.tabs.update(tabId, { active: true });
    await extension.chrome.windows.update(tab.windowId, { focused: true });
  }, secondTabId);
  await expect.poll(() => navigationState(worker, tabIds)).toMatchObject({
    activeTabId: secondTabId,
    orderedTabIds: tabIds,
  });
  await expect.poll(async () => (await renderedTabOrder(page, tabIds)).length).toBe(3);
  await new Promise((resolve) => setTimeout(resolve, 500));
  const baselineNativeOrder = (await navigationState(worker, tabIds)).orderedTabIds;
  const baselineRenderedOrder = await renderedTabOrder(page, tabIds);
  await navigateTab(worker, secondTabId, 'https://space-race.test/two/next');
  await expect.poll(() => navigationState(worker, tabIds)).toEqual({
    activeTabId: secondTabId,
    orderedTabIds: baselineNativeOrder,
    urlsByTabId: {
      [firstTabId]: 'https://space-race.test/one',
      [secondTabId]: 'https://space-race.test/two/next',
      [thirdTabId]: 'https://space-race.test/three',
    },
  });
  const secondPage = await pageAtUrl(context, 'https://space-race.test/two/next');
  await expect.poll(() => renderedTabOrder(page, tabIds)).toEqual(baselineRenderedOrder);

  await secondPage.goto('https://space-race.test/one').catch(() => undefined);
  await expect.poll(() => navigationState(worker, tabIds)).toEqual({
    activeTabId: firstTabId,
    orderedTabIds: baselineNativeOrder,
    urlsByTabId: {
      [firstTabId]: 'https://space-race.test/one',
      [secondTabId]: 'https://space-race.test/two/next',
      [thirdTabId]: 'https://space-race.test/three',
    },
  });
  await expect.poll(() => renderedTabOrder(page, tabIds)).toEqual(baselineRenderedOrder);

  await navigateTab(worker, thirdTabId, 'https://space-race.test/link-source');
  const thirdPage = await pageAtUrl(context, 'https://space-race.test/link-source');
  await activateTab(worker, thirdTabId);
  await worker.evaluate(() => {
    const extension = globalThis as unknown as ExtensionGlobal & {
      __hyperGoBackCalls?: number;
    };
    const goBack = extension.chrome.tabs.goBack.bind(extension.chrome.tabs);
    extension.__hyperGoBackCalls = 0;
    extension.chrome.tabs.goBack = ((tabId: number) => {
      extension.__hyperGoBackCalls = (extension.__hyperGoBackCalls ?? 0) + 1;
      return goBack(tabId);
    }) as typeof extension.chrome.tabs.goBack;
  });
  const baselineWindowTabIds = await currentWindowTabIds(worker);
  await waitForNewPage(context, () =>
    thirdPage.getByRole('link', { name: 'Open redirect' }).click());
  await expect.poll(() => matchingTabState(
    worker,
    'https://space-race.test/one',
  )).toEqual({
    activeTabId: firstTabId,
    matchingTabIds: [firstTabId],
  });
  await expect.poll(() => currentWindowTabIds(worker)).toEqual(baselineWindowTabIds);
  await expect.poll(() => worker.evaluate(() => (
    globalThis as unknown as { __hyperGoBackCalls?: number }
  ).__hyperGoBackCalls)).toBe(0);

  await thirdPage.bringToFront();
  await waitForNewPage(context, () =>
    thirdPage.getByRole('link', { name: 'Open noopener redirect' }).click());
  await expect.poll(() => matchingTabState(
    worker,
    'https://space-race.test/one',
  )).toMatchObject({ matchingTabIds: [firstTabId] });

  const matchingOne = () => matchingTabState(worker, 'https://space-race.test/one');
  // A copy the user asked for stays, and the header offers to close it until the ring runs out.
  // A tick inside the ring says pressing it accepts the offer.
  const dedupeAllowedCopy = async () => {
    await expect.poll(async () => (await matchingOne()).matchingTabIds).toHaveLength(2);
    const copyId = (await matchingOne()).matchingTabIds.find((tabId) => tabId !== firstTabId);
    const cooldown = page.getByRole('button', { name: 'Yes, do it' });
    await expect(cooldown).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: 'Deduplicate?' })).toBeVisible();
    await expect(cooldown.locator('svg.lucide-check')).toBeVisible();
    await expect(cooldown.locator('.countdown-button-progress')).toBeVisible();
    await cooldown.click();
    await expect.poll(async () => (await matchingOne()).matchingTabIds).toEqual([firstTabId]);
    await expect(cooldown).toHaveCount(0);
    return copyId;
  };

  // Headless Chromium focuses a middle-clicked tab, which reads as a page-opened link.
  await thirdPage.bringToFront();
  await waitForNewPage(context, () =>
    thirdPage.getByRole('link', { name: 'Open HTTP redirect' })
      .click({ button: 'middle' }));
  await expect.poll(() => matchingOne()).toEqual({
    activeTabId: thirdTabId,
    matchingTabIds: [firstTabId],
  });

  // A ctrl/cmd-click, or Open link in new tab, opens its link beside the page without focusing it.
  await callChrome(worker, 'tabs.create', {
    active: false,
    openerTabId: thirdTabId,
    url: 'https://space-race.test/one',
  });
  await expect.poll(async () => (await matchingOne()).activeTabId).toBe(thirdTabId);
  await dedupeAllowedCopy();
  await expect.poll(async () => (await matchingOne()).activeTabId).toBe(thirdTabId);

  await thirdPage.bringToFront();
  await waitForNewPage(context, () =>
    thirdPage.getByRole('link', { name: 'Open HTTP redirect' }).click());
  await expect.poll(() => matchingTabState(
    worker,
    'https://space-race.test/one',
  )).toMatchObject({ matchingTabIds: [firstTabId] });

  await thirdPage.bringToFront();
  await thirdPage.getByRole('link', { name: 'Follow redirect' }).click();
  await expect.poll(() => matchingTabState(
    worker,
    'https://space-race.test/one',
  )).toMatchObject({ matchingTabIds: [firstTabId] });
  expect(thirdPage.isClosed()).toBe(false);
  await expect.poll(() => worker.evaluate(() => (
    globalThis as unknown as { __hyperGoBackCalls?: number }
  ).__hyperGoBackCalls)).toBeGreaterThan(0);

  const safeLinksPage = await context.newPage();
  await safeLinksPage.route('https://teams.public.onecdn.static.microsoft/**', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: [
        '<!doctype html>',
        '<meta http-equiv="refresh" content="1;url=https://space-race.test/one">',
        '<title>Microsoft Safe Links</title>',
      ].join(''),
    }));
  await safeLinksPage.goto(safeLinksUrl);
  await expect(safeLinksPage).toHaveTitle('Microsoft Safe Links');
  await dedupeAllowedCopy();
  expect(safeLinksPage.isClosed()).toBe(true);
  await expect.poll(async () => (await matchingOne()).activeTabId).toBe(firstTabId);

  const baselineExternalDuplicateTabIds = await currentWindowTabIds(worker);
  // A tab opened through the API arrives like a link from outside the browser.
  await createTab(worker, 'https://space-race.test/one');
  await expect.poll(async () => (await matchingOne()).matchingTabIds).toHaveLength(2);
  const externalCopyId = (await matchingOne()).matchingTabIds
    .find((tabId) => tabId !== firstTabId) as number;
  expect(externalCopyId).toBeDefined();
  await dedupeAllowedCopy();
  await expect.poll(() => currentWindowTabIds(worker))
    .toEqual(baselineExternalDuplicateTabIds);
  await expect.poll(async () => (await matchingOne()).activeTabId).toBe(firstTabId);

  const duplicateBookmarkId = await worker.evaluate(async (url) => {
    const extension = globalThis as unknown as ExtensionGlobal;
    const visibleTitle = (title: string) => title.replace(/\s+\{.*$/, '');
    const hyper = (await extension.chrome.bookmarks.getTree())[0]?.children?.[0]
      ?.children?.find((node) => visibleTitle(node.title) === 'hyper');
    const space = hyper?.children?.find((node) =>
      visibleTitle(node.title) === 'spaces')?.children?.[0];
    const bookmarks = space?.children?.find((node) =>
      visibleTitle(node.title) === 'bookmarks' && node.title.includes('"spaceBookmarks":true'));
    if (!bookmarks) throw new Error('Space bookmarks were not initialized.');
    return (await extension.chrome.bookmarks.create({
      parentId: bookmarks.id,
      title: 'Forced duplicate bookmark',
      url,
    })).id;
  }, 'https://space-race.test/one');
  const duplicateBookmark = page.locator(
    `[data-bookmark-node-id="${duplicateBookmarkId}"] .bookmark-item`,
  );
  await expect(duplicateBookmark).toBeVisible();
  await duplicateBookmark.click({ modifiers: ['Alt'] });
  await expect.poll(async () => (
    await matchingTabState(worker, 'https://space-race.test/one')
  ).matchingTabIds).toHaveLength(2);
  const duplicateTabId = (await matchingTabState(
    worker,
    'https://space-race.test/one',
  )).matchingTabIds.find((tabId) => tabId !== firstTabId);
  if (duplicateTabId === undefined) {
    throw new Error('Hyper did not create the forced tab');
  }
  await expect.poll(() => navigationState(worker, [firstTabId, duplicateTabId]))
    .toMatchObject({ activeTabId: duplicateTabId });
  await callChrome(worker, 'tabs.reload', duplicateTabId);
  await expect.poll(() => navigationState(worker, [firstTabId, duplicateTabId]))
    .toMatchObject({
      activeTabId: duplicateTabId,
      urlsByTabId: {
        [firstTabId]: 'https://space-race.test/one',
        [duplicateTabId]: 'https://space-race.test/one',
      },
    });
}));

test('a tab the browser duplicates stays, offering to close it until the ring runs out', () => withProfile('native-duplicate', async (profile) => {
  const { context, page, worker } = await profile.launchHyper({ closeInitialPage: true });
  await expect(page.locator('.space-pagination-dot')).toHaveCount(1);
  const sourceUrl = 'https://space-race.test/duplicate-source';
  const otherUrl = 'https://space-race.test/duplicate-other';
  // Headless Chromium crashes duplicating a tab that the tabs API created.
  for (const url of [otherUrl, sourceUrl]) await (await context.newPage()).goto(url);
  const tabIdAt = async (url: string) => (await matchingTabState(worker, url)).matchingTabIds[0];
  const sourceId = await tabIdAt(sourceUrl);
  const otherId = await tabIdAt(otherUrl);
  if (sourceId === undefined || otherId === undefined) throw new Error('The pages did not open.');
  await expect.poll(() => tabOwnershipSummary(worker, [sourceId, otherId])).toEqual({
    allOwned: true,
    spaceCount: 1,
  });
  const cooldown = page.getByRole('button', { name: 'Yes, do it' });

  // Duplicate on the active tab, then on another tab, as the tab strip's menu does.
  for (const [url, tabId] of [[sourceUrl, sourceId], [otherUrl, otherId]] as const) {
    await callChrome(worker, 'tabs.duplicate', tabId);
    await expect.poll(async () => (await matchingTabState(worker, url)).matchingTabIds)
      .toHaveLength(2);
    await expect(cooldown).toBeVisible();
    // The message takes the header from the space title, Settings and Search while the ring runs.
    await expect(page.getByRole('status').filter({ hasText: 'Deduplicate?' })).toBeVisible();
    await expect(page.locator('.topbar-space-title')).toBeHidden();
    await expect(page.getByRole('button', { name: 'Open settings' })).toBeHidden();
    await expect(cooldown).toHaveCount(0, { timeout: 10_000 });
    await expect(page.locator('.topbar-space-title')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Open settings' })).toBeVisible();
    expect((await matchingTabState(worker, url)).matchingTabIds).toHaveLength(2);
  }
}));
