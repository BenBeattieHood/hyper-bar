import { expect, test, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { bookmarkChildren, callChrome, seedHyperSpace } from './helpers/chrome';
import { openSidepanel, routeHtml, withExtension } from './helpers/extension';
import { backedTabRow, clickSelectionWithModifierReleased } from './helpers/sidebar';

interface Fixture {
  alphaId: string;
  docsId: string;
  guideId: string;
  inboxId: string;
  newsId: string;
}

const NEWS_URL = 'https://menus.test/news';
const ALPHA_URL = 'https://menus.test/alpha';

// The space's bookmarks: Docs/ (Guide), Inbox/ (empty), News, Alpha
async function createFixture(worker: Worker): Promise<Fixture> {
  const ids = await seedHyperSpace<'alpha' | 'docs' | 'guide' | 'inbox' | 'news'>(worker, {
    bookmarks: [
      {
        key: 'docs',
        title: 'Docs',
        children: [{ key: 'guide', title: 'Guide', url: 'https://menus.test/guide' }],
      },
      { key: 'inbox', title: 'Inbox' },
      { key: 'news', title: 'News', url: NEWS_URL },
      { key: 'alpha', title: 'Alpha', url: ALPHA_URL },
    ],
  });
  return { alphaId: ids.alpha, docsId: ids.docs, guideId: ids.guide, inboxId: ids.inbox, newsId: ids.news };
}

/** Opens a page that counts its loads in session storage under `key`. */
async function openCountingTab(context: BrowserContext, url: string, key: string): Promise<Page> {
  const tab = await context.newPage();
  await tab.addInitScript((countKey) => {
    sessionStorage.setItem(countKey, String(Number(sessionStorage.getItem(countKey) ?? '0') + 1));
  }, key);
  await tab.goto(url);
  return tab;
}

/** Each tab's load count; a tab in the middle of reloading reads as null. */
const loadCounts = (tabs: readonly Page[], key: string) => Promise.all(tabs.map(async (tab) => {
  try {
    return await tab.evaluate((countKey) => sessionStorage.getItem(countKey), key);
  } catch {
    return null;
  }
}));

const row = (page: Page, nodeId: string) =>
  page.locator(`[data-bookmark-node-id="${nodeId}"] .tree-item-main`).first();

async function withSidebar(
  run: (page: Page, worker: Worker, fixture: Fixture, context: BrowserContext) => Promise<void>,
) {
  await withExtension('item-menus', async ({ context, worker }) => {
    await routeHtml(context, 'https://menus.test/**', '<!doctype html><title>Menus page</title><input id="field">');
    const fixture = await createFixture(worker);
    const page = await openSidepanel(context, worker, { width: 900, height: 900 });
    await expect(row(page, fixture.alphaId)).toBeVisible();
    await run(page, worker, fixture, context);
  });
}

// Each step is resolved by the background against the siblings it finds, so presses faster than the model can answer still land one place apart.
test('moving a bookmark by keyboard steps it one place per press and stops at the end', async () => {
  await withSidebar(async (page, worker, fixture) => {
    const spaceFolderId = (await callChrome<Array<{ parentId: string }>>(worker, 'bookmarks.get', fixture.docsId))[0]!.parentId;
    const order = async () => (await bookmarkChildren(worker, spaceFolderId))
      .map((node) => node.id)
      .filter((id) => [fixture.docsId, fixture.inboxId, fixture.newsId, fixture.alphaId].includes(id));
    await expect.poll(order).toEqual([fixture.docsId, fixture.inboxId, fixture.newsId, fixture.alphaId]);
    await row(page, fixture.docsId).focus();

    for (let press = 0; press < 4; press += 1) await page.keyboard.press('Alt+ArrowDown');

    await expect.poll(order).toEqual([fixture.inboxId, fixture.newsId, fixture.alphaId, fixture.docsId]);
    await page.keyboard.press('Alt+ArrowUp');
    await expect.poll(order).toEqual([fixture.inboxId, fixture.newsId, fixture.docsId, fixture.alphaId]);
  });
});

test('the bookmark tree takes the standard tree keys', async () => {
  await withSidebar(async (page, _worker, fixture) => {
    const docs = row(page, fixture.docsId);
    await expect(docs).toHaveAttribute('aria-expanded', 'false');
    await docs.focus();

    await page.keyboard.press('ArrowRight');
    await expect(docs).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('ArrowRight');
    await expect(row(page, fixture.guideId)).toBeFocused();
    await page.keyboard.press('ArrowLeft');
    await expect(docs).toBeFocused();
    await page.keyboard.press('ArrowLeft');
    await expect(docs).toHaveAttribute('aria-expanded', 'false');

    await page.keyboard.press('End');
    await expect(row(page, fixture.alphaId)).toBeFocused();
    await page.keyboard.press('Home');
    await expect(docs).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(row(page, fixture.inboxId)).toBeFocused();
    await page.keyboard.type('ne');
    await expect(row(page, fixture.newsId)).toBeFocused();

    // Shift+F10 opens the focused row's menu, and Escape gives focus back to the row.
    await page.keyboard.press('Shift+F10');
    await expect(page.getByRole('menu', { name: 'Actions for News' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: /^Rename/ })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(row(page, fixture.newsId)).toBeFocused();
  });
});

test('folder menus hide Paste when clipboard text cannot be pasted', async () => {
  await withSidebar(async (page, _worker, fixture) => {
    await page.evaluate(() => {
      const input = document.createElement('textarea');
      input.id = 'clipboard-probe';
      input.value = 'not a pasteable address';
      document.body.append(input);
      input.focus();
      input.select();
    });
    await page.keyboard.press('ControlOrMeta+C');
    await page.locator('#clipboard-probe').evaluate((input) => input.remove());

    await row(page, fixture.docsId).click({ button: 'right' });
    const menu = page.getByRole('menu', { name: 'Actions for Docs' });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: /^Paste/ })).toHaveCount(0);
  });
});

