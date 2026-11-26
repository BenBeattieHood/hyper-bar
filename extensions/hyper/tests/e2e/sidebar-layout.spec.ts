import { expect, test, type Frame, type Page, type Worker } from '@playwright/test';
import { saveHyperPreference } from './fixtures/preferences';
import { extensionBaseUrl, routeHtml, withExtension } from './helpers/extension';
import type { ExtensionGlobal } from './helpers/extensionGlobal';

const spaceTitles = ['Research', 'Errands and admin', 'Weekend', 'Reading'];

/** Runs `run` on the browser's first page, once the profile is populated. */
async function withLayout(
  name: string,
  run: (layout: { extensionOrigin: string; page: Page; worker: Worker }) => Promise<void>,
): Promise<void> {
  test.setTimeout(60_000);
  await withExtension(name, async ({ context, worker }) => {
    await routeHtml(
      context,
      'https://layout.test/**',
      '<!doctype html><title>Layout</title><main style="height:2000px">Page text</main>',
    );
    await populate(worker);
    const page = context.pages()[0] ?? await context.newPage();
    await run({ extensionOrigin: extensionBaseUrl(worker), page, worker });
  });
}

/** Enough spaces to fill the spaces bar, and enough bookmarks and tabs to overflow both lists. */
async function populate(worker: Worker): Promise<void> {
  await worker.evaluate(async (titles) => {
    type Node = { children?: Node[]; id: string; title: string; url?: string };
    const extension = globalThis as unknown as ExtensionGlobal;
    const visible = (node: Node) => node.title.replace(/\s+\{.*$/, '');
    // Build on the structure the background repairs rather than racing it.
    let spaces: Node | undefined;
    let bookmarks: Node | undefined;
    for (let attempt = 0; attempt < 100 && !bookmarks; attempt += 1) {
      const bar = (await extension.chrome.bookmarks.getTree())[0]?.children?.[0];
      spaces = bar?.children?.find((node) => visible(node) === 'hyper')
        ?.children?.find((node) => visible(node) === 'spaces');
      bookmarks = spaces?.children?.find((node) => !node.url)
        ?.children?.find((node) => node.title.startsWith('bookmarks {'));
      if (!bookmarks) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!spaces || !bookmarks) throw new Error('Hyper did not repair its bookmark structure');
    for (const title of titles) await extension.chrome.bookmarks.create({ parentId: spaces.id, title });
    for (let index = 0; index < 20; index += 1) {
      await extension.chrome.bookmarks.create({
        parentId: bookmarks.id,
        title: `Bookmark ${index}`,
        url: `https://layout.test/bookmark/${index}`,
      });
    }
    for (let index = 0; index < 30; index += 1) {
      await extension.chrome.tabs.create({ active: false, url: `https://layout.test/tab/${index}` });
    }
  }, spaceTitles);
}

// Hyper routes each new tab into its space in turn, so the last of thirty can
// take several seconds to appear while other browsers share the machine.
async function expectPopulated(sidebar: Page | Frame): Promise<void> {
  await expect(sidebar.locator('.space-pagination-dot')).toHaveCount(spaceTitles.length + 1);
  await expect(sidebar.locator('.tab-main[data-url="https://layout.test/tab/29"]').first())
    .toBeAttached({ timeout: 20_000 });
}

/** The spaces bar sits whole at the foot of the sidebar, with every space and the add button showing. */
async function expectSpacesBarOnScreen(sidebar: Page | Frame, page: Page, layout: string): Promise<void> {
  const viewport = page.viewportSize();
  if (!viewport) throw new Error('The page has no viewport.');
  const bar = sidebar.locator('.space-pagination');
  await expect(bar, layout).toBeInViewport({ ratio: 1 });
  await expect.poll(async () => {
    const box = await bar.boundingBox();
    return box && Math.round(box.y + box.height);
  }, { message: `${layout}: the spaces bar ends at the foot of the viewport` }).toBe(viewport.height);
  for (const control of await sidebar.locator('.space-pagination-dot, .add-space-button').all()) {
    await expect(control, layout).toBeInViewport({ ratio: 1 });
  }
  expect(
    await sidebar.evaluate(() => document.documentElement.scrollHeight - window.innerHeight),
    `${layout}: the sidebar does not overflow its viewport`,
  ).toBeLessThanOrEqual(0);
}

test('the spaces bar sits whole at the foot of the side panel at every size', async () => {
  await withLayout('layout-panel', async ({ extensionOrigin, page, worker }) => {
    await page.setViewportSize({ width: 360, height: 900 });
    await page.goto(`${extensionOrigin}/sidepanel.html`);
    await expectSpacesBarOnScreen(page, page, 'on opening');
    await expectPopulated(page);

    for (const combined of [true, false]) {
      await saveHyperPreference(worker, 'combineTabsAndBookmarks', combined);
      await page.setViewportSize({ width: 360, height: 900 });
      await expect(combined
        ? page.locator('.workspace-panel-splitter')
        : page.getByRole('tab', { name: 'Bookmarks' })).toBeVisible();
      for (const [width, height] of [[360, 900], [360, 480], [719, 900], [720, 900], [900, 600]] as const) {
        await page.setViewportSize({ width, height });
        await expectSpacesBarOnScreen(page, page, `${combined ? 'combined' : 'separate'} ${width}x${height}`);
      }
    }
  });
});

test('the spaces bar sits whole at the foot of the in-page sidebar', async () => {
  await withLayout('layout-in-page', async ({ extensionOrigin, page, worker }) => {
    await page.setViewportSize({ width: 1000, height: 700 });
    await page.goto('https://layout.test/');
    await saveHyperPreference(worker, 'inPageSidebar', true);
    const host = page.locator('#hyper-in-page-sidebar-host');
    await expect(host).toHaveCount(1);

    const mark = { x: 14 + 19, y: 700 - 12 - 19 };
    await page.mouse.move(mark.x, mark.y);
    await expect(host).toHaveAttribute('data-hover', 'true');
    const sidebarFrame = () => page.frames()
      .find((frame) => frame.url().startsWith(`${extensionOrigin}/inpage.html?token=`));
    await expect.poll(() => sidebarFrame() !== undefined).toBe(true);
    await page.mouse.click(mark.x, mark.y);
    await expect(host).toHaveAttribute('data-open', 'true');
    const sidebar = sidebarFrame()!;
    await expectSpacesBarOnScreen(sidebar, page, 'on opening');
    await expectPopulated(sidebar);

    for (const [width, height] of [[1000, 480], [700, 900]] as const) {
      await page.setViewportSize({ width, height });
      await expectSpacesBarOnScreen(sidebar, page, `in page ${width}x${height}`);
    }
    await expect(host).toHaveAttribute('data-open', 'true');
  });
});

test('narrow side panels stack the favourites, flatten folders and keep only favourites and spaces', async () => {
  await withLayout('layout-narrow', async ({ extensionOrigin, page, worker }) => {
    // Every page is on one site; grouped, the bar would show fewer tiles than fit.
    await saveHyperPreference(worker, 'groupFavouritesByDomain', false);
    await page.setViewportSize({ width: 360, height: 900 });
    await page.goto(`${extensionOrigin}/sidepanel.html`);
    await expectPopulated(page);

    const grid = page.locator('.favourites-grid');
    const columns = () => grid.evaluate((element) =>
      getComputedStyle(element).gridTemplateColumns.split(' ').length);
    const indent = () => page.locator('.tab-row').first().evaluate((element) =>
      getComputedStyle(element).getPropertyValue('--tree-indent').trim());
    const globalBookmarks = page.getByRole('button', { name: 'Global bookmarks' });
    const treeSection = page.locator('.tree-section');

    // While the lists show, the bar is one row of as many 28px or wider columns as fit, up to eight.
    for (const [width, expected] of [
      [290, { columns: 8, indent: '16px', lists: true }],
      [289, { columns: 8, indent: '16px', lists: true }],
      [270, { columns: 7, indent: '16px', lists: true }],
      [240, { columns: 6, indent: '16px', lists: true }],
      [239, { columns: 6, indent: '0px', lists: true }],
      [150, { columns: 3, indent: '0px', lists: true }],
      [149, { columns: 1, indent: '0px', lists: false }],
      [100, { columns: 1, indent: '0px', lists: false }],
      [99, { columns: 1, indent: '0px', lists: false }],
      [60, { columns: 1, indent: '0px', lists: false }],
      [38, { columns: 1, indent: '0px', lists: false }],
    ] as const) {
      await page.setViewportSize({ width, height: 900 });
      await expect.poll(columns, { message: `${width}px favourites columns` }).toBe(expected.columns);
      // Too narrow for the lists, recent tabs fill the column instead.
      if (expected.lists) {
        const slots = page.locator('.favourites-grid > .favourite-slot');
        await expect(slots).toHaveCount(expected.columns);
        const rows = new Set(await Promise.all((await slots.all()).map(async (slot) => Math.round((await slot.boundingBox())!.y))));
        expect(rows.size, `${width}px favourites share one row`).toBe(1);
      }
      await page.screenshot({ path: `logs/narrow-layout-${width}.png` });
      if (expected.lists) {
        await expect.poll(indent, { message: `${width}px folder indent` }).toBe(expected.indent);
        await expect(globalBookmarks, `${width}px global bookmarks`).toBeVisible();
        await expect(treeSection, `${width}px lists`).toBeVisible();
        await expect(page.locator('.workspace-view-toolbar').first(), `${width}px header tabs`).toBeVisible();
      } else {
        await expect(globalBookmarks, `${width}px global bookmarks`).toBeHidden();
        await expect(treeSection, `${width}px lists`).toBeHidden();
        await expect(page.locator('.workspace-view-toolbar').first(), `${width}px header tabs`).toBeHidden();
        await expect(page.locator('.space-pagination'), `${width}px spaces bar`).toBeInViewport({ ratio: 1 });
        await expect.poll(async () => {
          const box = await page.locator('.space-pagination').boundingBox();
          return box && Math.round(box.y + box.height);
        }, { message: `${width}px spaces bar sits at the foot` }).toBe(900);
        // Dots too many for the bar stay on one row, clipped, with the active space's dot in view.
        const dotRows = new Set(await Promise.all((await page.locator('.space-pagination-dot').all())
          .map(async (dot) => Math.round((await dot.boundingBox())!.y))));
        expect(dotRows.size, `${width}px spaces bar dots share one row`).toBe(1);
        await expect(page.locator('.space-pagination-dot.is-active'), `${width}px active space`).toBeInViewport({ ratio: 1 });
        // The space's title keeps one compact size at every width without the lists.
        const title = await page.locator('.topbar-space-title .space-title-input').evaluate((input) => ({
          fontSize: getComputedStyle(input).fontSize,
          height: input.getBoundingClientRect().height,
          top: input.getBoundingClientRect().top,
        }));
        expect(title, `${width}px space title`).toEqual({ fontSize: '12px', height: 30, top: 2 });
        const slots = await page.locator('.favourites-grid > .favourite-slot:not(.global-bookmarks-slot)').all();
        const xs = new Set(await Promise.all(slots.map(async (slot) => Math.round((await slot.boundingBox())!.x))));
        expect(xs.size, `${width}px favourites share one column`).toBe(1);
      }
    }

    const search = page.getByRole('button', { name: 'Search tabs and history' });
    const settings = page.getByRole('button', { name: 'Open settings' });
    for (const [width, expected] of [
      [225, { search: true, settings: true }],
      [224, { search: false, settings: true }],
      [190, { search: false, settings: true }],
      [189, { search: false, settings: false }],
    ] as const) {
      await page.setViewportSize({ width, height: 900 });
      await expect(search, `${width}px search button`).toBeVisible({ visible: expected.search });
      await expect(settings, `${width}px settings button`).toBeVisible({ visible: expected.settings });
    }

    await page.keyboard.press('ControlOrMeta+K');
    await expect(page.getByRole('combobox', { name: /Search tabs, bookmarks/ })).toBeFocused();

    // Narrowing past a hidden button closes what it opened.
    const searchInput = page.getByRole('combobox', { name: /Search tabs, bookmarks/ });
    const settingsPage = page.locator('.settings-page');
    await page.keyboard.press('Escape');
    await expect(searchInput).toBeHidden();
    await page.setViewportSize({ width: 360, height: 900 });
    await search.click();
    await expect(searchInput).toBeVisible();
    await page.setViewportSize({ width: 224, height: 900 });
    await expect(searchInput).toBeHidden();

    await page.setViewportSize({ width: 360, height: 900 });
    await settings.click();
    await expect(settingsPage).toBeVisible();
    await page.setViewportSize({ width: 224, height: 900 });
    await expect(settingsPage).toBeVisible();
    await page.setViewportSize({ width: 189, height: 900 });
    await expect(settingsPage).toBeHidden();
  });
});
