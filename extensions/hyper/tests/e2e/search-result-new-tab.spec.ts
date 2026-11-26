import { expect, test, type BrowserContext, type Frame, type Page, type Worker } from '@playwright/test';
import { callChrome, seedHyperSpace } from './helpers/chrome';
import {
  extensionBaseUrl,
  openPageSearch,
  openSidepanel,
  routeHtml,
  titledPage,
  withExtension,
} from './helpers/extension';

const searchName = { name: 'Search tabs, bookmarks, history, or commands' };
const bookmarkUrl = 'https://modifier-bookmark.test/page';
const typedUrl = 'https://modifier-typed.test/page';
const webQuery = 'modifier web query';

interface ChromeTab {
  id?: number;
  pendingUrl?: string;
  url?: string;
}

const tabUrl = (tab: ChromeTab) => tab.pendingUrl ?? tab.url ?? '';
const allTabs = (worker: Worker) => callChrome<ChromeTab[]>(worker, 'tabs.query', {});

/** Each result kind a Ctrl/Cmd click or Enter should open beside the page Search runs in. */
const cases = [
  { query: 'Modifier bookmark', option: /^Modifier bookmark https/, opens: (url: string) => url === bookmarkUrl },
  { query: typedUrl, option: /Go to modifier-typed\.test/, opens: (url: string) => url === typedUrl },
  {
    query: webQuery,
    option: /Search the web for/,
    opens: (url: string) => url.startsWith('https://www.google.com/search') && url.includes('modifier+web+query'),
  },
];

/** Ctrl/Cmd-activates each kind of result, expecting a new tab while the host stays put. */
async function expectModifiedActivationsOpenNewTabs(
  worker: Worker,
  surface: () => Page | Frame,
  openSearch: () => Promise<void>,
  hostUrl: string,
) {
  const [host] = (await allTabs(worker)).filter((tab) => tabUrl(tab) === hostUrl);
  if (host?.id === undefined) throw new Error(`No tab shows ${hostUrl}`);
  for (const { opens, option, query } of cases) {
    await test.step(query, async () => {
      for (const activation of ['click', 'enter'] as const) {
        await openSearch();
        const input = surface().getByRole('combobox', searchName);
        await input.fill(query);
        const result = surface().getByRole('option', { name: option });
        if (activation === 'click') await result.click({ modifiers: ['ControlOrMeta'] });
        else await input.press('ControlOrMeta+Enter');
        const opened = async () => (await allTabs(worker))
          .filter((tab) => opens(tabUrl(tab)));
        await expect.poll(async () => (await opened()).map((tab) => tab.id === host.id)).toEqual([false]);
        expect(tabUrl(await callChrome<ChromeTab>(worker, 'tabs.get', host.id))).toBe(hostUrl);
        await callChrome(worker, 'tabs.remove', (await opened())[0]!.id);
      }
    });
  }
}

const withSeededBrowser = (
  name: string,
  run: (session: { context: BrowserContext; worker: Worker }) => Promise<void>,
) => withExtension(name, async ({ context, worker }) => {
  await routeHtml(context, 'https://modifier-*.test/**', titledPage('Modifier page'));
  await routeHtml(context, 'https://www.google.com/**', titledPage('Search results'));
  await routeHtml(context, 'https://example.com/**', `${titledPage('Example Domain')}<h1>Example Domain</h1>`);
  await seedHyperSpace(worker, {
    space: 'Current space',
    bookmarks: [{ title: 'Modifier bookmark', url: bookmarkUrl }],
  });
  await run({ context, worker });
}, { channel: process.env.HYPER_BROWSER_CHANNEL ?? 'chromium' });

test('opens a Ctrl/Cmd-activated sidebar Search result in a new tab', async () => {
  await withSeededBrowser('search-result-new-tab-sidebar', async ({ context, worker }) => {
    const sidepanel = await openSidepanel(context, worker);
    await expectModifiedActivationsOpenNewTabs(worker, () => sidepanel, async () => {
      // Picking a result closes sidebar Search, so each pick starts from the Search button.
      await expect(sidepanel.getByRole('combobox', searchName)).toHaveCount(0);
      await sidepanel.getByRole('button', { name: 'Search tabs and history' }).click();
    }, sidepanel.url());
  });
});

test('opens a Ctrl/Cmd-activated new tab page Search result in a new tab', async () => {
  await withSeededBrowser('search-result-new-tab-newtab', async ({ context, worker }) => {
    const newTab = await context.newPage();
    const newTabUrl = `${extensionBaseUrl(worker)}/newtab.html`;
    await newTab.goto(newTabUrl);
    await expectModifiedActivationsOpenNewTabs(worker, () => newTab, () => newTab.bringToFront(), newTabUrl);
  });
});

test('opens a Ctrl/Cmd-activated in-page Search result in a new tab', async () => {
  await withSeededBrowser('search-result-new-tab-inpage', async ({ context, worker }) => {
    const webpage = await context.newPage();
    await webpage.goto('https://example.com/');
    let frame: Frame | undefined;
    await expectModifiedActivationsOpenNewTabs(worker, () => frame!, async () => {
      await webpage.bringToFront();
      await webpage.locator('h1').click();
      frame = await openPageSearch(webpage);
    }, 'https://example.com/');
  });
});
