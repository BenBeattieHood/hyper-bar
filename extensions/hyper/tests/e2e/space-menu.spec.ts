import { expect, test, type BrowserContext, type Locator, type Page, type Worker } from '@playwright/test';
import { callChrome } from './helpers/chrome';
import { withHyper } from './helpers/extension';
import { renderedTabOrder, spaceDot, spaceDotById, spaceDotTitles as dotTitles } from './helpers/sidebar';
import { createSecondSpace, spaceIdByTitle } from './helpers/spaces';
import { storedTabSpaces, tabOwnershipSummary } from './helpers/tabs';

const ORIGIN = 'https://space-menu.test';

interface WindowPage {
  active: boolean;
  id: number;
  spaceId?: string;
  url: string;
}

interface SpaceMenuHyper {
  context: BrowserContext;
  /** Document loads per path, which counts reloads. */
  loads: Map<string, number>;
  page: Page;
  worker: Worker;
}

const withSpaces = (name: string, run: (hyper: SpaceMenuHyper) => Promise<void>) =>
  withHyper(`space-menu-${name}`, async ({ context, page, worker }) => {
    const loads = new Map<string, number>();
    await context.route(`${ORIGIN}/**`, (route) => {
      const path = new URL(route.request().url()).pathname;
      if (route.request().resourceType() === 'document') loads.set(path, (loads.get(path) ?? 0) + 1);
      return route.fulfill({
        body: `<!doctype html><title>Page ${path.slice(1)}</title>`,
        contentType: 'text/html',
      });
    });
    await page.setViewportSize({ width: 360, height: 760 });
    await expect(page.locator('.space-pagination-dot')).toHaveCount(1);
    await run({ context, loads, page, worker });
  }, { closeInitialPage: true });

/** The window's unpinned tabs in tab strip order, with the space each belongs to. */
async function windowPages(worker: Worker): Promise<WindowPage[]> {
  const tabs = (await callChrome<Array<{
    active: boolean;
    id?: number;
    index: number;
    pendingUrl?: string;
    pinned: boolean;
    url?: string;
  }>>(worker, 'tabs.query', { currentWindow: true }))
    .filter((tab) => !tab.pinned && tab.id !== undefined)
    .sort((left, right) => left.index - right.index);
  const spaces = await storedTabSpaces(worker, tabs.map((tab) => tab.id as number));
  return tabs.map((tab, index) => ({
    active: tab.active,
    id: tab.id as number,
    spaceId: spaces[index]?.spaceId,
    url: tab.pendingUrl ?? tab.url ?? '',
  }));
}

const activate = (worker: Worker, tabId: number) => callChrome(worker, 'tabs.update', tabId, { active: true });

/**
 * Opens pages in the space the window shows, answering their tabs. The test opens them itself
 * because Playwright attaches to a tab the extension opens only after its first request has
 * gone out unrouted.
 */
async function openPages<const Urls extends readonly string[]>(
  context: BrowserContext,
  worker: Worker,
  urls: Urls,
): Promise<{ -readonly [Index in keyof Urls]: number }> {
  for (const url of urls) await (await context.newPage()).goto(url);
  const pages = await windowPages(worker);
  return urls.map((url) => {
    const tabId = pages.find((tab) => tab.url === url)?.id;
    if (tabId === undefined) throw new Error(`No tab shows ${url}`);
    return tabId;
  }) as { -readonly [Index in keyof Urls]: number };
}


async function openSpaceMenu(page: Page, spaceId: string, title: string): Promise<Locator> {
  await spaceDotById(page, spaceId).click({ button: 'right' });
  const menu = page.getByRole('menu', { name: `Actions for ${title}` });
  await expect(menu).toBeVisible();
  return menu;
}

