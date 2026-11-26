import {
  expect,
  test,
  type BrowserContext,
  type Page,
  type Worker,
} from '@playwright/test';
import { saveHyperPreference } from './fixtures/preferences';
import { bookmarkParentId, callChrome } from './helpers/chrome';
import {
  openSidepanel,
  routeHtml,
  withExtension,
  type ExtensionLaunchOptions,
} from './helpers/extension';
import { pressAndPull } from './helpers/sidebar';
import { createTab } from './helpers/tabs';

const createOwnedTab = (worker: Worker, url: string, openerTabId?: number) =>
  createTab(worker, url, { active: false, openerTabId });

/** Turns on autofolders, routes the test pages, and opens the sidebar. */
async function withAutofolders(
  name: string,
  routes: (context: BrowserContext) => Promise<void>,
  run: (hyper: { context: BrowserContext; page: Page; worker: Worker }) => Promise<void>,
  options: ExtensionLaunchOptions = {},
): Promise<void> {
  await withExtension(name, async ({ context, worker }) => {
    await saveHyperPreference(worker, 'autofolders', true);
    await routes(context);
    const page = await openSidepanel(context, worker, { width: 720, height: 900 }, {
      waitUntil: 'domcontentloaded',
    });
    await run({ context, page, worker });
  }, { closeInitialPage: true, ...options });
}

const routeHosts = (hosts: readonly string[]) => async (context: BrowserContext) => {
  for (const host of hosts) {
    await routeHtml(context, `https://${host}/**`, `<!doctype html><title>${host}</title>`);
  }
};

const folderLabel = (page: Page, title: string) =>
  page.locator(`.tab-folder-row .folder-item[aria-label^="${title},"]`);

const expectFolderCount = (page: Page, title: string, count: number) =>
  expect(folderLabel(page, title)).toHaveAttribute('aria-label', `${title}, ${count} tabs`);

async function dragToRootTarget(
  page: Page,
  sourceSelector: string,
): Promise<void> {
  const sourceRow = page.locator(
    `${sourceSelector}:not([data-tab-node-id^="unsupported-tab:"])`,
  );
  await expect(sourceRow).toHaveCount(1);
  const source = sourceRow.locator('.tab-main');
  const sourceMotionRow = sourceRow.locator('..');
  const rootTarget = page.locator('.tabs-drop-zone > .tree-root-drop-target');
  await expect(source).toBeVisible();
  await expect(sourceRow).toHaveCSS('height', '36px');
  await expect(sourceMotionRow).toHaveCSS('height', '36px');
  await expect(sourceMotionRow).toHaveCSS('opacity', '1');
  await expect(source).toHaveCSS('cursor', 'default');
  await expect(rootTarget).toBeVisible();
  const sourceBox = await source.boundingBox();
  const targetBox = await rootTarget.boundingBox();
  if (!sourceBox || !targetBox) throw new Error('Drag geometry was unavailable');
  const sourceX = sourceBox.x + sourceBox.width / 2;
  const sourceY = sourceBox.y + sourceBox.height / 2;
  const targetX = targetBox.x + targetBox.width / 2;
  const targetY = targetBox.y + targetBox.height / 2;
  await page.mouse.move(sourceX, sourceY);
  await page.mouse.down();
  await page.mouse.move(sourceX, sourceY + 12, { steps: 2 });
  await expect(sourceRow).toHaveClass(/is-dragging/);
  await expect(sourceMotionRow).toHaveCSS('height', '0px');
  await expect(sourceMotionRow).toHaveCSS('min-height', '0px');
  await expect(source).toHaveCSS('cursor', 'default');
  await page.mouse.move(
    targetX,
    targetY,
    { steps: 8 },
  );
}

