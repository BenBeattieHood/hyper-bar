import {
  expect,
  test,
} from '@playwright/test';
import { callChrome } from './helpers/chrome';
import { saveHyperPreference } from './fixtures/preferences';
import { paintedCustomProperty } from './fixtures/styles';
import { createMotionFixture, createSecondSpaceSharedBookmark, launchMotionFixture } from './helpers/motion';
import { beginPointerDrag } from './helpers/sidebar';
import { activeTabId, browserTab, createTabs, navigateTab } from './helpers/tabs';
import type { ExtensionGlobal } from './helpers/extensionGlobal';
import { openSidepanel, withProfile } from './helpers/extension';
import { tabRowSelector } from './helpers/rows';

test('a tab opened in the background keeps one row as it gains its bookmark', () => withProfile('one-row', async (profile) => {
  const { page, worker } = await profile.launchHyper({ closeInitialPage: true });
  await page.setViewportSize({ width: 600, height: 900 });
  // Records, at every change to the sidebar, the most rows any one tab had at once.
  await page.evaluate(() => {
    const probe = { most: 0 };
    Object.assign(globalThis, { tabRowProbe: probe });
    new MutationObserver(() => {
      const rowsByTab = new Map<string, number>();
      for (const row of document.querySelectorAll<HTMLElement>('.tab-row[data-tab-id]')) {
        const tabId = row.dataset.tabId ?? '';
        rowsByTab.set(tabId, (rowsByTab.get(tabId) ?? 0) + 1);
      }
      probe.most = Math.max(probe.most, ...rowsByTab.values());
    }).observe(document.body, { attributes: true, childList: true, subtree: true });
  });
  const tabIds = await createTabs(worker, ['one', 'two', 'three'].map((path) => `https://space-race.test/${path}`), {
    active: false,
  });
  expect(tabIds).toHaveLength(3);
  // A row shows its tab's bookmark once the tab has one, rather than standing in for it.
  await expect.poll(() => page.evaluate((ids) => ids.every((tabId) =>
    Array.from(document.querySelectorAll<HTMLElement>(`.tab-row[data-tab-id="${tabId}"]`))
      .some((row) => /^\d+$/.test(row.dataset.tabNodeId ?? ''))), tabIds)).toBe(true);
  // The background settles each new tab's bookmark once more a moment later, so the probe watches through that.
  await page.waitForTimeout(500);

  expect(await page.evaluate(() =>
    (globalThis as unknown as { tabRowProbe: { most: number } }).tabRowProbe.most)).toBe(1);
  for (const tabId of tabIds) {
    await expect(page.locator(`.tab-row[data-tab-id="${tabId}"]`)).toHaveCount(1);
  }
}));