test('a space menu renames a space in place and duplicates one with its tabs into a copy to name', async () => {
  await withSpaces('duplicate', async ({ context, page, worker }) => {
    const { firstSpaceId, secondSpaceId } = await createSecondSpace(worker);
    const firstDot = spaceDotById(page, firstSpaceId);
    const secondDot = spaceDotById(page, secondSpaceId);
    await expect(page.locator('.space-pagination-dot')).toHaveCount(2);

    // A space with no tabs in this window has none to reload, close or copy.
    let menu = await openSpaceMenu(page, secondSpaceId, 'Second space');
    await expect(menu.getByRole('menuitem')).toHaveText(['Rename', 'Duplicate', 'Archive', 'Delete space']);
    await menu.getByRole('menuitem', { name: 'Rename' }).click();
    const renaming = page.getByRole('dialog', { name: 'Rename space' });
    const newName = renaming.getByLabel('Title');
    await expect(newName).toBeFocused();
    await expect(newName).toHaveValue('Second space');
    expect(await newName.evaluate((input: HTMLInputElement) => [input.selectionStart, input.selectionEnd]))
      .toEqual([0, 'Second space'.length]);
    await newName.fill('Errands');
    await newName.press('Enter');
    await expect(renaming).toHaveCount(0);
    await expect(secondDot).toHaveAttribute('title', /^Errands \(.+\)$/);
    await expect(secondDot).toBeFocused();
    await expect(firstDot).toHaveAttribute('aria-current', 'page');

    const originals = await openPages(context, worker, [`${ORIGIN}/a`, `${ORIGIN}/b`]);
    await expect.poll(() => tabOwnershipSummary(worker, originals)).toEqual({ allOwned: true, spaceCount: 1 });
    await expect.poll(() => renderedTabOrder(page, originals)).toEqual(originals);

    menu = await openSpaceMenu(page, firstSpaceId, 'Space 1');
    await expect(menu.getByRole('menuitem')).toHaveText([
      'Rename',
      'Duplicate',
      'Duplicate with tabs',
      'Reload 2 tabs',
      'Close 2 tabs',
      'Archive',
      'Delete space',
    ]);
    await expect(menu).toHaveCSS('opacity', '1');
    await page.screenshot({ path: 'logs/space-menu.png' });
    await menu.getByRole('menuitem', { name: 'Duplicate with tabs' }).click();

    // The copy is named after the first space as a second one would be, and Escape keeps that name.
    const naming = page.getByRole('dialog', { name: 'Name the copy' });
    await expect(naming).toContainText('Cancel keeps the name Space 2.');
    await expect(naming.getByLabel('Title')).toHaveValue('Space 2');
    await expect(naming.getByLabel('Title')).toBeFocused();
    await page.screenshot({ animations: 'disabled', path: 'logs/space-menu-name-copy.png' });
    await page.keyboard.press('Escape');
    await expect(naming).toHaveCount(0);
    await expect(firstDot).toBeFocused();
    await expect.poll(() => dotTitles(page)).toEqual(['Space 1', 'Space 2', 'Errands']);
    await expect(spaceDot(page, 'Space 2'))
      .toHaveAttribute('aria-current', 'page');

    const copyId = await spaceIdByTitle(worker, 'Space 2');
    expect(copyId).toBeDefined();
    const inSpace = (pages: WindowPage[], spaceId: string | undefined) =>
      pages.filter((tab) => tab.spaceId === spaceId);
    await expect.poll(async () => {
      const pages = await windowPages(worker);
      return {
        copies: inSpace(pages, copyId).map(({ url }) => url),
        originals: inSpace(pages, firstSpaceId).map(({ id }) => id),
      };
    }).toEqual({ copies: [`${ORIGIN}/a`, `${ORIGIN}/b`], originals });
    const pages = await windowPages(worker);
    const copies = inSpace(pages, copyId).map(({ id }) => id);
    expect(pages.find((tab) => tab.active)?.spaceId).toBe(copyId);
    await expect.poll(() => renderedTabOrder(page, copies)).toEqual(copies);
  });
});

test('a space menu reloads the space\'s tabs, and closes them all with an undo that reopens them', async () => {
  await withSpaces('close', async ({ context, loads, page, worker }) => {
    const spaceId = await spaceIdByTitle(worker, 'Space 1');
    if (!spaceId) throw new Error('Hyper did not create its first space');
    const urls = [`${ORIGIN}/one`, `${ORIGIN}/two`, `${ORIGIN}/three`] as const;
    const [one, two, three] = await openPages(context, worker, urls);
    await expect.poll(() => tabOwnershipSummary(worker, [one, two, three]))
      .toEqual({ allOwned: true, spaceCount: 1 });
    await activate(worker, two);
    await expect.poll(() => renderedTabOrder(page, [one, two, three])).toEqual([one, two, three]);

    // Reloading reloads every page in the space, the ones behind the shown tab as well.
    // Tabs holding no page are left to load when shown; the test browser crashes discarding one,
    // so unit tests cover that.
    const items = page.getByRole('menu', { name: 'Actions for Space 1' }).getByRole('menuitem');
    await openSpaceMenu(page, spaceId, 'Space 1');
    await expect(items).toHaveText(['Rename', 'Duplicate', 'Duplicate with tabs', 'Reload 3 tabs', 'Close 3 tabs']);
    expect(Object.fromEntries(loads)).toEqual({ '/one': 1, '/three': 1, '/two': 1 });
    await items.filter({ hasText: 'Reload 3 tabs' }).click();
    await expect(items).toHaveCount(0);
    await expect.poll(() => Object.fromEntries(loads)).toEqual({ '/one': 2, '/three': 2, '/two': 2 });

    await openSpaceMenu(page, spaceId, 'Space 1');
    await items.filter({ hasText: 'Close 3 tabs' }).click();
    // The window keeps showing the space, on a new tab page, rather than another space's tab.
    await expect.poll(async () => (await windowPages(worker)).map(({ active, spaceId: owner, url }) => ({
      active,
      owner,
      page: url.startsWith(ORIGIN),
    }))).toEqual([{ active: true, owner: spaceId, page: false }]);
    await expect(spaceDotById(page, spaceId)).toHaveAttribute('aria-current', 'page');
    await expect.poll(() => renderedTabOrder(page, [one, two, three])).toEqual([]);
    const notices = page.locator('.topbar .countdown-notice');
    await expect(notices.getByRole('status')).toHaveText('Closed 3 tabs');
    await notices.getByRole('button', { name: 'Undo' }).click();

    // Undo puts the pages back in order, shows the one that was showing, and drops the stand-in.
    await expect(notices).toHaveCount(0);
    await expect.poll(async () => (await windowPages(worker)).map(({ active, spaceId: owner, url }) => ({
      active,
      owner,
      url,
    }))).toEqual(urls.map((url, index) => ({ active: index === 1, owner: spaceId, url })));
    const reopened = (await windowPages(worker)).map(({ id }) => id);
    await expect.poll(() => renderedTabOrder(page, reopened)).toEqual(reopened);
  });
});

