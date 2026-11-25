import { expect, test, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { saveHyperPreference } from './fixtures/preferences';
import { bookmarkChildren, bookmarkParentId, callChrome, seedHyperSpace } from './helpers/chrome';
import { openSidepanel, routePathTitles, withExtension } from './helpers/extension';
import { dragWithPointer } from './helpers/sidebar';
import { createTab, openTabUrls } from './helpers/tabs';

const PAGE = (name: string) => `https://favourites.test/${name}`;

interface Fixture {
  favouritesId: string;
  globalReadingId: string;
}

// A pinned favourite in slot 2, and one global bookmark kept in hyper/bookmarks.
async function createFixture(worker: Worker): Promise<Fixture> {
  const ids = await seedHyperSpace<'reading'>(worker, {
    favourites: [{ title: `Pinned ${JSON.stringify({ hyper: { favouriteSlot: 1 } })}`, url: PAGE('pinned') }],
    globalBookmarks: [{ key: 'reading', title: 'Reading', url: PAGE('reading') }],
  });
  return { favouritesId: ids.favourites, globalReadingId: ids.reading };
}

const children = async (worker: Worker, parentId: string) =>
  (await bookmarkChildren(worker, parentId)).map(({ title, url }) => ({ title, url }));

const globalFolderId = async (worker: Worker, readingId: string) =>
  await bookmarkParentId(worker, readingId) ?? '';

const activeTabUrl = async (worker: Worker) =>
  (await callChrome<Array<{ url?: string }>>(worker, 'tabs.query', { active: true }))[0]?.url;

async function withSidebar(
  run: (page: Page, worker: Worker, fixture: Fixture, context: BrowserContext) => Promise<void>,
  { grouped = false } = {},
) {
  await withExtension('favourites-bar', async ({ context, worker }) => {
    await routePathTitles(context, 'https://favourites.test/**');
    const fixture = await createFixture(worker);
    // Every fixture page is on one site, so tests of single tiles turn grouping off.
    if (!grouped) await saveHyperPreference(worker, 'groupFavouritesByDomain', false);
    for (const name of ['one', 'two']) {
      const tab = await context.newPage();
      await tab.goto(PAGE(name));
    }
    const page = await openSidepanel(context, worker, { width: 360, height: 820 });
    await expect(page.locator(grouped ? '.favourite-tile.is-pinned.is-group' : '.favourite-tile.is-pinned')).toHaveCount(1);
    await run(page, worker, fixture, context);
  });
}

const recentTile = (page: Page, url: string) => page.locator(`.favourite-tile.is-recent[data-url="${url}"]`);

test('empty favourite slots show recent tabs around a pinned favourite, with the global button last', async () => {
  await withSidebar(async (page) => {
    const slots = page.locator('.favourites-grid > .favourite-slot');
    await expect(slots).toHaveCount(8);
    await expect(slots.nth(1).locator('.favourite-tile.is-pinned .favourite-pin')).toHaveCount(1);
    await expect(slots.nth(7).getByRole('button', { name: 'Global bookmarks' })).toBeVisible();
    // Most recently used first, the sidebar's own page left out.
    await expect(slots.nth(0).locator('.favourite-tile')).toHaveAttribute('data-url', PAGE('two'));
    await expect(slots.nth(2).locator('.favourite-tile')).toHaveAttribute('data-url', PAGE('one'));
    await expect(page.locator('.favourite-tile.is-recent[data-url^="chrome-extension:"]')).toHaveCount(0);
  });
});

test('a recent tab pins from its menu, middle-clicks unpin a favourite, and middle-click or Remove takes a recent tab off the bar', async () => {
  await withSidebar(async (page, worker, fixture) => {
    await recentTile(page, PAGE('one')).click({ button: 'right' });
    await page.getByRole('menu').getByRole('menuitem', { name: 'Pin' }).click();
    await expect(page.locator(`.favourite-tile.is-pinned[data-url="${PAGE('one')}"] .favourite-pin`)).toHaveCount(1);
    await expect.poll(async () => (await children(worker, fixture.favouritesId)).map((child) => child.url))
      .toContain(PAGE('one'));

    await page.locator(`.favourite-tile.is-pinned[data-url="${PAGE('one')}"]`).click({ button: 'middle' });
    await expect(recentTile(page, PAGE('one'))).toBeVisible();
    await expect.poll(async () => (await children(worker, fixture.favouritesId)).map((child) => child.url))
      .not.toContain(PAGE('one'));
    expect(await openTabUrls(worker)).toContain(PAGE('one'));

    await recentTile(page, PAGE('two')).click({ button: 'middle' });
    await expect(recentTile(page, PAGE('two'))).toHaveCount(0);
    expect(await openTabUrls(worker)).toContain(PAGE('two'));
    // Using the tab again brings it back.
    await page.locator(`.tab-row:has(.tab-main[data-url="${PAGE('two')}"]) .tab-main`).click();
    await expect(recentTile(page, PAGE('two'))).toBeVisible();

    await recentTile(page, PAGE('two')).click({ button: 'right' });
    await expect(page.getByRole('menu').getByRole('menuitem', { name: 'Delete' })).toHaveCount(0);
    await page.getByRole('menu').getByRole('menuitem', { name: 'Remove' }).click();
    await expect(recentTile(page, PAGE('two'))).toHaveCount(0);
    expect(await openTabUrls(worker)).toContain(PAGE('two'));
  });
});

test('Ctrl/Cmd+middle-click or Close closes a recent tab', async () => {
  await withSidebar(async (page, worker) => {
    await recentTile(page, PAGE('two')).click({ button: 'middle', modifiers: ['ControlOrMeta'] });
    await expect.poll(() => openTabUrls(worker)).not.toContain(PAGE('two'));
    await expect(recentTile(page, PAGE('two'))).toHaveCount(0);

    await recentTile(page, PAGE('one')).click({ button: 'right' });
    await page.getByRole('menu').getByRole('menuitem', { name: 'Close' }).click();
    await expect.poll(() => openTabUrls(worker)).not.toContain(PAGE('one'));
    await expect(recentTile(page, PAGE('one'))).toHaveCount(0);
  });
});

test('Ctrl/Cmd+middle-click or Close unpins a favourite and closes its tab', async () => {
  await withSidebar(async (page, worker, fixture) => {
    const pinned = page.locator(`.favourite-tile.is-pinned[data-url="${PAGE('pinned')}"]`);
    const pinnedUrls = async () => (await children(worker, fixture.favouritesId)).map((child) => child.url);

    await pinned.click();
    await expect.poll(() => openTabUrls(worker)).toContain(PAGE('pinned'));
    await pinned.click({ button: 'middle', modifiers: ['ControlOrMeta'] });
    await expect.poll(() => openTabUrls(worker)).not.toContain(PAGE('pinned'));
    await expect.poll(pinnedUrls).not.toContain(PAGE('pinned'));

    await recentTile(page, PAGE('one')).click({ button: 'right' });
    await page.getByRole('menu').getByRole('menuitem', { name: 'Pin' }).click();
    const one = page.locator(`.favourite-tile.is-pinned[data-url="${PAGE('one')}"]`);
    await one.click({ button: 'right' });
    await expect(page.getByRole('menu').getByRole('menuitem', { name: 'Delete' })).toHaveCount(0);
    await page.getByRole('menu').getByRole('menuitem', { name: 'Close' }).click();
    await expect.poll(() => openTabUrls(worker)).not.toContain(PAGE('one'));
    await expect.poll(pinnedUrls).not.toContain(PAGE('one'));
    await expect(one).toHaveCount(0);
  });
});

test('hovering a tile names it below the bar; the name keeps the hover and clicks as the tile', async () => {
  await withSidebar(async (page, worker) => {
    const label = page.locator('.favourite-hover-label');
    const pinned = page.locator('.favourite-tile.is-pinned');
    await expect(pinned).not.toHaveAttribute('title');
    await expect(pinned).toHaveAttribute('aria-description', PAGE('pinned'));

    await pinned.hover();
    await expect(label).toHaveText('Pinned');
    await recentTile(page, PAGE('one')).hover();
    await expect(label).toHaveText('one');
    await expect(label).toHaveCount(1);

    await label.hover();
    await expect(label).toHaveText('one');
    await expect(page.locator('.favourite-slot.is-hovered .favourite-tile')).toHaveAttribute('data-url', PAGE('one'));
    await label.click();
    await expect.poll(() => activeTabUrl(worker)).toBe(PAGE('one'));

    await page.mouse.move(5, 700);
    await expect(label).toHaveCount(0);
    await expect(page.locator('.favourite-slot.is-hovered')).toHaveCount(0);
  });
});

test('a tile click brings back the tabs list from bookmarks or global bookmarks', async () => {
  await withSidebar(async (page, worker) => {
    await saveHyperPreference(worker, 'combineTabsAndBookmarks', false);
    const tabsView = page.getByRole('tab', { name: 'Tabs', exact: true });
    await page.getByRole('tab', { name: 'Bookmarks' }).click();
    await expect(tabsView).toHaveAttribute('aria-selected', 'false');
    await page.locator('.favourite-tile.is-pinned').click();
    await expect(tabsView).toHaveAttribute('aria-selected', 'true');
    await expect.poll(() => activeTabUrl(worker)).toBe(PAGE('pinned'));

    await page.getByRole('tab', { name: 'Bookmarks' }).click();
    await page.getByRole('button', { name: 'Global bookmarks' }).click();
    await expect(page.locator('#global-bookmarks-panel')).toBeVisible();
    await recentTile(page, PAGE('one')).click();
    await expect(page.locator('#global-bookmarks-panel')).toHaveCount(0);
    await expect(tabsView).toHaveAttribute('aria-selected', 'true');
    await expect.poll(() => activeTabUrl(worker)).toBe(PAGE('one'));
  });
});

test('the global button opens global bookmarks in place of the space, and Escape closes them', async () => {
  await withSidebar(async (page, _worker, fixture) => {
    const button = page.getByRole('button', { name: 'Global bookmarks' });
    await button.click();
    const panel = page.locator('#global-bookmarks-panel');
    await expect(panel).toBeVisible();
    await expect(button).toHaveAttribute('aria-expanded', 'true');
    await expect(panel.locator(`[data-bookmark-node-id="${fixture.globalReadingId}"]`)).toBeVisible();
    await expect(page.locator('.space-panel:not(.global-bookmarks-panel)')).toHaveCount(0);

    await page.keyboard.press('Escape');
    await expect(panel).toHaveCount(0);
    await expect(page.locator('.space-panel')).toBeVisible();
    await expect(button).toHaveAttribute('aria-expanded', 'false');

    await button.click();
    await expect(panel).toBeVisible();
    await button.click();
    await expect(panel).toHaveCount(0);
    await expect(page.locator('.space-panel')).toBeVisible();
  });
});

test('a tab dropped on the global button becomes a global bookmark, and a held drag opens them', async () => {
  await withSidebar(async (page, worker, fixture) => {
    const button = page.getByRole('button', { name: 'Global bookmarks' });
    const tabRow = page.locator(`.tab-row:has(.tab-main[data-url="${PAGE('one')}"])`);
    // The tab is briefly shown twice while the sidebar links it to its bookmark.
    await expect(tabRow).toHaveCount(1);
    await dragWithPointer(page, tabRow, button);
    const folderId = await globalFolderId(worker, fixture.globalReadingId);
    await expect.poll(async () => (await children(worker, folderId)).map((child) => child.url))
      .toContain(PAGE('one'));
    await expect(tabRow).toHaveCount(1);

    const source = await tabRow.boundingBox();
    const target = await button.boundingBox();
    if (!source || !target) throw new Error('Drag fixture was not measurable');
    await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
    await page.mouse.down();
    await page.mouse.move(source.x + source.width / 2, source.y - 12, { steps: 2 });
    await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 8 });
    await expect(page.locator('#global-bookmarks-panel')).toBeVisible();
    await page.keyboard.press('Escape');
    await page.mouse.up();
  });
});

