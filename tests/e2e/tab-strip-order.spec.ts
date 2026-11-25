import { expect, test, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { saveHyperPreference } from './fixtures/preferences';
import { callChrome } from './helpers/chrome';
import { routeHtml, withHyper as withHyperSession } from './helpers/extension';
import { backedTabOrder, dragTabRowBefore, renderedTabOrder } from './helpers/sidebar';
import { navigateTab, nativeTabOrder, waitForTabsComplete as waitForComplete } from './helpers/tabs';

const pageUrl = (host: string, path: string) => `https://${host}/${path}`;

/** Opens a background tab at `url`, or at the new tab page as Ctrl+T does. */
async function openTab(worker: Worker, url?: string): Promise<number> {
  const tab = await callChrome<{ id?: number }>(worker, 'tabs.create', { active: false, ...(url ? { url } : {}) });
  if (tab.id === undefined) throw new Error('Chrome did not create a tab ID');
  return tab.id;
}

const tabIdAt = async (worker: Worker, url: string) =>
  (await callChrome<Array<{ id?: number }>>(worker, 'tabs.query', { url }))[0]?.id;

function withHyper(
  name: string,
  run: (hyper: { context: BrowserContext; page: Page; worker: Worker }) => Promise<void>,
) {
  return withHyperSession(`tab-strip-${name}`, async ({ context, page, worker }) => {
    await routeHtml(context, /^https:\/\/[a-z]+\.strip\.test\//, ({ host, pathname }) => pathname === '/opener'
      ? '<!doctype html><title>Opener</title><a id="one" href="/link-1">One</a> <a id="two" href="/link-2">Two</a>'
      : `<!doctype html><title>${host}</title>`);
    await page.setViewportSize({ width: 720, height: 900 });
    await expect(page.locator('.space-pagination-dot')).toHaveCount(1);
    await new Promise((settle) => setTimeout(settle, 1_000));
    await run({ context, page, worker });
  }, { closeInitialPage: true });
}

test('dragging a tab in the list moves the tab in the tab strip', async () => {
  await withHyper('list-drag', async ({ page, worker }) => {
    const tabs: number[] = [];
    for (const path of ['a', 'b', 'c']) tabs.push(await openTab(worker, pageUrl('one.strip.test', path)));
    const [first, second, third] = tabs as [number, number, number];
    await expect.poll(() => backedTabOrder(page, tabs)).toEqual([first, second, third]);
    await expect.poll(() => nativeTabOrder(worker, tabs)).toEqual([first, second, third]);

    await dragTabRowBefore(page, third, first);

    await expect.poll(() => renderedTabOrder(page, tabs)).toEqual([third, first, second]);
    await expect.poll(() => nativeTabOrder(worker, tabs)).toEqual([third, first, second]);
  });
});

test('autofolders gather the tab strip by site once a navigation completes', async () => {
  await withHyper('autofolders', async ({ page, worker }) => {
    await saveHyperPreference(worker, 'autofolders', true);
    const alpha = await openTab(worker, pageUrl('alpha.strip.test', '1'));
    const beta = await openTab(worker, pageUrl('beta.strip.test', '1'));
    const alphaTwo = await openTab(worker, pageUrl('alpha.strip.test', '2'));
    const tabs = [alpha, beta, alphaTwo];
    await waitForComplete(worker, tabs);
    await expect.poll(() => renderedTabOrder(page, tabs)).toEqual([alpha, alphaTwo, beta]);
    await expect.poll(() => nativeTabOrder(worker, tabs)).toEqual([alpha, alphaTwo, beta]);

    // Leaving its site moves the tab to its new site's folder, in the list and the strip alike.
    await navigateTab(worker, alpha, pageUrl('beta.strip.test', '2'));
    await waitForComplete(worker, tabs);
    await expect.poll(() => renderedTabOrder(page, tabs)).toEqual([alpha, beta, alphaTwo]);
    await expect.poll(() => nativeTabOrder(worker, tabs)).toEqual([alpha, beta, alphaTwo]);
  });
});

test('a tab moved in the tab strip keeps its place in the list', async () => {
  await withHyper('native-move', async ({ page, worker }) => {
    const tabs: number[] = [];
    for (const path of ['a', 'b', 'c']) tabs.push(await openTab(worker, pageUrl('two.strip.test', path)));
    const [first, second, third] = tabs as [number, number, number];
    await expect.poll(() => renderedTabOrder(page, tabs)).toEqual([first, second, third]);
    await expect.poll(() => nativeTabOrder(worker, tabs)).toEqual([first, second, third]);

    // Plays the user dragging the first tab after the last in the browser's own tab strip.
    const { windowId } = await callChrome<{ windowId: number }>(worker, 'tabs.get', third);
    const { index } = (await callChrome<Array<{ id?: number; index: number }>>(worker, 'tabs.query', { windowId }))
      .find((tab) => tab.id === third)!;
    await callChrome(worker, 'tabs.move', first, { index });

    await expect.poll(() => renderedTabOrder(page, tabs)).toEqual([second, third, first]);
    await expect.poll(() => nativeTabOrder(worker, tabs)).toEqual([second, third, first]);
    // The list's order is the model's, so it holds rather than springing back.
    await page.waitForTimeout(750);
    expect(await nativeTabOrder(worker, tabs)).toEqual([second, third, first]);
    expect(await renderedTabOrder(page, tabs)).toEqual([second, third, first]);
  });
});

test('a tab opened from a link sits after its opener in the list and the strip', async () => {
  await withHyper('opener', async ({ context, page, worker }) => {
    const openerPage = await context.newPage();
    await openerPage.goto(pageUrl('three.strip.test', 'opener'));
    const last = await openTab(worker, pageUrl('three.strip.test', 'last'));
    const opener = (await tabIdAt(worker, pageUrl('three.strip.test', 'opener')))!;
    await expect.poll(() => renderedTabOrder(page, [opener, last])).toEqual([opener, last]);

    // The browser opens each background link after its page, past that page's earlier links.
    const openLink = async (id: string) => {
      const opened = context.waitForEvent('page');
      await openerPage.click(`#${id}`, { modifiers: ['ControlOrMeta'] });
      await (await opened).waitForLoadState();
    };
    await openLink('one');
    await openLink('two');
    const findLinks = () => Promise.all([pageUrl('three.strip.test', 'link-1'), pageUrl('three.strip.test', 'link-2')]
      .map(async (url) => await tabIdAt(worker, url) ?? -1));
    await expect.poll(async () => (await findLinks()).includes(-1)).toBe(false);
    const linkIds = await findLinks();
    const tabs = [opener, ...linkIds, last];
    await waitForComplete(worker, tabs);

    await expect.poll(() => nativeTabOrder(worker, tabs)).toEqual(tabs);
    await expect.poll(() => renderedTabOrder(page, tabs)).toEqual(tabs);
    // The list's order is the model's, so the strip holds it.
    await page.waitForTimeout(750);
    expect(await nativeTabOrder(worker, tabs)).toEqual(tabs);
  });
});

test('a new tab given its first page keeps its strip place in the list', async () => {
  await withHyper('late-backing', async ({ page, worker }) => {
    // New tab pages have no page to keep, so neither tab has a place in the list yet.
    const first = await openTab(worker);
    const second = await openTab(worker);
    const tabs = [first, second];
    await expect.poll(() => nativeTabOrder(worker, tabs)).toEqual([first, second]);

    // The user types an address into the second new tab, then into the first.
    await navigateTab(worker, second, pageUrl('four.strip.test', 'second'));
    await expect.poll(() => backedTabOrder(page, tabs)).toEqual([second]);
    await navigateTab(worker, first, pageUrl('four.strip.test', 'first'));
    await waitForComplete(worker, tabs);

    await expect.poll(() => backedTabOrder(page, tabs)).toEqual([first, second]);
    await expect.poll(() => nativeTabOrder(worker, tabs)).toEqual([first, second]);
    // The strip follows the list, so it must not move the first tab after the second.
    await page.waitForTimeout(750);
    expect(await nativeTabOrder(worker, tabs)).toEqual([first, second]);
    expect(await renderedTabOrder(page, tabs)).toEqual([first, second]);
  });
});

/** Flips Settings > Tabs/Bookmarks > Re-arrange browser tab bar from the sidebar, as the user does. */
async function setTabOrderSync(page: Page, enabled: boolean) {
  await page.getByRole('button', { name: 'Open settings' }).click();
  const setting = page.getByRole('switch', { name: /Re-arrange browser tab bar/ });
  await expect(setting).toHaveAttribute('aria-checked', String(!enabled));
  await setting.click();
  await expect(setting).toHaveAttribute('aria-checked', String(enabled));
  await page.getByRole('button', { name: 'Back' }).click();
}

test('with tab order sync off, the list and the tab strip keep their own orders until it is on again', async () => {
  await withHyper('sync-off', async ({ page, worker }) => {
    const tabs: number[] = [];
    for (const path of ['a', 'b', 'c']) tabs.push(await openTab(worker, pageUrl('five.strip.test', path)));
    const [first, second, third] = tabs as [number, number, number];
    await expect.poll(() => renderedTabOrder(page, tabs)).toEqual([first, second, third]);
    await expect.poll(() => nativeTabOrder(worker, tabs)).toEqual([first, second, third]);
    await setTabOrderSync(page, false);

    // A list drag leaves the strip alone.
    await dragTabRowBefore(page, third, first);
    await expect.poll(() => renderedTabOrder(page, tabs)).toEqual([third, first, second]);

    // A strip move leaves the list alone.
    const { windowId } = await callChrome<{ windowId: number }>(worker, 'tabs.get', third);
    const { index } = (await callChrome<Array<{ id?: number; index: number }>>(worker, 'tabs.query', { windowId }))
      .find((tab) => tab.id === third)!;
    await callChrome(worker, 'tabs.move', first, { index });
    await expect.poll(() => nativeTabOrder(worker, tabs)).toEqual([second, third, first]);
    await page.waitForTimeout(750);
    expect(await nativeTabOrder(worker, tabs)).toEqual([second, third, first]);
    expect(await renderedTabOrder(page, tabs)).toEqual([third, first, second]);

    // Turning sync back on puts the strip in the list's order.
    await setTabOrderSync(page, true);
    await expect.poll(() => nativeTabOrder(worker, tabs)).toEqual([third, first, second]);
    expect(await renderedTabOrder(page, tabs)).toEqual([third, first, second]);
  });
});
