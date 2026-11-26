import { expect, test, type Locator, type Page, type Worker } from '@playwright/test';
import { callChrome } from './helpers/chrome';
import { openSidepanel, routeHtml, sidepanelUrl, withExtension } from './helpers/extension';
import { backedTabRow, liftTabRow, pressAndPull, tabUrlSuffixOrder } from './helpers/sidebar';
import { createTab as openTab } from './helpers/tabs';
import type { ExtensionGlobal } from './helpers/extensionGlobal';

const createTab = (worker: Worker, url: string, windowId: number) =>
  openTab(worker, url, { active: false, windowId });

const currentWindowId = (page: Page) => page.evaluate(async () => {
  const extension = globalThis as unknown as ExtensionGlobal;
  const window = await extension.chrome.windows.getCurrent();
  if (window.id === undefined) throw new Error('The sidebar has no window');
  return window.id;
});

const tabRow = (page: Page, path: string) => backedTabRow(page, `https://cross.test/${path}`);

const tabOrder = (page: Page) => tabUrlSuffixOrder(page, 'https://cross.test/');

/**
 * Opens a sidebar, then a second window's sidebar, both 720 by 900, and runs
 * `run` with `source` recording the token of the drag it starts.
 */
async function withTwoSidebars(
  name: string,
  run: (windows: {
    destination: Page;
    destinationWindowId: number;
    source: Page;
    sourceWindowId: number;
    worker: Worker;
  }) => Promise<void>,
): Promise<void> {
  await withExtension(name, async ({ context, worker }) => {
    await routeHtml(context, 'https://cross.test/**', '<!doctype html><title>Cross</title>');
    const source = await openSidepanel(
      context, worker, { width: 720, height: 900 }, { waitUntil: 'domcontentloaded' },
    );
    const sourceWindowId = await currentWindowId(source);
    const [destination] = await Promise.all([
      context.waitForEvent('page'),
      callChrome(worker, 'windows.create', { focused: false, url: sidepanelUrl(worker) }),
    ]);
    await destination.setViewportSize({ width: 720, height: 900 });
    await destination.waitForLoadState('domcontentloaded');
    const destinationWindowId = await currentWindowId(destination);
    await run({ destination, destinationWindowId, source, sourceWindowId, worker });
  }, { closeInitialPage: true });
}

const recordDragToken = (source: Page) => source.evaluate(() => {
  const scope = globalThis as unknown as { hyperDragToken?: string };
  document.addEventListener('dragstart', (event) => {
    scope.hyperDragToken = event.dataTransfer?.getData('application/x-hyper-drag');
  });
});

const recordedDragToken = (source: Page) => source.evaluate(() =>
  (globalThis as unknown as { hyperDragToken?: string }).hyperDragToken ?? '');

/** Hands the drag to `row` in the other sidebar: enter, over, then drop. */
async function dropInto(page: Page, row: Locator, token: string, beforeDrop = async () => {}) {
  await dragInto(page, row, token, 'dragenter');
  await dragInto(page, row, token, 'dragover');
  await beforeDrop();
  await dragInto(page, row, token, 'drop');
}

/**
 * Plays the browser's part in the receiving window: Playwright drives one page's
 * mouse, so the drag that arrives in the other sidebar is dispatched there.
 */
async function dragInto(page: Page, row: Locator, token: string, type: 'dragenter' | 'dragover' | 'drop') {
  const box = await row.boundingBox();
  if (!box) throw new Error('The target row had no geometry');
  await page.evaluate(({ eventType, hyperToken, x, y }) => {
    const scope = globalThis as unknown as { hyperTransfer?: DataTransfer };
    if (!scope.hyperTransfer) {
      scope.hyperTransfer = new DataTransfer();
      scope.hyperTransfer.setData('application/x-hyper-drag', hyperToken);
    }
    const target = document.elementFromPoint(x, y);
    if (!target) throw new Error('Nothing is under the drop point');
    target.dispatchEvent(new DragEvent(eventType, {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
      dataTransfer: scope.hyperTransfer,
    }));
  }, { eventType: type, hyperToken: token, x: box.x + box.width / 4, y: box.y + box.height - 4 });
}