test('recent tabs hold their slots when one is clicked with the pointer over the bar', async () => {
  await withSidebar(async (page, worker) => {
    const slots = page.locator('.favourites-grid > .favourite-slot');
    await expect(slots.nth(0).locator('.favourite-tile')).toHaveAttribute('data-url', PAGE('two'));
    await recentTile(page, PAGE('one')).click();
    await expect.poll(() => activeTabUrl(worker)).toBe(PAGE('one'));
    // The browser moves focus to the activated tab; Playwright's focus emulation hides that.
    await page.evaluate(() => window.dispatchEvent(new FocusEvent('blur')));
    // Give the sidebar time to receive the new recency before checking it held.
    await page.waitForTimeout(500);
    await expect(slots.nth(0).locator('.favourite-tile')).toHaveAttribute('data-url', PAGE('two'));
    await expect(slots.nth(2).locator('.favourite-tile')).toHaveAttribute('data-url', PAGE('one'));

    // A tab opened from elsewhere is new to the bar, so it may take a slot.
    await createTab(worker, PAGE('three'));
    await page.evaluate(() => window.dispatchEvent(new FocusEvent('blur')));
    await expect(recentTile(page, PAGE('three'))).toBeVisible();
    await expect(slots.nth(2).locator('.favourite-tile')).toHaveAttribute('data-url', PAGE('one'));

    // Once the pointer leaves the top of the sidebar, the bar catches up.
    await page.mouse.move(180, 700);
    await expect(slots.nth(0).locator('.favourite-tile')).toHaveAttribute('data-url', PAGE('three'));
    await expect(slots.nth(2).locator('.favourite-tile')).toHaveAttribute('data-url', PAGE('one'));
  });
});

