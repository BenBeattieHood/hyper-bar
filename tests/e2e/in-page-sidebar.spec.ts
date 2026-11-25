import { expect, test, type Frame, type Page } from '@playwright/test';
import { readHyperPreferences, saveHyperPreference } from './fixtures/preferences';
import { callChrome } from './helpers/chrome';
import { extensionBaseUrl, type ExtensionSession, routeHtml, withExtension } from './helpers/extension';
import { navigateTab, waitForNewPage } from './helpers/tabs';

const hostSelector = '#hyper-in-page-sidebar-host';

async function markPoint(page: Page) {
  const viewport = page.viewportSize();
  if (!viewport) throw new Error('The page has no viewport.');
  return { x: 14 + 19, y: viewport.height - 12 - 19 };
}

const plainPage = '<title>In-page test</title><main style="height:2000px">Page text</main>';

/** A fresh browser whose https://inpage.test pages answer with `body`. */
function withInPage(
  name: string,
  body: string | ((requested: URL, extensionOrigin: string) => string),
  run: (session: ExtensionSession & { extensionOrigin: string }) => Promise<void>,
) {
  test.setTimeout(60_000);
  return withExtension(name, async (session) => {
    const extensionOrigin = extensionBaseUrl(session.worker);
    await routeHtml(session.context, 'https://inpage.test/**', typeof body === 'string'
      ? body
      : (requested) => body(requested, extensionOrigin));
    await run({ ...session, extensionOrigin });
  });
}

test('shows the sidebar inside pages while the browser sidebar is closed', async () => {
  await withInPage('in-page-sidebar', ({ pathname }, extensionOrigin) => pathname === '/framed'
    ? `<title>Framed</title><iframe src="${extensionOrigin}/inpage.html" style="width:360px;height:400px"></iframe>`
    : pathname === '/other'
      ? '<title>Other page</title>'
      : '<title>In-page test</title><style>div { padding: 0; position: static; } body { background: linear-gradient(135deg, #f0c27b, #4b1248); }</style><main style="height:2000px;font:20px sans-serif">Page text that the frosted strip should blur when the mark is hovered.</main>',
  async ({ context, extensionOrigin, worker }) => {
    const page = context.pages()[0] ?? await context.newPage();
    await page.setViewportSize({ width: 1000, height: 700 });
    await page.goto('https://inpage.test/');
    await page.waitForTimeout(500);
    await expect(page.locator(hostSelector)).toHaveCount(0);

    await saveHyperPreference(worker, 'inPageSidebar', true);
    const host = page.locator(hostSelector);
    await expect(host).toHaveCount(1);

    const mark = await markPoint(page);
    const sidebarFrame = () => page.frames()
      .find((frame) => frame.url().startsWith(`${extensionOrigin}/inpage.html?token=`));
    await page.mouse.move(mark.x, mark.y);
    await expect(host).toHaveAttribute('data-hover', 'true');
    // Hovering loads the sidebar out of sight, so the click only has to slide it in.
    await expect.poll(() => sidebarFrame() !== undefined).toBe(true);
    await expect(sidebarFrame()!.locator('.space-pagination-dot')).toHaveCount(1);
    await expect(host).toHaveAttribute('data-open', 'false');
    await page.mouse.click(mark.x, mark.y);
    await expect(host).toHaveAttribute('data-open', 'true');
    const sidebar = sidebarFrame();
    await expect(sidebar!.locator('.space-pagination-dot')).toHaveCount(1);
    // Playwright routes a tab only once it has attached to it, which is after the
    // first load of a tab the extension opens at a URL. The tab starts blank so
    // its page comes from the route rather than the network.
    let otherTabId: number | undefined;
    await waitForNewPage(context, async () => {
      otherTabId = (await callChrome<{ id?: number }>(worker, 'tabs.create', { active: false, url: 'about:blank' })).id;
    });
    await navigateTab(worker, otherTabId!, 'https://inpage.test/other');
    await expect(sidebar!.locator('.tab-row', { hasText: 'Other page' })).toBeVisible();

    await page.mouse.click(700, 300);
    await page.waitForTimeout(250);
    await expect(host).toHaveAttribute('data-open', 'true');
    await expect(host).toHaveAttribute('data-open', 'false', { timeout: 2_000 });
    expect(sidebarFrame()).toBeDefined();

    // A page can wake a stopped worker, which starts on the seed model: it must
    // still answer from the stored setting rather than withdraw the mark.
    await page.reload();
    await expect(host).toHaveCount(1);
    const cdp = await context.newCDPSession(page);
    await cdp.send('ServiceWorker.enable');
    await cdp.send('ServiceWorker.stopAllWorkers');
    await page.mouse.move(mark.x, mark.y);
    await page.mouse.click(mark.x, mark.y);
    await expect(host).toHaveAttribute('data-open', 'true');
    await expect.poll(() => sidebarFrame() !== undefined).toBe(true);
    await expect(sidebarFrame()!.locator('.space-pagination-dot')).toHaveCount(1);
    await page.mouse.click(700, 300);
    await expect(host).toHaveAttribute('data-open', 'false', { timeout: 2_000 });

    const nativeSidebar = await context.newPage();
    await nativeSidebar.goto(`${extensionOrigin}/sidepanel.html`);
    await page.bringToFront();
    await expect(host).toHaveCount(0);
    await nativeSidebar.close();
    await expect(host).toHaveCount(1, { timeout: 5_000 });

    await page.goto('https://inpage.test/framed');
    const framed = page.frames().find((frame) => frame.url() === `${extensionOrigin}/inpage.html`);
    expect(framed).toBeDefined();
    await page.waitForTimeout(1_500);
    await expect(framed!.locator('.tab-row')).toHaveCount(0);
  });
});