test('draws a distinct centred mark for each bookmark sync state', () => withProfile('bookmark-sync-mark', async (profile) => {
  const { fixture, page, worker } = await launchMotionFixture(profile, 'Bookmark sync mark fixture');
  const bookmarkedUrl = 'https://motion.test/sync-mark';
  const tabId = await worker.evaluate(async ({ spaceId, url }) => {
    const extension = globalThis as unknown as ExtensionGlobal;
    const tab = await extension.chrome.tabs.create({ active: false, url });
    if (tab.id === undefined) throw new Error('Chrome did not create the sync mark tab');
    await extension.chrome.storage.session.set({ [`tabSpaceId:${tab.id}`]: spaceId });
    return tab.id;
  }, { spaceId: fixture.firstSpaceId, url: bookmarkedUrl });
  await openSidepanel(page, worker);

  const indicator = (action: string) => page.locator(
    `${tabRowSelector(tabId)} .tab-bookmark-indicator.is-${action}`,
  );
  // The mark is drawn, so its geometry is the only evidence of which state it shows.
  const captureMark = async (action: string, iconState: string) => {
    const icon = indicator(action).locator('.tab-bookmark-icon');
    await expect(icon).toHaveAttribute('data-bookmark-icon-state', iconState);
    const artwork = icon.locator('.tab-bookmark-icon-artwork');
    await expect(artwork).toHaveCount(1);
    await expect(artwork).toBeVisible();
    const paint = await artwork.evaluate((svg) => {
      const style = getComputedStyle(svg);
      return {
        color: style.color,
        fill: style.fill,
        fillRule: svg.querySelector('path')?.getAttribute('fill-rule'),
        stroke: style.stroke,
        strokeWidth: style.strokeWidth,
      };
    });
    if (iconState === 'add' || iconState === 'revert') {
      expect(paint.strokeWidth).toBe('1.6px');
    }
    if (iconState === 'bookmarked') {
      expect(paint.fill).toBe(paint.color);
      expect(paint.stroke).toBe('none');
      expect(paint.fillRule).toBe('evenodd');
    }
    if (iconState === 'update') {
      expect(paint.fill).toBe(paint.color);
      expect(paint.stroke).toBe('none');
      expect(paint.fillRule).toBe('evenodd');
    }
    const [iconBounds, artworkBounds] = await Promise.all([
      icon.boundingBox(),
      artwork.boundingBox(),
    ]);
    expect(iconBounds).not.toBeNull();
    expect(artworkBounds).not.toBeNull();
    expect(Math.abs(
      artworkBounds!.x + artworkBounds!.width / 2 -
      (iconBounds!.x + iconBounds!.width / 2),
    )).toBeLessThan(1);
    expect(Math.abs(
      artworkBounds!.y + artworkBounds!.height / 2 -
      (iconBounds!.y + iconBounds!.height / 2),
    )).toBeLessThan(1);
    return artwork.evaluate((svg) => [
      svg.getAttribute('viewBox'),
      ...Array.from(svg.querySelectorAll('path'), (path) => path.getAttribute('d')),
    ].join('|'));
  };

  const createBookmark = indicator('create');
  await expect(createBookmark).toHaveAccessibleName(/Create bookmark for /);
  const addMark = await captureMark('create', 'add');

  await createBookmark.click();
  await expect(indicator('remove')).toHaveAccessibleName(/Remove bookmark for /);
  const bookmarkedMark = await captureMark('remove', 'bookmarked');

  const updatedUrl = `${bookmarkedUrl}?updated=1`;
  await navigateTab(worker, tabId, updatedUrl);
  const updateBookmark = indicator('update');
  await expect(updateBookmark).toHaveAccessibleName(/Update bookmark to /);
  const updateMark = await captureMark('update', 'update');

  const primaryModifier = process.platform === 'darwin' ? 'Meta' : 'Control';
  await updateBookmark.hover();
  await expect(updateBookmark).toBeFocused();
  await page.keyboard.down(primaryModifier);
  await expect(indicator('revert')).toHaveAccessibleName(/Revert .* to bookmarked page/);
  const revertMark = await captureMark('revert', 'revert');
  await page.keyboard.up(primaryModifier);
  await expect(updateBookmark).toBeVisible();

  expect(new Set([addMark, bookmarkedMark, updateMark, revertMark]).size).toBe(4);
}));