test('middle-clicking a recent tab off the bar reorders the rest at once, with the pointer over the bar', async () => {
  await withSidebar(async (page, _worker, _fixture, context) => {
    const slots = page.locator('.favourites-grid > .favourite-slot');
    // The browser's first, least recently used tab opens a page, so its tile comes after the others.
    await context.pages()[0]!.goto(PAGE('three'));
    await expect(slots.nth(3).locator('.favourite-tile')).toHaveAttribute('data-url', PAGE('three'));
    await recentTile(page, PAGE('one')).click();
    // The browser moves focus to the activated tab; Playwright's focus emulation hides that.
    await page.evaluate(() => window.dispatchEvent(new FocusEvent('blur')));
    // The sidebar knows "one" is now the most recent, but the bar holds while the pointer is over it.
    await expect(recentTile(page, PAGE('one'))).toHaveAttribute('aria-label', /, current$/);
    await expect(slots.nth(0).locator('.favourite-tile')).toHaveAttribute('data-url', PAGE('two'));
    await expect(slots.nth(2).locator('.favourite-tile')).toHaveAttribute('data-url', PAGE('one'));

    await recentTile(page, PAGE('three')).click({ button: 'middle' });
    await expect(recentTile(page, PAGE('three'))).toHaveCount(0);
    await expect(slots.nth(0).locator('.favourite-tile')).toHaveAttribute('data-url', PAGE('one'));
    await expect(slots.nth(2).locator('.favourite-tile')).toHaveAttribute('data-url', PAGE('two'));
  });
});