test('a tab dragged out of one window\'s sidebar drops into another window\'s, where it lands', async () => {
  await withTwoSidebars('cross-window-drag', async ({
    destination, destinationWindowId, source, sourceWindowId, worker,
  }) => {
    expect(destinationWindowId).not.toBe(sourceWindowId);

    const moving = await createTab(worker, 'https://cross.test/a', sourceWindowId);
    await createTab(worker, 'https://cross.test/b', sourceWindowId);
    await createTab(worker, 'https://cross.test/c', destinationWindowId);
    await expect.poll(() => tabOrder(source)).toEqual(['a', 'b']);
    await expect.poll(() => tabOrder(destination)).toEqual(['c']);
    await recordDragToken(source);

    // Leaving the sidebar offers the drag to every other window's sidebar.
    await liftTabRow(source, tabRow(source, 'a'));
    await source.mouse.move(-40, 200, { steps: 4 });
    const token = await recordedDragToken(source);
    expect(token).not.toBe('');
    await expect(destination.locator('.shared-drag-stand-in')).toBeAttached();

    const below = tabRow(destination, 'c');
    await dropInto(destination, below, token, async () => {
      await expect(below).toHaveClass(/drop-after/);
    });

    await expect.poll(async () =>
      (await callChrome<{ windowId: number }>(worker, 'tabs.get', moving)).windowId)
      .toBe(destinationWindowId);
    await expect.poll(() => tabOrder(destination)).toEqual(['c', 'a']);
    await expect.poll(() => tabOrder(source)).toEqual(['b']);

    // The source window's drag ends outside any sidebar and withdraws its offer.
    await source.mouse.up();
    await expect(destination.locator('.shared-drag-stand-in')).toHaveCount(0);
  });
});

test('a favourite dragged into another window\'s tab list opens there', async () => {
  await withTwoSidebars('cross-window-favourite', async ({ destination, destinationWindowId, source, worker }) => {
    await createTab(worker, 'https://cross.test/c', destinationWindowId);
    await expect.poll(() => tabOrder(destination)).toEqual(['c']);
    await expect.poll(() => worker.evaluate(async () => {
      const { bookmarks } = (globalThis as unknown as ExtensionGlobal).chrome;
      const [root] = await bookmarks.getTree();
      const hyper = root?.children?.[0]?.children?.find((node) => node.title.startsWith('hyper'));
      const favourites = hyper?.children?.find((node) => node.title.startsWith('favourites'));
      if (!favourites) return false;
      await bookmarks.create({
        parentId: favourites.id,
        title: 'Saved {"hyper":{"favouriteSlot":0}}',
        url: 'https://cross.test/saved',
      });
      return true;
    })).toBe(true);
    const tile = source.locator('.favourite-tile[data-url="https://cross.test/saved"]');
    await expect(tile).toBeVisible();
    await recordDragToken(source);

    await pressAndPull(source, tile);
    await expect(source.locator('.favourite-tile-wrap.is-dragging')).toHaveCount(1);
    await source.mouse.move(-40, 200, { steps: 4 });
    const token = await recordedDragToken(source);
    await expect(destination.locator('.shared-drag-stand-in')).toBeAttached();

    const row = tabRow(destination, 'c');
    await dropInto(destination, row, token);

    await expect.poll(async () => (await callChrome<Array<{ pendingUrl?: string; url?: string }>>(
      worker, 'tabs.query', { windowId: destinationWindowId },
    )).some((tab) => (tab.pendingUrl ?? tab.url) === 'https://cross.test/saved')).toBe(true);
    await source.mouse.up();
    await expect(destination.locator('.shared-drag-stand-in')).toHaveCount(0);
  });
});