test('uses tab-style bookmark hover, narrow edit zones, and a recent-tabs menu', () => withProfile('row-interactions', async (profile) => {
  const { context, worker } = await profile.launchExtension({ closeInitialPage: true, colorScheme: 'dark' });
  const page = await context.newPage();
  await page.setViewportSize({ width: 600, height: 900 });
  await context.route('https://motion.test/**', (route) => route.fulfill({
    contentType: 'text/html',
    body: `<!doctype html><title>${new URL(route.request().url()).pathname}</title>`,
  }));
  const fixture = await createMotionFixture(worker);
  await saveHyperPreference(worker, 'combineTabsAndBookmarks', false);
  await openSidepanel(page, worker);

  const recentTabsButton = page.getByRole('button', { name: 'Show recent tabs' });
  await expect(recentTabsButton).toBeEnabled();
  await recentTabsButton.click();
  const recentTabsMenu = page.getByRole('menu', { name: 'Recent tabs' });
  await expect(recentTabsMenu).toBeVisible();
  // Opening the sidebar leaves focus where it was, so every fixture tab is recent.
  await expect(recentTabsMenu.getByRole('menuitem')).toHaveCount(3);
  await expect(recentTabsMenu.locator('.favicon')).toHaveCount(3);
  await expect(recentTabsMenu.locator('.bookmark-menu-item-copy small')).toHaveCount(0);
  await recentTabsMenu.locator(
    `[role="menuitem"][data-menu-item-id="${fixture.nestedTabId}"]`,
  ).click();
  await expect.poll(() => activeTabId(worker)).toBe(fixture.nestedTabId);

  await recentTabsButton.click();
  await expect(recentTabsMenu).toBeVisible();
  await expect(recentTabsMenu.getByRole('menuitem')).toHaveCount(2);
  await expect(recentTabsMenu.locator(
    `[role="menuitem"][data-menu-item-id="${fixture.nestedTabId}"]`,
  )).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(recentTabsMenu).toBeHidden();

  // The recent tab switched to the second space, which keeps its own copy of the bookmark.
  const secondSpaceBookmarkId = await createSecondSpaceSharedBookmark(worker, fixture);
  await page.getByRole('tab', { name: 'Bookmarks' }).click();
  const bookmarkRow = page.locator(`[data-bookmark-node-id="${secondSpaceBookmarkId}"]`);
  const bookmarkSurface = bookmarkRow.locator(':scope > .tree-item-surface');
  const bookmarkMain = bookmarkSurface.locator('.tree-item-main');
  const bookmarkTitle = bookmarkMain.locator('.tree-title');

  // Escape mid-drag cancels the drag and nothing else.
  await beginPointerDrag(page, bookmarkMain);
  await expect(page.locator('.drag-overlay')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.drag-overlay')).toHaveCount(0);
  await page.mouse.up();
  await expect(page.getByRole('tab', { name: 'Bookmarks' }))
    .toHaveAttribute('aria-selected', 'true');
  await expect(bookmarkRow).toBeVisible();

  await bookmarkTitle.hover();
  await expect.poll(() => bookmarkSurface.evaluate((element) =>
    getComputedStyle(element).backgroundColor,
  )).not.toBe('rgba(0, 0, 0, 0)');
  const hoverBackground = await bookmarkSurface.evaluate(
    (element) => getComputedStyle(element).backgroundColor,
  );
  await expect(bookmarkMain).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');

  const clickTitle = async () => {
    const bounds = await bookmarkTitle.boundingBox();
    if (!bounds) throw new Error('Bookmark title was not measurable');
    await page.mouse.click(
      bounds.x + bounds.width / 2,
      bounds.y + bounds.height / 2,
    );
  };
  await clickTitle();
  await expect(bookmarkRow).toHaveClass(/is-foremost/);
  await expect.poll(() => bookmarkSurface.evaluate((element) =>
    getComputedStyle(element).backgroundColor,
  )).not.toBe(hoverBackground);
  await expect(bookmarkSurface).toHaveCSS(
    'background-color',
    await paintedCustomProperty(bookmarkSurface, '--row-active-background'),
  );
  await expect(bookmarkSurface).toHaveCSS('box-shadow', 'none');
  // Renaming asks for a deliberate second click, so the pair is timed rather
  // than placed: too far apart and the clicks read as separate activations.
  await page.waitForTimeout(900);
  await clickTitle();
  await expect(bookmarkRow.locator('input.tree-title')).toHaveCount(0);
  await page.waitForTimeout(250);
  await clickTitle();
  const titleInput = bookmarkRow.locator('input.tree-title');
  await expect(titleInput).toBeVisible();
  await titleInput.press('Escape');
  await expect(titleInput).toHaveCount(0);
}));

test('restores a recently closed tab from the recent tabs menu', () => withProfile('recently-closed', async (profile) => {
  const { context, worker } = await profile.launchExtension({ closeInitialPage: true });
  const page = await context.newPage();
  await page.setViewportSize({ width: 600, height: 900 });
  await openSidepanel(page, worker);
  const closedUrl = 'https://closed.test/page';
  // The browser lists a closed tab only once its page has loaded.
  const tabIdsAt = () => worker.evaluate(async (url) => {
    const extension = globalThis as unknown as ExtensionGlobal;
    return (await extension.chrome.tabs.query({}))
      .flatMap((tab) => tab.url === url && tab.status === 'complete' && tab.id !== undefined ? [tab.id] : []);
  }, closedUrl);
  await callChrome(worker, 'tabs.create', { active: false, url: closedUrl });
  await expect(page.locator(`.tab-main[data-url="${closedUrl}"]`)).toBeVisible();
  await expect.poll(tabIdsAt).toHaveLength(1);
  const [closedTabId] = await tabIdsAt();
  const closedTitle = (await browserTab(worker, closedTabId!)).title;
  await callChrome(worker, 'tabs.remove', closedTabId!);
  await expect.poll(tabIdsAt).toEqual([]);

  const recentTabsMenu = page.getByRole('menu', { name: 'Recent tabs' });
  const closedItem = recentTabsMenu.locator('[role="menuitem"][data-menu-item-id^="closed:"]');
  await expect.poll(async () => {
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Show recent tabs' }).click();
    return closedItem.count();
  }).toBe(1);
  await expect(recentTabsMenu.getByRole('separator', { name: 'Recently closed' }))
    .toBeVisible();
  await expect(closedItem).toHaveAttribute('title', closedTitle || closedUrl);
  await closedItem.click();

  await expect.poll(async () => (await tabIdsAt()).length).toBe(1);
  await expect(page.locator(`.tab-main[data-url="${closedUrl}"]`)).toBeVisible();
}));

test('lists the twenty most recently used tabs in the recent tabs menu, newest first', () => withProfile('recent-tabs', async (profile) => {
  const { page, worker } = await profile.launchHyper({ closeInitialPage: true });
  await page.setViewportSize({ width: 600, height: 900 });
  // Tabs are used in an order unlike the strip's, so strip order cannot pass for recency.
  const usedTabIds = await worker.evaluate(async () => {
    const extension = globalThis as unknown as ExtensionGlobal;
    const stripTabIds: number[] = [];
    for (let index = 0; index < 23; index += 1) {
      const tab = await extension.chrome.tabs.create({
        active: false,
        url: `https://space-race.test/recent-${index}`,
      });
      if (tab.id === undefined) throw new Error('Chrome did not create a recent tab');
      stripTabIds.push(tab.id);
    }
    const used = [
      ...stripTabIds.filter((_, index) => index % 2 === 1),
      ...stripTabIds.filter((_, index) => index % 2 === 0),
    ];
    for (const tabId of used) {
      // Gives each use its own last-accessed time.
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
      await extension.chrome.tabs.update(tabId, { active: true });
    }
    return used;
  });
  // The tab used last is the active one, which the menu leaves out.
  const expectedTabIds = usedTabIds.slice(0, -1).reverse().slice(0, 20);

  await page.getByRole('button', { name: 'Show recent tabs' }).click();
  const recentTabsMenu = page.getByRole('menu', { name: 'Recent tabs' });
  await expect(recentTabsMenu).toBeVisible();
  await expect.poll(() => recentTabsMenu
    .locator('[role="menuitem"]:not([data-menu-item-id^="closed:"])')
    .evaluateAll((items) => items.map((item) => Number((item as HTMLElement).dataset.menuItemId))))
    .toEqual(expectedTabIds);
}));

test('dims and overlays loading icons across tabs, bookmarks, and favourites', () => withProfile('loading-favicons', async (profile) => {
  let releaseNavigation = () => {};

  try {
    const { context, worker } = await profile.launchExtension({ closeInitialPage: true });
    const page = await context.newPage();
    await page.setViewportSize({ width: 900, height: 900 });
    let holdNavigation = false;
    let markNavigationStarted = () => {};
    const navigationStarted = new Promise<void>((resolveStarted) => {
      markNavigationStarted = resolveStarted;
    });
    const navigationReleased = new Promise<void>((resolveReleased) => {
      releaseNavigation = resolveReleased;
    });
    await context.route('https://motion.test/**', async (route) => {
      if (holdNavigation && new URL(route.request().url()).pathname === '/shared') {
        markNavigationStarted();
        await navigationReleased;
      }
      await route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><title>Loaded motion page</title>',
      });
    });
    const fixture = await createMotionFixture(worker);
    const favouriteId = await worker.evaluate(async ({ parentId, url }) => {
      const extension = globalThis as unknown as ExtensionGlobal;
      const favourite = await extension.chrome.bookmarks.create({
        parentId,
        title: 'Loading favourite',
        url,
      });
      return favourite.id;
    }, {
      parentId: fixture.favouritesId,
      url: 'https://motion.test/shared',
    });
    await openSidepanel(page, worker);

    const loadingTabRow = page.locator(
      '.tab-row:visible:has(.tab-main[data-url^="https://motion.test/shared"])',
    ).first();
    const loadingTabId = Number(await loadingTabRow.getAttribute('data-tab-id'));
    expect(Number.isInteger(loadingTabId)).toBe(true);
    await page.evaluate((tabId) => {
      const extension = globalThis as unknown as {
        browser: {
          tabs: {
            onUpdated: {
              addListener: (listener: (
                updatedTabId: number,
                changeInfo: { status?: string },
              ) => void) => void;
            };
          };
        };
        hyperObservedTabStatuses?: string[];
      };
      extension.hyperObservedTabStatuses = [];
      extension.browser.tabs.onUpdated.addListener((updatedTabId, changeInfo) => {
        if (updatedTabId === tabId && changeInfo.status) {
          extension.hyperObservedTabStatuses?.push(changeInfo.status);
        }
      });
    }, loadingTabId);
    const loadingFavicons = [
      loadingTabRow.locator('.favicon'),
      page.locator(`[data-bookmark-node-id="${fixture.bookmarkId}"] .favicon`),
      page.locator(`[data-bookmark-node-id="${favouriteId}"] .favicon`),
    ];
    for (const favicon of loadingFavicons) {
      await expect(favicon).not.toHaveClass(/is-loading/, { timeout: 10_000 });
      await expect(favicon.locator('.favicon-loading-spinner')).toHaveCount(0, {
        timeout: 10_000,
      });
    }

    holdNavigation = true;
    await callChrome(worker, 'tabs.reload', loadingTabId);
    await navigationStarted;
    await expect.poll(async () => (await browserTab(worker, loadingTabId)).status)
      .toBe('loading');
    await expect.poll(() => page.evaluate(() =>
      (globalThis as unknown as { hyperObservedTabStatuses?: string[] })
        .hyperObservedTabStatuses ?? [])).toContain('loading');
    for (const favicon of loadingFavicons) {
      await expect(favicon).toHaveClass(/is-loading/);
      await expect(favicon.locator('.favicon-visual')).toHaveCSS('opacity', '0.5');
      await expect(favicon.locator('.favicon-loading-spinner')).toBeVisible();
    }

    releaseNavigation();
    for (const favicon of loadingFavicons) {
      await expect(favicon).not.toHaveClass(/is-loading/, { timeout: 10_000 });
      await expect(favicon.locator('.favicon-visual')).toHaveCSS('opacity', '1');
      await expect(favicon.locator('.favicon-loading-spinner')).toHaveCount(0);
    }
  } finally {
    releaseNavigation();
  }
}));