/**
 * The tiles shown, and whether they reach the spaces bar: the room under the
 * last tile is less than another tile and its gap, and the panel does not
 * overflow.
 */
const favouritesColumn = (page: Page) => page.evaluate(() => {
  const grid = document.querySelector('.favourites-grid')!;
  const tiles = [...grid.querySelectorAll(':scope > .favourite-slot:not(.global-bookmarks-slot)')];
  const scroll = document.querySelector('.workspace-scroll')!;
  const last = tiles.at(-1)!.getBoundingClientRect();
  const pitch = last.height + Number.parseFloat(getComputedStyle(grid).rowGap);
  const under = Number.parseFloat(getComputedStyle(document.querySelector('.favourites-section')!).paddingBottom) +
    Number.parseFloat(getComputedStyle(grid).paddingBottom);
  const room = document.querySelector('.space-pagination')!.getBoundingClientRect().top - last.bottom - under;
  return {
    filled: room > -0.5 && room < pitch,
    overflows: scroll.scrollHeight > scroll.clientHeight,
    placeholders: grid.querySelectorAll('.favourite-placeholder').length,
    tiles: tiles.length,
  };
});

test('too narrow for the lists, recent tabs fill the favourites column down to the spaces bar', async () => {
  await withSidebar(async (page, worker, fixture) => {
    for (let index = 0; index < 24; index += 1) await createTab(worker, PAGE(`more-${index}`));
    await page.mouse.move(50, 815);

    const heights = new Map<number, number>();
    for (const height of [820, 480, 300, 820]) {
      await page.setViewportSize({ width: 100, height });
      await expect.poll(async () => {
        const { filled, overflows, placeholders } = await favouritesColumn(page);
        return { filled, overflows, placeholders };
      }, { message: `100x${height}` }).toEqual({ filled: true, overflows: false, placeholders: 0 });
      heights.set(height, (await favouritesColumn(page)).tiles);
      // Too short for seven slots, the column drops recent tabs and empty slots, never the pinned favourite.
      if (height === 300) {
        expect(heights.get(height)).toBeLessThan(7);
        await expect(page.locator('.favourite-tile.is-pinned')).toBeInViewport({ ratio: 1 });
      }
    }
    expect(heights.get(820)).toBeGreaterThan(heights.get(480)!);
    expect(heights.get(480)).toBeGreaterThan(heights.get(300)!);

    // A tile past the favourites' seven slots pins into the first free one.
    const extra = page.locator('.favourites-grid > .favourite-slot').nth(10).locator('.favourite-tile');
    const url = await extra.getAttribute('data-url');
    await extra.click({ button: 'right' });
    await page.getByRole('menu').getByRole('menuitem', { name: 'Pin' }).click();
    await expect(page.locator(`.favourite-tile.is-pinned[data-url="${url}"]`)).toBeVisible();
    await expect.poll(async () => (await children(worker, fixture.favouritesId)).map((child) => child.url))
      .toContain(url);

    // Wide enough for the lists, the bar keeps to its seven slots and the global bookmarks button.
    await page.setViewportSize({ width: 360, height: 820 });
    await expect(page.locator('.favourites-grid > .favourite-slot')).toHaveCount(8);
  });
});