test('a space menu opens from the keyboard, duplicates a space and deletes spaces until one is left', async () => {
  await withSpaces('keyboard', async ({ page, worker }) => {
    const { firstSpaceId, secondSpaceId } = await createSecondSpace(worker);
    const secondDot = spaceDotById(page, secondSpaceId);
    await expect(page.locator('.space-pagination-dot')).toHaveCount(2);

    await secondDot.focus();
    await page.keyboard.press('Shift+F10');
    const menu = page.getByRole('menu', { name: 'Actions for Second space' });
    await expect(menu.getByRole('menuitem', { name: 'Rename' })).toBeFocused();
    // With no room below the dot, the menu opens above it rather than over it.
    await expect(menu).toHaveCSS('opacity', '1');
    const [menuBox, dotBox] = [await menu.boundingBox(), await secondDot.boundingBox()];
    if (!menuBox || !dotBox) throw new Error('The menu or its dot is not laid out');
    expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(dotBox.y);
    await page.screenshot({ path: 'logs/space-menu-keyboard.png' });
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(secondDot).toBeFocused();

    // Duplicating copies only the bookmarks, and the name typed for the copy sticks.
    await page.keyboard.press('Shift+F10');
    await expect(menu.getByRole('menuitem', { name: 'Rename' })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(menu.getByRole('menuitem', { name: 'Duplicate', exact: true })).toBeFocused();
    await page.keyboard.press('Enter');
    const naming = page.getByRole('dialog', { name: 'Name the copy' });
    await expect(naming.getByLabel('Title')).toHaveValue('Second space 2');
    await naming.getByLabel('Title').fill('Copy');
    await page.keyboard.press('Enter');
    await expect(naming).toHaveCount(0);
    await expect.poll(() => dotTitles(page)).toEqual(['Space 1', 'Second space', 'Copy']);
    const copyId = await spaceIdByTitle(worker, 'Copy');
    if (!copyId) throw new Error('The copy was not named');
    await expect(spaceDotById(page, copyId)).toHaveAttribute('aria-current', 'page');

    // The Menu key opens it too, and deleting an empty space needs no confirmation.
    await secondDot.focus();
    await page.keyboard.press('ContextMenu');
    await menu.getByRole('menuitem', { name: 'Delete space' }).click();
    await expect.poll(() => dotTitles(page)).toEqual(['Space 1', 'Copy']);
    await expect.poll(() => spaceIdByTitle(worker, 'Second space')).toBeUndefined();

    // Deleting the space the window shows takes the window to the space left.
    const copyMenu = await openSpaceMenu(page, copyId, 'Copy');
    await copyMenu.getByRole('menuitem', { name: 'Delete space' }).click();
    await expect.poll(() => dotTitles(page)).toEqual(['Space 1']);
    await expect(spaceDotById(page, firstSpaceId)).toHaveAttribute('aria-current', 'page');

    // The last space cannot be deleted, and a new tab page is nothing to reload or close.
    const lastMenu = await openSpaceMenu(page, firstSpaceId, 'Space 1');
    await expect(lastMenu.getByRole('menuitem')).toHaveText(['Rename', 'Duplicate']);
  });
});
