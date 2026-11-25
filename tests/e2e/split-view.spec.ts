import { expect, test, type Worker } from '@playwright/test';
import { saveHyperPreference } from './fixtures/preferences';
import { allBookmarks, callChrome } from './helpers/chrome';
import { openSidepanel, routeHtml, withExtension } from './helpers/extension';
import { backedTabRow, liftTabRow, tabUrlSuffixOrder } from './helpers/sidebar';
import { createTab } from './helpers/tabs';

/** The pages each stored split view folder holds, in pane order. */
async function storedSplits(worker: Worker): Promise<string[][]> {
  return (await allBookmarks(worker)).flatMap((node) =>
    !node.url && node.title.includes('"splitView":true')
      ? [(node.children ?? []).map((child) => child.url ?? '')]
      : []);
}

/**
 * This Chromium predates the split view API, so tests stand in for the browser:
 * the fake records each split and reports the split tabs as Chrome would.
 */
async function fakeSplitViewApi(worker: Worker): Promise<void> {
  await worker.evaluate(() => {
    type Tab = { id?: number; splitViewId?: number };
    type Tabs = {
      get: (tabId: number) => Promise<Tab>;
      query: (info?: { splitViewId?: number }) => Promise<Tab[]>;
      [method: string]: unknown;
    };
    const scope = globalThis as unknown as {
      __hyperSplits?: number[][];
      __hyperUnsplits?: number[];
      browser?: { tabs?: Tabs };
      chrome: { tabs: Tabs };
    };
    const splitTabIds = new Set<number>();
    const mark = (tab: Tab) => tab.id !== undefined && splitTabIds.has(tab.id)
      ? { ...tab, splitViewId: 1 }
      : tab;
    scope.__hyperSplits = [];
    scope.__hyperUnsplits = [];
    for (const tabs of new Set([scope.chrome.tabs, scope.browser?.tabs])) {
      if (!tabs) continue;
      const get = tabs.get.bind(tabs);
      const query = tabs.query.bind(tabs);
      tabs.get = async (tabId) => mark(await get(tabId));
      tabs.query = async (info) => info?.splitViewId === undefined
        ? (await query(info)).map(mark)
        : (await query({})).map(mark).filter((tab) => tab.splitViewId === info.splitViewId);
      tabs.createSplit = async (tabIds: number[]) => {
        scope.__hyperSplits?.push(tabIds);
        tabIds.forEach((tabId) => splitTabIds.add(tabId));
        return 1;
      };
      tabs.unsplit = async (splitViewId: number) => {
        scope.__hyperUnsplits?.push(splitViewId);
        splitTabIds.clear();
      };
    }
  });
}