test('too narrow for the lists, the column never groups by domain and names each tile under its icon', async () => {
  await withSidebar(async (page, worker) => {
    for (let index = 0; index < 3; index += 1) await createTab(worker, PAGE(`more-${index}`));
    await page.mouse.move(50, 815);
    for (const width of [149, 100, 60]) {
      await page.setViewportSize({ width, height: 600 });
      await expect(page.locator('.favourite-tile.is-group'), `${width}px`).toHaveCount(0);
      // The fixture's pages share one site, yet each keeps its own tile.
      await expect(page.locator('.favourite-tile.is-pinned')).toHaveCount(1);
      await expect(recentTile(page, PAGE('one'))).toHaveCount(1);
      await expect(recentTile(page, PAGE('two'))).toHaveCount(1);
      const tiles = await page.locator('.favourites-grid > .favourite-slot:has(.favourite-tile-wrap)').evaluateAll(
        (slots) => slots.map((slot) => {
          const tile = slot.querySelector<HTMLElement>('.favourite-tile')!;
          const title = tile.querySelector<HTMLElement>('.favourite-title')!;
          const icon = tile.querySelector<HTMLElement>('.favicon')!.getBoundingClientRect();
          const text = title.getBoundingClientRect();
          const style = getComputedStyle(title);
          return {
            clipped: style.textOverflow === 'clip' && style.whiteSpace === 'nowrap',
            fillsColumn: Math.abs(tile.getBoundingClientRect().width - slot.parentElement!.clientWidth + 2) <= 1,
            titleUnderIcon: text.height > 0 && text.top >= icon.bottom,
          };
        }),
      );
      expect(tiles.length, `${width}px`).toBeGreaterThan(2);
      for (const tile of tiles) expect(tile, `${width}px`).toEqual({ clipped: true, fillsColumn: true, titleUnderIcon: true });
      // Neighbours in one space join into one block, bridging the gap between them.
      const joined = page.locator('.favourite-slot.joins-previous .favourite-tile.has-space').first();
      await expect(joined).toBeVisible();
      expect(await joined.evaluate((tile) => {
        const above = tile.closest('.favourite-slot')!.previousElementSibling!.querySelector('.favourite-tile')!;
        const bridge = getComputedStyle(tile, '::before');
        return {
          meets: Math.round(tile.getBoundingClientRect().top - Number.parseFloat(bridge.height) - above.getBoundingClientRect().bottom),
          sameSpace: above.getAttribute('data-space-id') === tile.getAttribute('data-space-id'),
        };
      })).toEqual({ meets: 0, sameSpace: true });
      // Hovering names a tile with the browser's own tooltip, not the label below the bar.
      const hovered = recentTile(page, PAGE('one'));
      await hovered.hover();
      await expect(hovered).toHaveAttribute('title', 'one');
      await expect(page.locator('.favourite-tile-wrap .favourite-tile:not([title])')).toHaveCount(0);
      await expect(page.locator('.favourite-hover-label')).toHaveCount(0);
      await page.screenshot({ path: `logs/narrow-tiles-${width}.png` });
      await page.mouse.move(50, 815);
    }

    // Wide enough for the lists, grouping comes back.
    await page.setViewportSize({ width: 360, height: 820 });
    await expect(page.locator('.favourite-tile.is-pinned.is-group')).toHaveCount(1);
    await expect(page.locator('.favourite-tile-wrap .favourite-tile[title]')).toHaveCount(0);
  }, { grouped: true });
});

test('new tab pages never take a slot on the bar', async () => {
  await withSidebar(async (page, worker, _fixture, context) => {
    await routePathTitles(context, 'https://other.test/**', 'other ');
    // Opened as Ctrl/Cmd+T opens them, on the browser's new tab page.
    for (let count = 0; count < 2; count += 1) await callChrome(worker, 'tabs.create', {});
    await createTab(worker, 'https://other.test/a');
    const slots = page.locator('.favourites-grid > .favourite-slot');
    await expect(slots.nth(0).locator('.favourite-tile')).toHaveAttribute('data-url', 'https://other.test/a');
    // Neither new tab nor the browser's first, blank tab has a tile; the fixture's pages share the pinned one.
    await expect(page.locator('.favourite-tile-wrap.is-recent')).toHaveCount(1);
  }, { grouped: true });
});

test('grouped by domain, a narrow bar keeps to one row of as many tiles as fit', async () => {
  await withSidebar(async (page, worker, _fixture, context) => {
    const sites = ['a', 'b', 'c', 'd', 'e'];
    for (const site of sites) {
      await routePathTitles(context, `https://${site}.test/**`, `${site} `);
      await createTab(worker, `https://${site}.test/page`);
    }
    const slots = page.locator('.favourites-grid > .favourite-slot');
    const rows = async () => new Set(await Promise.all((await slots.all()).map(async (slot) =>
      Math.round((await slot.boundingBox())!.y)))).size;

    // 228px of grid fits six 28px columns: five tiles and the global bookmarks button.
    await page.setViewportSize({ width: 250, height: 820 });
    await expect(slots).toHaveCount(6);
    expect(await rows()).toBe(1);
    await expect(page.locator('.favourite-tile.is-pinned')).toBeVisible();
    // The most recent sites keep their tiles; the oldest gives its up.
    await expect(page.locator('.favourite-tile.is-recent[data-url="https://e.test/page"]')).toBeVisible();
    await expect(page.locator('.favourite-tile.is-recent[data-url="https://a.test/page"]')).toHaveCount(0);
    await expect(slots.nth(5).getByRole('button', { name: 'Global bookmarks' })).toBeVisible();

    // Wide enough for one row of eight, the bar shows all seven slots again.
    await page.setViewportSize({ width: 360, height: 820 });
    await expect(slots).toHaveCount(8);
    expect(await rows()).toBe(1);
  }, { grouped: true });
});