test('bookmark folder reload and close cover all descendant tabs in the space', async () => {
  await withSidebar(async (page, worker, fixture, context) => {
    const secondUrl = 'https://menus.test/guide-two';
    const { id: nestedId } = await callChrome<{ id: string }>(worker, 'bookmarks.create', {
      parentId: fixture.docsId,
      title: 'Nested',
    });
    await callChrome(worker, 'bookmarks.create', { parentId: nestedId, title: 'Guide two', url: secondUrl });

    const tabs = await Promise.all(['https://menus.test/guide', secondUrl].map((url) =>
      openCountingTab(context, url, 'folder-reload-count')));
    const firstTabRow = page.locator('.tab-row:has(.tab-main[data-url="https://menus.test/guide"])');
    const secondTabRow = backedTabRow(page, secondUrl);
    await expect(firstTabRow).toBeVisible();
    await expect(secondTabRow).toBeVisible();
    await expect.poll(() => loadCounts(tabs, 'folder-reload-count')).toEqual(['1', '1']);

    const docs = row(page, fixture.docsId);
    await docs.click({ button: 'right' });
    let menu = page.getByRole('menu', { name: 'Actions for Docs' });
    const reload = menu.getByRole('menuitem', { name: 'Reload 2 tabs' });
    await expect(reload).toBeVisible();
    await reload.click();
    await expect.poll(() => loadCounts(tabs, 'folder-reload-count')).toEqual(['2', '2']);

    await docs.click({ button: 'right' });
    menu = page.getByRole('menu', { name: 'Actions for Docs' });
    const close = menu.getByRole('menuitem', { name: 'Close 2 tabs' });
    await expect(close).toBeVisible();
    const closedTabs = Promise.all(tabs.map((tab) => tab.waitForEvent('close')));
    await close.click();
    await closedTabs;
    await expect(firstTabRow).toHaveCount(0);
    await expect(secondTabRow).toHaveCount(0);
  });
});