test('a tab dropped on another tab\'s right half joins it in a split view, and leaves when dragged out', async () => {
  await withExtension('split-view', async ({ context, worker }) => {
    await routeHtml(context, 'https://split.test/**', '<!doctype html><title>Split</title>');
    await fakeSplitViewApi(worker);
    const page = await openSidepanel(
      context, worker, { width: 720, height: 900 }, { waitUntil: 'domcontentloaded' },
    );
    const first = await createTab(worker, 'https://split.test/a', { active: false });
    await createTab(worker, 'https://split.test/b', { active: false });
    const third = await createTab(worker, 'https://split.test/c', { active: false });
    const row = (path: string) => backedTabRow(page, `https://split.test/${path}`);
    const order = () => tabUrlSuffixOrder(page, 'https://split.test/');
    await expect.poll(order).toEqual(['a', 'b', 'c']);
    await expect(row('a').locator('xpath=ancestor::li[1]')).toHaveCSS('opacity', '1');

    await liftTabRow(page, row('c'));
    const target = await row('a').boundingBox();
    if (!target) throw new Error('The target row had no geometry');
    await page.mouse.move(
      target.x + target.width * 0.75,
      target.y + target.height / 2,
      { steps: 8 },
    );
    await expect(row('a')).toHaveClass(/drop-split/);
    await expect(row('a').locator('.tab-split-dropzone')).toBeVisible();
    await page.mouse.up();

    await expect.poll(() => worker.evaluate(() =>
      (globalThis as unknown as { __hyperSplits?: number[][] }).__hyperSplits))
      .toEqual([[first, third]]);
    // The browser needs a split's tabs side by side, and the sidebar keeps them together too.
    await expect.poll(async () => {
      const [leftTab, rightTab] = await Promise.all([first, third].map((tabId) =>
        callChrome<{ index: number }>(worker, 'tabs.get', tabId)));
      return rightTab!.index - leftTab!.index;
    }).toBe(1);
    await expect.poll(order).toEqual(['a', 'c', 'b']);
    // The pair is kept in bookmarks as a split view folder, in pane order.
    await expect.poll(() => storedSplits(worker))
      .toEqual([['https://split.test/a', 'https://split.test/c']]);
    const splitRow = page.locator('.tab-split-row');
    await expect(splitRow.locator('.tab-row')).toHaveCount(2);
    await expect.poll(() => splitRow.locator('.tab-main').evaluateAll((mains) =>
      mains.map((main) => main.getAttribute('data-url'))))
      .toEqual(['https://split.test/a', 'https://split.test/c']);

    // A pane dragged out to another row's edge leaves the split for its own row.
    await liftTabRow(page, splitRow.locator('.tab-row').nth(1));
    const below = await row('b').boundingBox();
    if (!below) throw new Error('The row below had no geometry');
    await page.mouse.move(below.x + below.width * 0.25, below.y + below.height - 4, { steps: 8 });
    await expect(row('b')).toHaveClass(/drop-after/);
    await page.mouse.up();

    await expect.poll(() => worker.evaluate(() =>
      (globalThis as unknown as { __hyperUnsplits?: number[] }).__hyperUnsplits))
      .toEqual([1]);
    await expect.poll(order).toEqual(['a', 'b', 'c']);
    await expect(splitRow).toHaveCount(0);
    await expect.poll(() => storedSplits(worker)).toEqual([]);
  }, { closeInitialPage: true });
});

test('with autofolders on, a split view stays in the autofolder of the tab it was dropped on', async () => {
  await withExtension('split-view-autofolders', async ({ context, worker }) => {
    await saveHyperPreference(worker, 'autofolders', true);
    for (const host of ['one.test', 'two.test']) {
      await routeHtml(context, `https://${host}/**`, `<!doctype html><title>${host}</title>`);
    }
    await fakeSplitViewApi(worker);
    const page = await openSidepanel(
      context, worker, { width: 720, height: 900 }, { waitUntil: 'domcontentloaded' },
    );
    const target = await createTab(worker, 'https://one.test/a', { active: false });
    const dragged = await createTab(worker, 'https://two.test/b', { active: false });
    await createTab(worker, 'https://two.test/c', { active: false });
    const folder = (title: string) =>
      page.locator(`.tab-folder-row .folder-item[aria-label^="${title},"]`);
    await expect(folder('one.test')).toHaveAttribute('aria-label', 'one.test, 1 tabs');
    await expect(folder('two.test')).toHaveAttribute('aria-label', 'two.test, 2 tabs');

    const targetRow = backedTabRow(page, 'https://one.test/a');
    await liftTabRow(page, backedTabRow(page, 'https://two.test/b'));
    const box = await targetRow.boundingBox();
    if (!box) throw new Error('The target row had no geometry');
    await page.mouse.move(box.x + box.width * 0.75, box.y + box.height / 2, { steps: 8 });
    await expect(targetRow).toHaveClass(/drop-split/);
    await page.mouse.up();

    await expect.poll(() => worker.evaluate(() =>
      (globalThis as unknown as { __hyperSplits?: number[][] }).__hyperSplits))
      .toEqual([[target, dragged]]);
    const splitRow = page.locator('.tab-split-row');
    await expect(splitRow.locator('.tab-row')).toHaveCount(2);
    // The pair joins the dropped-on tab's site folder, not the dragged tab's.
    await expect(folder('one.test')).toHaveAttribute('aria-label', 'one.test, 2 tabs');
    await expect(folder('two.test')).toHaveAttribute('aria-label', 'two.test, 1 tabs');
    await expect(splitRow).toHaveCSS('--tree-depth', '1');
    await expect.poll(() => page.locator('.tab-folder-row .folder-item, .tab-row .tab-main')
      .evaluateAll((items) => items.map((item) =>
        item.getAttribute('data-url') ?? item.getAttribute('aria-label')?.split(',')[0])))
      .toEqual(['one.test', 'https://one.test/a', 'https://two.test/b', 'two.test', 'https://two.test/c']);
  }, { closeInitialPage: true });
});