test('grouping off, the bar keeps to one row, adding slots for recent tabs where wide', async () => {
  await withSidebar(async (page, worker, _fixture, context) => {
    const sites = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];
    for (const site of sites) {
      await routePathTitles(context, `https://${site}.test/**`, `${site} `);
      await createTab(worker, `https://${site}.test/page`);
    }
    const slots = page.locator('.favourites-grid > .favourite-slot');
    const rows = async () => new Set(await Promise.all((await slots.all()).map(async (slot) =>
      Math.round((await slot.boundingBox())!.y)))).size;
    const tileSize = async () => Math.round((await slots.first().boundingBox())!.width);
    // The columns divide the row evenly, leaving no space at its ends.
    const fillsRow = () => page.locator('.favourites-grid').evaluate((grid) => {
      const style = getComputedStyle(grid);
      const inner = grid.getBoundingClientRect();
      const cells = [...grid.children].map((cell) => cell.getBoundingClientRect());
      return Math.round(cells[0]!.left - inner.left - Number.parseFloat(style.paddingLeft)) === 0 &&
        Math.round(inner.right - Number.parseFloat(style.paddingRight) - cells.at(-1)!.right) === 0;
    });

    for (const [width, count] of [[250, 6], [360, 8], [500, 11]] as const) {
      await page.setViewportSize({ width, height: 820 });
      await expect(slots, `${width}px slots`).toHaveCount(count);
      expect(await rows(), `${width}px rows`).toBe(1);
      await expect(slots.last().getByRole('button', { name: 'Global bookmarks' })).toBeVisible();
      expect(await tileSize(), `${width}px tile size`).toBeGreaterThanOrEqual(width > 350 ? 34 : 28);
      expect(await fillsRow(), `${width}px tiles fill the row`).toBe(true);
      await page.screenshot({ path: `logs/favourites-row-${width}.png` });
    }

    // With too few tabs to fill them, the extra slots show empty and take no drop.
    for (const site of sites.slice(3)) await recentTile(page, `https://${site}.test/page`).click({ button: 'middle' });
    await page.setViewportSize({ width: 600, height: 820 });
    await expect(slots).toHaveCount(14);
    expect(await rows()).toBe(1);
    expect(await fillsRow()).toBe(true);
    await expect(page.getByLabel('Empty recent tab slot 12')).toBeVisible();
    await page.screenshot({ path: 'logs/favourites-row-600-empty.png' });
  });
});

test('the header shows one timed message at a time: an unpin offers undo, and a report offers copy', async () => {
  await withSidebar(async (page, worker, fixture) => {
    // Playwright cannot grant clipboard access to an extension origin, so record what is written.
    await page.evaluate(() => {
      const copied = window as unknown as { copiedText?: string };
      navigator.clipboard.writeText = async (text: string) => { copied.copiedText = text; };
    });
    const notices = page.locator('.topbar .countdown-notice');
    const pinned = page.locator(`.favourite-tile.is-pinned[data-url="${PAGE('pinned')}"]`);
    await pinned.click({ button: 'middle' });
    await expect.poll(async () => (await children(worker, fixture.favouritesId)).length).toBe(0);
    await expect(notices).toHaveCount(1);
    await expect(notices.getByRole('status')).toHaveText('Item unpinned');
    // The message takes the header from the space title, Settings and Search.
    await expect(page.getByRole('button', { name: 'Open settings' })).toBeHidden();
    const undo = notices.getByRole('button', { name: 'Undo' });
    await expect(undo.locator('svg.lucide-undo-2')).toBeVisible();
    await undo.click();
    await expect(pinned).toHaveCount(1);
    await expect.poll(async () => (await children(worker, fixture.favouritesId)).map((child) => child.url))
      .toEqual([PAGE('pinned')]);
    await expect(notices).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Open settings' })).toBeVisible();

    // A newer message replaces the one showing rather than stacking under it.
    await pinned.click({ button: 'middle' });
    await expect(notices.getByRole('status')).toHaveText('Item unpinned');
    await recentTile(page, PAGE('one')).click({ button: 'right' });
    await page.getByRole('menu').getByRole('menuitem', { name: 'Copy' }).click();
    await expect(notices).toHaveCount(1);
    await expect(notices.getByRole('status')).toHaveText('Copied “one”');
    const copy = notices.getByRole('button', { name: 'Copy this message' });
    await expect(copy.locator('svg.lucide-copy')).toBeVisible();
    await copy.click();
    await expect(notices.getByRole('button', { name: 'Copied' })).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { copiedText?: string }).copiedText)).toBe('Copied “one”');
    // A report lasts long enough to read, then goes.
    // Messages last 7s by default (Settings > System > Message timing).
    await expect(notices).toHaveCount(0, { timeout: 10_000 });
    // The unpin it replaced is gone for good.
    expect(await children(worker, fixture.favouritesId)).toEqual([]);
  });
});