async function sampleTabFolderToggle(
  page: Page,
  folderTitle: string,
  childUrlPrefix: string,
): Promise<Array<{ height: number; opacity: number; regionHeight: number }>> {
  return page.evaluate(({
    targetChildUrlPrefix,
    targetFolderTitle,
  }) =>
    new Promise<Array<{
      height: number;
      opacity: number;
      regionHeight: number;
    }>>((resolveSamples) => {
      const folder = Array.from(document.querySelectorAll<HTMLElement>(
        '.tab-folder-row .folder-item',
      )).find((candidate) =>
        candidate.getAttribute('aria-label')?.startsWith(`${targetFolderTitle},`));
      if (!folder) throw new Error(`Tab folder ${targetFolderTitle} was not rendered`);
      const samples: Array<{
        height: number;
        opacity: number;
        regionHeight: number;
      }> = [];
      const startedAt = performance.now();
      const sample = () => {
        const childRows = Array.from(document.querySelectorAll<HTMLElement>(
          '.tab-row',
        )).filter((candidate) =>
          candidate.querySelector<HTMLElement>('.tab-main')?.dataset.url?.startsWith(
            targetChildUrlPrefix,
          ));
        const childItems = childRows.flatMap((childRow) =>
          childRow.parentElement ? [childRow.parentElement] : []);
        const child = childItems[0];
        if (child) {
          samples.push({
            height: child.getBoundingClientRect().height,
            opacity: Number(getComputedStyle(child).opacity),
            regionHeight: childItems.reduce((total, item) => {
              const style = getComputedStyle(item);
              return total + item.getBoundingClientRect().height +
                Number.parseFloat(style.marginBottom);
            }, 0),
          });
        }
        if (performance.now() - startedAt < 300) requestAnimationFrame(sample);
        else resolveSamples(samples);
      };
      folder.click();
      sample();
    }), {
      targetChildUrlPrefix: childUrlPrefix,
      targetFolderTitle: folderTitle,
    });
}

function hasCollapsingHeight(samples: Array<{ height: number }>): boolean {
  const fullHeight = Math.max(...samples.map((sample) => sample.height));
  return samples.some((sample) => sample.height > 1 && sample.height < fullHeight - 1) &&
    Math.min(...samples.map((sample) => sample.height)) < 2;
}

function hasIntermediateRegionHeight(samples: Array<{ regionHeight: number }>): boolean {
  const minimum = Math.min(...samples.map((sample) => sample.regionHeight));
  const maximum = Math.max(...samples.map((sample) => sample.regionHeight));
  return samples.some((sample) =>
    sample.regionHeight > minimum + 2 && sample.regionHeight < maximum - 2);
}

test('tweens autofolder child layout while opening and closing', async () => {
  await withAutofolders('autofolder-animation', async (context) => {
    await routeHtml(context, 'https://animation.test/**', '<!doctype html><title>Animation</title>');
  }, async ({ page: sidepanelPage, worker }) => {
    await createOwnedTab(worker, 'https://animation.test/a');
    await createOwnedTab(worker, 'https://animation.test/b');

    const children = sidepanelPage.locator(
      '.tab-row:has(.tab-main[data-url^="https://animation.test/"])',
    );
    await expect(children).toHaveCount(2);
    const firstChildMotionItem = children.first().locator('xpath=..');
    await expect.poll(() => firstChildMotionItem.evaluate((element) =>
      element.getBoundingClientRect().height)).toBeGreaterThan(30);
    await expect(firstChildMotionItem).toHaveCSS('opacity', '1');
    const toggleTweened = async () => {
      const samples = await sampleTabFolderToggle(
        sidepanelPage,
        'animation.test',
        'https://animation.test/',
      );
      expect(hasCollapsingHeight(samples), JSON.stringify(samples)).toBe(true);
      expect(hasIntermediateRegionHeight(samples), JSON.stringify(samples)).toBe(true);
    };
    await toggleTweened();
    await expect(children).toHaveCount(0);
    const collapsedIcon = sidepanelPage.locator(
      '.tab-folder-row .folder-item[aria-label^="animation.test,"] .bookmark-folder-icon',
    );
    await expect(collapsedIcon.locator('.lucide-folder')).toHaveCount(1);
    await expect(collapsedIcon.locator('.folder-count')).toHaveText('2');
    const [iconBounds, countBounds] = await Promise.all([
      collapsedIcon.boundingBox(),
      collapsedIcon.locator('.folder-count').boundingBox(),
    ]);
    expect(iconBounds).not.toBeNull();
    expect(countBounds).not.toBeNull();
    expect(countBounds!.x).toBeGreaterThanOrEqual(iconBounds!.x);
    expect(countBounds!.x + countBounds!.width)
      .toBeLessThanOrEqual(iconBounds!.x + iconBounds!.width);
    expect(countBounds!.y).toBeGreaterThanOrEqual(iconBounds!.y);
    expect(countBounds!.y + countBounds!.height)
      .toBeLessThanOrEqual(iconBounds!.y + iconBounds!.height);

    await toggleTweened();
    await expect(children).toHaveCount(2);
  }, { reducedMotion: 'no-preference' });
});