test('copy, cut and paste act as drops, and a text field gets only the address', async () => {
  await withSidebar(async (page, worker, fixture, context) => {
    const news = row(page, fixture.newsId);
    await page.evaluate(() => {
      document.addEventListener('contextmenu', (event) => {
        document.documentElement.dataset.contextMenuX = String(event.clientX);
        document.documentElement.dataset.contextMenuY = String(event.clientY);
      }, { once: true });
    });
    await news.click({ button: 'right' });
    const menu = page.getByRole('menu', { name: 'Actions for News' });
    await expect(menu).toBeVisible();
    await expect(menu).toHaveCSS('animation-name', 'none');
    const menuBounds = await menu.boundingBox();
    expect(menuBounds).not.toBeNull();
    const root = page.locator('html');
    const pointerX = Number(await root.getAttribute('data-context-menu-x'));
    const pointerY = Number(await root.getAttribute('data-context-menu-y'));
    expect(menuBounds!.x).toBeGreaterThanOrEqual(pointerX);
    expect(menuBounds!.y).toBeGreaterThanOrEqual(pointerY);
    for (const name of [/^Rename/, /^Duplicate/, /^Cut/, /^Copy/, /^Remove bookmark/]) {
      await expect(menu.getByRole('menuitem', { name })).toBeVisible();
    }
    await menu.getByRole('menuitem', { name: /^Copy/ }).click();
    await expect(menu).toHaveCount(0);

    // Pasting a copy onto a folder copies the bookmark into it, as a copy-drop there would.
    await row(page, fixture.inboxId).focus();
    await page.keyboard.press('ControlOrMeta+V');
    await expect.poll(() => bookmarkChildren(worker, fixture.inboxId))
      .toEqual([expect.objectContaining({ title: 'News', url: NEWS_URL })]);
    await expect(row(page, fixture.newsId)).toBeVisible();

    // Cutting moves the bookmark itself, and only when it is pasted.
    await row(page, fixture.alphaId).focus();
    await page.keyboard.press('ControlOrMeta+X');
    await expect(row(page, fixture.alphaId)).toBeVisible();
    await row(page, fixture.inboxId).click({ button: 'right' });
    await page.getByRole('menuitem', { name: /^Paste/ }).click();
    await expect.poll(async () => (await bookmarkChildren(worker, fixture.inboxId)).map((child) => child.id))
      .toContain(fixture.alphaId);

    const other = await context.newPage();
    await other.goto('https://menus.test/field');
    await other.locator('#field').focus();
    await other.keyboard.press('ControlOrMeta+V');
    await expect(other.locator('#field')).toHaveValue(ALPHA_URL);
  });
});

test('search results take Home and End, and open their row\u2019s menu', async () => {
  await withSidebar(async (page) => {
    await page.keyboard.press('ControlOrMeta+K');
    const input = page.getByRole('combobox', { name: /Search tabs, bookmarks/ });
    await expect(input).toBeFocused();
    await input.fill('menus.test');
    const options = page.locator('#command-bar-results [role="option"]');
    await expect.poll(() => options.count()).toBeGreaterThan(2);

    // Home stays with the caret until the arrows move into the results.
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('End');
    await expect(options.last()).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Home');
    await expect(options.first()).toHaveAttribute('aria-selected', 'true');

    const news = page.locator('.command-result-row', { hasText: 'News' }).first();
    await news.click({ button: 'right' });
    const menu = page.getByRole('menu', { name: 'Actions for News' });
    for (const name of [/^Open in new tab/, /^Rename/, /^Copy/, /^Remove bookmark/]) {
      await expect(menu.getByRole('menuitem', { name })).toBeVisible();
    }
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(input).toBeFocused();
  });
});

test('a context menu closes after the pointer leaves the extension for two seconds', async () => {
  await withSidebar(async (page, _worker, fixture) => {
    await row(page, fixture.newsId).click({ button: 'right' });
    const menu = page.getByRole('menu', { name: 'Actions for News' });
    await expect(menu).toBeVisible();
    await expect(menu).toHaveCSS('transition-property', 'opacity');

    await page.evaluate(() => {
      document.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: null }));
      document.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    await page.waitForTimeout(2100);
    await expect(menu).toBeVisible();

    await page.evaluate(() => {
      document.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: null }));
    });
    await expect(menu).toHaveCount(0, { timeout: 2500 });
  });
});

test('Reload applies to every selected tab', async () => {
  await withSidebar(async (page, _worker, _fixture, context) => {
    const firstUrl = 'https://menus.test/reload-one';
    const secondUrl = 'https://menus.test/reload-two';
    const tabs = await Promise.all([firstUrl, secondUrl].map((url) =>
      openCountingTab(context, url, 'hyper-reload-count')));
    const firstRow = backedTabRow(page, firstUrl);
    const secondRow = backedTabRow(page, secondUrl);
    await expect(firstRow).toBeVisible();
    await expect(secondRow).toBeVisible();
    await expect.poll(() => loadCounts(tabs, 'hyper-reload-count')).toEqual(['1', '1']);

    await clickSelectionWithModifierReleased(page, firstRow.locator('.tab-main'));
    await clickSelectionWithModifierReleased(page, secondRow.locator('.tab-main'));
    await expect(page.locator('.tab-row.is-drag-selected')).toHaveCount(2);
    await secondRow.locator('.tab-main').dispatchEvent('contextmenu', { clientX: 400, clientY: 400 });
    const menu = page.getByRole('menu', { name: 'Actions for Menus page' });
    const reload = menu.getByRole('menuitem', { name: 'Reload 2 tabs' });
    await expect(reload).toBeVisible();
    await reload.click();
    await expect.poll(() => loadCounts(tabs, 'hyper-reload-count')).toEqual(['2', '2']);
  });
});