const groupTile = (page: Page, domain: string) => page.locator(`.favourite-tile.is-group[data-group-domain="${domain}"]`);
const groupRows = (page: Page) => page.locator('.favourite-group-list .favourite-group-row');
const rowUrls = (page: Page) => groupRows(page).evaluateAll((rows) => rows.map((row) => row.getAttribute('data-url')));

test('grouped by domain, a site\'s favourite and tabs share one tile that lists them on hover, most recent first', async () => {
  await withSidebar(async (page, worker) => {
    // Grouping is on by default, and its switch turns it off and on again.
    await page.getByRole('button', { name: 'Open settings' }).click();
    const setting = page.getByRole('switch', { name: /Group tiles by domain/ });
    await expect(setting).toHaveAttribute('aria-checked', 'true');
    await setting.click();
    await expect(setting).toHaveAttribute('aria-checked', 'false');
    await page.getByRole('button', { name: 'Back' }).click();
    await expect(page.locator('.favourite-tile.is-group')).toHaveCount(0);
    await expect(recentTile(page, PAGE('one'))).toBeVisible();
    await page.getByRole('button', { name: 'Open settings' }).click();
    await setting.click();
    await expect(setting).toHaveAttribute('aria-checked', 'true');
    await page.getByRole('button', { name: 'Back' }).click();
    const slots = page.locator('.favourites-grid > .favourite-slot');
    const tile = groupTile(page, 'favourites.test');
    await expect(slots.nth(1).locator('.favourite-tile')).toHaveClass(/is-group/);
    await expect(tile).toHaveClass(/is-pinned/);
    await expect(tile).toHaveAttribute('aria-label', 'favourites.test, 3 items, grouped, pinned');
    await expect(page.locator('.favourite-tile.is-recent[data-url^="https://favourites.test/"]')).toHaveCount(0);

    await tile.hover();
    const list = page.locator('.favourite-group-list');
    await expect(list.locator('.favourite-group-heading')).toHaveText('favourites.test');
    await expect(page.locator('.favourite-hover-label')).toHaveCount(0);
    await expect.poll(() => rowUrls(page)).toEqual([PAGE('two'), PAGE('one'), PAGE('pinned')]);
    await expect(groupRows(page).nth(2)).toHaveClass(/is-pinned/);

    // Moving down into the list keeps it open.
    await groupRows(page).nth(1).hover();
    await groupRows(page).nth(1).locator('.favourite-group-row-main').click();
    await expect.poll(() => activeTabUrl(worker)).toBe(PAGE('one'));
    await expect(list).toHaveCount(0);

    // Clicking the tile toggles its list rather than opening a tab, and the list then outlasts the hover.
    await page.mouse.move(5, 700);
    await tile.click();
    await expect(list).toBeVisible();
    await page.mouse.move(5, 700);
    await expect(list).toBeVisible();
    await expect.poll(() => rowUrls(page)).toEqual([PAGE('one'), PAGE('two'), PAGE('pinned')]);
    await tile.click();
    await expect(list).toHaveCount(0);
    await expect.poll(() => activeTabUrl(worker)).toBe(PAGE('one'));
  }, { grouped: true });
});