test('resizes from its edge and keeps the width on the hyper folder', async () => {
  await withInPage('in-page-resize', plainPage, async ({ context, extensionOrigin, worker }) => {
    const openSidebar = async (page: Page): Promise<Frame> => {
      await page.setViewportSize({ width: 1000, height: 700 });
      await expect(page.locator(hostSelector)).toHaveCount(1);
      const mark = await markPoint(page);
      await page.mouse.move(mark.x, mark.y);
      await page.mouse.click(mark.x, mark.y);
      await expect(page.locator(hostSelector)).toHaveAttribute('data-open', 'true');
      let frame: Frame | undefined;
      await expect.poll(() => {
        frame = page.frames().find((candidate) =>
          candidate.url().startsWith(`${extensionOrigin}/inpage.html?token=`));
        return frame !== undefined;
      }).toBe(true);
      return frame!;
    };
    // The shadow root is closed, so the frame element is measured through the frame itself.
    const frameBox = async (frame: Frame) => {
      const box = await (await frame.frameElement()).boundingBox();
      return box && { width: Math.round(box.width), x: Math.round(box.x) };
    };

    const page = context.pages()[0] ?? await context.newPage();
    await page.goto('https://inpage.test/');
    await saveHyperPreference(worker, 'inPageSidebar', true);
    const sidebar = await openSidebar(page);
    await expect.poll(() => frameBox(sidebar)).toEqual({ width: 360, x: 0 });

    // The edge straddles the panel's right side.
    await page.mouse.move(360, 350);
    await page.mouse.down();
    await page.mouse.move(420, 350, { steps: 4 });
    await page.mouse.move(480, 350, { steps: 4 });
    await page.mouse.up();
    await expect.poll(() => frameBox(sidebar)).toEqual({ width: 480, x: 0 });
    await expect(page.locator(hostSelector)).toHaveAttribute('data-open', 'true');
    await expect.poll(async () => (await readHyperPreferences(worker)).inPageSidebarWidth)
      .toBe(480);

    const other = await context.newPage();
    await other.goto('https://inpage.test/other');
    const otherSidebar = await openSidebar(other);
    await expect.poll(() => frameBox(otherSidebar)).toEqual({ width: 480, x: 0 });
  });
});

test('a right-click slides the mark a quarter of the way up the page, and another slides it back', async () => {
  await withInPage('in-page-mark', plainPage, async ({ context, worker }) => {
    const page = context.pages()[0] ?? await context.newPage();
    await page.setViewportSize({ width: 1000, height: 700 });
    await page.goto('https://inpage.test/');
    await saveHyperPreference(worker, 'inPageSidebar', true);
    const host = page.locator(hostSelector);
    await expect(host).toHaveCount(1);
    await page.evaluate(() => {
      const scope = globalThis as unknown as { menus: boolean[] };
      scope.menus = [];
      window.addEventListener('contextmenu', (event) => scope.menus.push(event.defaultPrevented));
    });
    const menusPrevented = () => page.evaluate(() => (globalThis as unknown as { menus: boolean[] }).menus);
    // The shadow root is closed, so the mark is found by where hovering it takes.
    const markAt = async (point: { x: number; y: number }) => {
      await page.mouse.move(700, 300);
      await page.mouse.move(point.x, point.y);
      return host.getAttribute('data-hover');
    };
    const corner = await markPoint(page);
    const raised = { x: corner.x, y: corner.y - 700 / 4 };

    await page.mouse.move(corner.x, corner.y);
    await page.mouse.click(corner.x, corner.y, { button: 'right' });
    await expect(host).toHaveAttribute('data-raised', 'true');
    expect(await menusPrevented()).toEqual([true]);
    await expect.poll(() => markAt(raised)).toBe('true');
    expect(await markAt(corner)).toBe('false');
    await expect(host).toHaveAttribute('data-open', 'false');

    // Raised, it still opens the sidebar.
    await page.mouse.click(raised.x, raised.y);
    await expect(host).toHaveAttribute('data-open', 'true');
    await page.mouse.click(700, 300);
    await expect(host).toHaveAttribute('data-open', 'false', { timeout: 2_000 });

    await page.mouse.click(raised.x, raised.y, { button: 'right' });
    await expect(host).toHaveAttribute('data-raised', 'false');
    expect(await menusPrevented()).toEqual([true, true]);
    await expect.poll(() => markAt(corner)).toBe('true');
    expect(await markAt(raised)).toBe('false');
    await expect(host).toHaveAttribute('data-open', 'false');
  });
});