test('a root drop keeps a tab in its autofolder, after its siblings', async () => {
  await withAutofolders('autofolder-drop', async (context) => {
    await routeHtml(context, 'https://one.test/**', '<!doctype html><title>One</title>');
    await routeHtml(context, 'https://two.test/**', '<!doctype html><title>Two</title>');
  }, async ({ page: sidepanelPage, worker }) => {
    await expect(sidepanelPage.locator('.space-pagination-dot')).toHaveCount(1);
    await createOwnedTab(worker, 'https://one.test/a');
    await createOwnedTab(worker, 'https://two.test/a');
    await createOwnedTab(worker, 'https://two.test/b');

    const finalFolderRows = sidepanelPage.locator(
      '.tab-row:has(.tab-main[data-url^="https://two.test/"])',
    );
    await expect(finalFolderRows).toHaveCount(2);
    const sourceRow = finalFolderRows.nth(0);
    const provisionalFinalRow = finalFolderRows.nth(1);
    const sourceTabId = await sourceRow.getAttribute('data-tab-id');
    const finalTabId = await provisionalFinalRow.getAttribute('data-tab-id');
    if (!sourceTabId) throw new Error('Source tab row did not expose its tab ID');
    if (!finalTabId) throw new Error('Final tab row did not expose its tab ID');
    await expect(finalFolderRows.last()).toHaveAttribute('data-tab-id', finalTabId);
    await dragToRootTarget(
      sidepanelPage,
      `[data-tab-id="${sourceTabId}"]`,
    );
    await expect(sidepanelPage.locator('.tabs-list .tree-drop-placeholder')).toBeVisible();
    await sidepanelPage.mouse.up();
    await expect(finalFolderRows.last())
      .toHaveAttribute('data-tab-id', sourceTabId);
  }, { reducedMotion: 'no-preference' });
});

test('moves autofolder tabs into manual folders and back to the root', async () => {
  await withAutofolders('autofolder-manual', routeHosts(['one.test', 'two.test']), async ({ page, worker }) => {
    await createOwnedTab(worker, 'https://one.test/a');
    await createOwnedTab(worker, 'https://one.test/b');
    await createOwnedTab(worker, 'https://two.test/a');
    await expectFolderCount(page, 'one.test', 2);
    await expectFolderCount(page, 'two.test', 1);

    const { manualId, tabsRootId } = await worker.evaluate(async () => {
      type Node = { id: string; title: string; url?: string; children?: Node[] };
      const extension = globalThis as unknown as {
        chrome: {
          bookmarks: {
            getTree: () => Promise<Node[]>;
            create: (details: object) => Promise<{ id: string }>;
          };
        };
      };
      const find = (nodes: Node[]): Node | undefined => {
        for (const node of nodes) {
          if (!node.url && node.title.includes('"spaceTabs":true')) return node;
          const found = find(node.children ?? []);
          if (found) return found;
        }
        return undefined;
      };
      const tabsRoot = find(await extension.chrome.bookmarks.getTree());
      if (!tabsRoot) throw new Error('The space tabs root was missing');
      const manual = await extension.chrome.bookmarks.create({
        parentId: tabsRoot.id,
        index: 0,
        title: 'Manual {"hyper":{"tabFolder":true}}',
      });
      return { manualId: manual.id, tabsRootId: tabsRoot.id };
    });
    await expectFolderCount(page, 'Manual', 0);

    const sourceRow = page.locator(
      '.tab-row:has(.tab-main[data-url="https://one.test/a"]):not([data-tab-node-id^="unsupported-tab:"])',
    );
    const backingId = await sourceRow.getAttribute('data-tab-node-id');
    if (!backingId) throw new Error('The source tab had no backing');
    const backingParent = () => bookmarkParentId(worker, backingId);
    const settledRows = async () => {
      let previous = '';
      for (;;) {
        const layout = await page.evaluate(() => Array.from(
          document.querySelectorAll('[data-tab-node-id]'),
          (row) => Math.round(row.getBoundingClientRect().top),
        ).join(','));
        if (layout === previous) return;
        previous = layout;
        await page.waitForTimeout(150);
      }
    };
    const dragOnto = async (target: ReturnType<Page['locator']>) => {
      // Rows animate after a drop, so measure only once the whole list has settled.
      await settledRows();
      await pressAndPull(page, sourceRow.locator('.tab-main'));
      // The dragged row collapses, shifting any target below it.
      await settledRows();
      const targetBox = await target.boundingBox();
      if (!targetBox) throw new Error('Drop target was unavailable');
      await page.mouse.move(
        targetBox.x + targetBox.width / 2,
        targetBox.y + targetBox.height / 2,
        { steps: 8 },
      );
      await expect(target.locator('xpath=ancestor::*[contains(@class,"tab-folder-row")][1]'))
        .toHaveClass(/drop-inside/);
      await page.mouse.up();
    };

    await dragOnto(folderLabel(page, 'Manual'));
    await expect.poll(backingParent).toBe(manualId);
    await expectFolderCount(page, 'Manual', 1);
    await expectFolderCount(page, 'one.test', 1);

    await dragOnto(folderLabel(page, 'two.test'));
    await expect.poll(backingParent).toBe(tabsRootId);
    await expectFolderCount(page, 'Manual', 0);
    await expectFolderCount(page, 'one.test', 2);
    await expectFolderCount(page, 'two.test', 1);
  });
});