test('a grouped tile\'s list works from the keyboard', async () => {
  await withSidebar(async (page, worker) => {
    const tile = groupTile(page, 'favourites.test');
    const list = page.locator('.favourite-group-list');
    const focusedRowUrl = () => page.evaluate(() => document.activeElement?.closest('.favourite-group-row')?.getAttribute('data-url'));
    await page.mouse.move(5, 700);
    await page.keyboard.press('Shift');
    await tile.focus();
    await expect(list).toBeVisible();
    await expect(tile).toHaveAttribute('aria-expanded', 'true');

    await page.keyboard.press('ArrowDown');
    await expect.poll(focusedRowUrl).toBe(PAGE('two'));
    await page.keyboard.press('ArrowDown');
    await expect.poll(focusedRowUrl).toBe(PAGE('one'));
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowUp');
    await expect.poll(focusedRowUrl).toBe(PAGE('pinned'));
    await page.keyboard.press('Escape');
    await expect(list).toHaveCount(0);
    await expect(tile).toBeFocused();

    await page.keyboard.press('ArrowUp');
    await expect.poll(focusedRowUrl).toBe(PAGE('pinned'));
    await page.keyboard.press('Home');
    await expect.poll(focusedRowUrl).toBe(PAGE('two'));
    await page.keyboard.press('Delete');
    await expect.poll(() => openTabUrls(worker)).not.toContain(PAGE('two'));
    await expect.poll(() => rowUrls(page)).toEqual([PAGE('one'), PAGE('pinned')]);
    await expect.poll(focusedRowUrl).toBe(PAGE('one'));

    await page.keyboard.press('Enter');
    await expect.poll(() => activeTabUrl(worker)).toBe(PAGE('one'));
    await expect(list).toHaveCount(0);
    await expect(tile).toBeFocused();

    // Closing all but one entry turns the tile back into a plain one and keeps focus on it.
    await page.keyboard.press('ArrowDown');
    await expect.poll(focusedRowUrl).toBe(PAGE('one'));
    await page.keyboard.press('Delete');
    await expect.poll(() => openTabUrls(worker)).not.toContain(PAGE('one'));
    await expect(list).toHaveCount(0);
    await expect(page.locator(`.favourite-tile.is-pinned[data-url="${PAGE('pinned')}"]`)).not.toHaveClass(/is-group/);
    await expect(page.locator(`.favourite-tile.is-pinned[data-url="${PAGE('pinned')}"]`)).toBeFocused();
  }, { grouped: true });
});

test('grouped by domain, a site\'s tabs share a recent tile whose rows close, and one left becomes a plain tile', async () => {
  await withSidebar(async (page, worker, _fixture, context) => {
    await routePathTitles(context, 'https://other.test/**', 'other ');
    for (const name of ['a', 'b']) await (await context.newPage()).goto(`https://other.test/${name}`);
    const tile = groupTile(page, 'other.test');
    await expect(tile).toHaveClass(/is-recent/);
    await expect(page.locator('.favourite-tile.is-group')).toHaveCount(2);

    await tile.hover();
    await expect.poll(() => rowUrls(page)).toEqual(['https://other.test/b', 'https://other.test/a']);
    // Middle-click closes a row's tab, as the close button does.
    await groupRows(page).first().click({ button: 'middle' });
    await expect.poll(() => openTabUrls(worker)).not.toContain('https://other.test/b');
    await expect(tile).toHaveCount(0);
    await expect(recentTile(page, 'https://other.test/a')).not.toHaveClass(/is-group/);

    await groupTile(page, 'favourites.test').hover();
    const row = groupRows(page).first();
    // A title reaches the row's end, and gives way to the close button only while it shows.
    const titleRoom = () => row.locator('.favourite-group-row-main').evaluate((main) => getComputedStyle(main).paddingRight);
    await expect.poll(titleRoom).toBe('8px');
    await row.hover();
    await expect.poll(titleRoom).toBe('30px');
    await row.locator('.favourite-group-row-close').click();
    await expect.poll(() => openTabUrls(worker)).not.toContain(PAGE('two'));
    await expect.poll(() => rowUrls(page)).toEqual([PAGE('one'), PAGE('pinned')]);

    await groupRows(page).first().click({ button: 'right' });
    await expect(page.getByRole('menu').getByRole('menuitem', { name: 'Pin' })).toBeVisible();
    await page.keyboard.press('Escape');
  }, { grouped: true });
});

test('grouped by domain, favourites on one site merge, and middle-click unpins them all as one choice', async () => {
  await withSidebar(async (page, worker, fixture) => {
    const pinnedUrls = async () => (await children(worker, fixture.favouritesId)).map((child) => child.url).sort();
    const tile = groupTile(page, 'favourites.test');
    await tile.hover();
    await groupRows(page).filter({ hasText: 'one' }).click({ button: 'right' });
    await page.getByRole('menu').getByRole('menuitem', { name: 'Pin' }).click();
    await expect.poll(pinnedUrls).toEqual([PAGE('one'), PAGE('pinned')]);

    await expect(tile).toHaveCount(1);
    // A row pins into the first free slot, left of the other favourite, and the merged tile moves there.
    await expect(page.locator('.favourites-grid > .favourite-slot').nth(0).locator('.favourite-tile')).toHaveAttribute('data-group-domain', 'favourites.test');
    await page.mouse.move(5, 700);
    await tile.hover();
    await expect(groupRows(page).filter({ has: page.locator('.favourite-group-row-pin') })).toHaveCount(2);

    await tile.click({ button: 'middle' });
    await expect.poll(pinnedUrls).toEqual([]);
    await expect(page.locator('.topbar .countdown-notice').getByRole('status')).toHaveText('Unpinned 2 items');
    await expect(groupTile(page, 'favourites.test')).toHaveClass(/is-recent/);
    expect(await openTabUrls(worker)).toEqual(expect.arrayContaining([PAGE('one'), PAGE('two')]));
  }, { grouped: true });
});