test('a grouped tile lists its pages below the tile, and on click only in a narrow sidebar', async () => {
  await withInPage('in-page-group-list', ({ pathname }) => `<title>Page ${pathname}</title><main style="height:2000px">Page text</main>`,
    async ({ context, extensionOrigin, worker }) => {
      const page = context.pages()[0] ?? await context.newPage();
      await page.setViewportSize({ width: 1000, height: 700 });
      await page.goto('https://inpage.test/');
      let otherTabId: number | undefined;
      await waitForNewPage(context, async () => {
        otherTabId = (await callChrome<{ id?: number }>(worker, 'tabs.create', { active: false, url: 'about:blank' })).id;
      });
      await navigateTab(worker, otherTabId!, 'https://inpage.test/other');
      await saveHyperPreference(worker, 'inPageSidebar', true);
      await expect(page.locator(hostSelector)).toHaveCount(1);
      const mark = await markPoint(page);
      const frameAt = (path: string) => page.frames().find((frame) => frame.url().startsWith(`${extensionOrigin}/${path}`));
      // Hiding the page drops the frame, so each opening finds it afresh.
      const openSidebar = async () => {
        await page.mouse.move(mark.x, mark.y);
        await page.mouse.click(mark.x, mark.y);
        await expect(page.locator(hostSelector)).toHaveAttribute('data-open', 'true');
        await expect.poll(() => Boolean(frameAt('inpage.html?token='))).toBe(true);
        const frame = frameAt('inpage.html?token=')!;
        await expect(frame.locator('.favourite-tile.is-group[data-group-domain="inpage.test"]')).toBeVisible();
        return frame;
      };
      let sidebar = await openSidebar();
      const tile = () => sidebar.locator('.favourite-tile.is-group[data-group-domain="inpage.test"]');
      const below = () => sidebar.locator('.favourite-group-list.is-tile');
      const box = async (locator: ReturnType<Frame['locator']>) => {
        const found = (await locator.boundingBox())!;
        return { bottom: Math.round(found.y + found.height), x: Math.round(found.x), y: Math.round(found.y) };
      };

      // However wide the page, the list drops from the tile, inside the sidebar.
      await tile().hover();
      await expect(below().locator('.favourite-group-row')).toHaveCount(2);
      const tileBox = await box(tile());
      await expect.poll(async () => Math.abs((await box(below())).y - tileBox.bottom)).toBeLessThanOrEqual(1);
      await page.screenshot({ path: 'test-results/in-page-group-list-below.png' });

      // Its rows open their pages.
      await below().locator('.favourite-group-row', { hasText: 'Page /other' }).locator('.favourite-group-row-main').click();
      await expect.poll(async () => (await callChrome<{ url?: string }[]>(worker, 'tabs.query', { active: true, currentWindow: true }))[0]?.url)
        .toBe('https://inpage.test/other');
      await page.bringToFront();
      sidebar = await openSidebar();

      // Where the bar wraps, hovering only names the tile, and a click opens its list below it.
      await sidebar.locator('.app-shell, body').first().hover({ position: { x: 180, y: 350 } });
      await expect(sidebar.locator('.favourite-group-list')).toHaveCount(0);
      await page.mouse.move(360, 350);
      await page.mouse.down();
      await page.mouse.move(310, 350, { steps: 4 });
      await page.mouse.move(260, 350, { steps: 4 });
      await page.mouse.up();
      await expect.poll(async () => Math.round((await (await sidebar.frameElement()).boundingBox())!.width)).toBe(260);
      await tile().hover();
      await expect(sidebar.locator('.favourite-hover-label')).toHaveText('inpage.test');
      await page.waitForTimeout(400);
      await expect(sidebar.locator('.favourite-group-list')).toHaveCount(0);
      await tile().click();
      await expect(below().locator('.favourite-group-row')).toHaveCount(2);
      const wrappedTile = await box(tile());
      await expect.poll(async () => Math.abs((await box(below())).y - wrappedTile.bottom)).toBeLessThanOrEqual(1);
      await page.screenshot({ path: 'test-results/in-page-group-list-click.png' });
      await tile().click();
      await expect(below()).toHaveCount(0);
    });
});