test('dedupes an autofolder only when it holds duplicate pages', async () => {
  await withAutofolders('autofolder-dedupe', routeHosts(['one.test', 'two.test']), async ({ page, worker }) => {
    await createOwnedTab(worker, 'https://one.test/a');
    // Hyper only folds duplicates the user is looking at, so a background tab can become one.
    const copy = await createOwnedTab(worker, 'https://one.test/copy');
    await callChrome(worker, 'tabs.update', copy, { url: 'https://one.test/a' });
    await createOwnedTab(worker, 'https://one.test/b');
    const twoTest = await createOwnedTab(worker, 'https://two.test/a');
    await expectFolderCount(page, 'one.test', 3);
    await expectFolderCount(page, 'two.test', 1);
    await expect(page.getByRole('button', { name: 'Dedupe tabs in two.test' })).toHaveCount(0);

    // Copies Hyper permits, from another app or a ctrl/cmd-click, are still the folder's to sweep.
    for (const openerTabId of [undefined, twoTest]) {
      await createOwnedTab(worker, 'https://two.test/a', openerTabId);
      await expectFolderCount(page, 'two.test', 2);
      await page.getByRole('button', { name: 'Dedupe tabs in two.test' }).click();
      await expectFolderCount(page, 'two.test', 1);
      await expect(page.getByRole('button', { name: 'Dedupe tabs in two.test' })).toHaveCount(0);
    }

    // A different query is a different page, as with two frames of one Figma file.
    for (const node of [1, 2]) await createOwnedTab(worker, `https://two.test/file/?node-id=${node}`);
    await expectFolderCount(page, 'two.test', 3);
    await expect(page.getByRole('button', { name: 'Dedupe tabs in two.test' })).toHaveCount(0);

    // Revealing the close button on hover must not slide the broom out from under the pointer.
    const dedupe = page.getByRole('button', { name: 'Dedupe tabs in one.test' });
    await page.mouse.move(1, 1);
    await expect(page.getByRole('button', { name: 'Close tabs in one.test' })).toHaveCSS('width', '0px');
    const restingBox = await dedupe.boundingBox();
    await dedupe.hover();
    await expect(page.getByRole('button', { name: 'Close tabs in one.test' })).toHaveCSS('width', '20px');
    expect(await dedupe.boundingBox()).toEqual(restingBox);
    await dedupe.click();

    await expectFolderCount(page, 'one.test', 2);
    await expect(page.getByRole('button', { name: 'Dedupe tabs in one.test' })).toHaveCount(0);
    await expect.poll(async () => (await callChrome<Array<{ url?: string }>>(worker, 'tabs.query', {}))
      .filter((tab) => tab.url === 'https://one.test/a').length).toBe(1);
  });
});

test('waits for loading to finish before moving a tab between autofolders', async () => {
  let markNavigationStarted = () => {};
  const navigationStarted = new Promise<void>((resolveStarted) => {
    markNavigationStarted = resolveStarted;
  });
  let releaseNavigation = () => {};
  const navigationReleased = new Promise<void>((resolveReleased) => {
    releaseNavigation = resolveReleased;
  });
  await withAutofolders('autofolder-loading', async (context) => {
    await routeHtml(context, 'https://one.test/**', '<!doctype html><title>One</title>');
    await context.route('https://two.test/**', async (route) => {
      if (new URL(route.request().url()).pathname === '/next') {
        markNavigationStarted();
        await navigationReleased;
      }
      await route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><title>Two</title>',
      });
    });
  }, async ({ page, worker }) => {
    try {
      const source = await createOwnedTab(worker, 'https://one.test/start');
      await createOwnedTab(worker, 'https://two.test/existing');
      const tabStatus = async () => (await callChrome<{ status?: string }>(worker, 'tabs.get', source)).status;
      await expectFolderCount(page, 'one.test', 1);
      await expectFolderCount(page, 'two.test', 1);

      await callChrome(worker, 'tabs.update', source, { url: 'https://two.test/next' });
      await navigationStarted;
      await expect.poll(tabStatus).toBe('loading');
      await expectFolderCount(page, 'one.test', 1);
      await expectFolderCount(page, 'two.test', 1);

      releaseNavigation();
      await expect.poll(tabStatus).toBe('complete');
      await expect(folderLabel(page, 'one.test')).toHaveCount(0);
      await expectFolderCount(page, 'two.test', 2);
    } finally {
      releaseNavigation();
    }
  });
});
