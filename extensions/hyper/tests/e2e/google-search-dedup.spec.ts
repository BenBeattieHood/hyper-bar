import { expect, test, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { callChrome } from './helpers/chrome';
import { extensionBaseUrl, openSidepanel, withExtension } from './helpers/extension';

const existingSearchUrl = 'https://www.google.com/search?q=what+is+apollo+graphql+readfragment&oq=what+is+apollo+graphql+readfragment&gs_lcrp=EgRlZGdlKgYIABBFGDkyBggAEEUYOTIHCAEQABjvBTIKCAIQABiABBiiBDIHCAMQABjvBTIKCAQQABiiBBiJBTIICAUQ6QcY_FUyBwgGEOsHGEDSAQg5NjMxajBqOagCALACAQ&sourceid=chrome&source=chrome.ob&ie=UTF-8';
const nextSearch = 'what is the best react animation library';

function searchQuery(page: Page): string | null {
  try {
    return new URL(page.url()).searchParams.get('q');
  } catch {
    return null;
  }
}

async function waitForSearchBox(page: Page) {
  const searchBox = page.locator('textarea[name="q"], input[name="q"]').first();
  await expect(searchBox).toBeVisible({ timeout: 15_000 });
  return searchBox;
}

async function ownedTabUrls(worker: Worker): Promise<string[]> {
  const tabs = await callChrome<Array<{ id?: number; pendingUrl?: string; url?: string }>>(worker, 'tabs.query', {});
  const ownerships = await Promise.all(tabs.map(async (tab) => ({
    ownership: tab.id === undefined
      ? undefined
      : (await callChrome<Record<string, unknown>>(worker, 'storage.session.get', `tabSpaceId:${tab.id}`))[`tabSpaceId:${tab.id}`],
    url: tab.pendingUrl ?? tab.url,
  })));
  return ownerships.flatMap(({ ownership, url }) => ownership && url ? [url] : []);
}

async function createBrowserTab(context: BrowserContext, worker: Worker, url?: string): Promise<Page> {
  const [page] = await Promise.all([
    context.waitForEvent('page'),
    callChrome(worker, 'tabs.create', { active: true, ...(url ? { url } : {}) }),
  ]);
  return page;
}

test('keeps a new Google query open beside an existing Google search', async () => {
  await withExtension('playwright', async ({ context, worker }) => {
    const navigations: string[] = [];
    await openSidepanel(context, worker, undefined, { waitUntil: 'domcontentloaded' });
    // Google is served locally, so a run never depends on the network: its home page searches through a form.
    await context.route((url) => url.hostname === 'www.google.com', (route) => {
      const query = new URL(route.request().url()).searchParams.get('q');
      return route.fulfill({
        contentType: 'text/html',
        body: query === null
          ? '<!doctype html><title>Google</title><form action="/search">' +
            '<input name="q" aria-label="Search"><input type="hidden" name="source" value="hp"></form>'
          : `<!doctype html><title>${query} - Google Search</title>`,
      });
    });
    await context.route((url) =>
      url.hostname === 'www.google.com' &&
      url.pathname === '/search' &&
      url.searchParams.get('q') === 'what is apollo graphql readfragment',
    (route) => route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><title>Apollo GraphQL readFragment - Google Search</title>',
    }));

    const existingPage = await createBrowserTab(context, worker, existingSearchUrl);
    existingPage.on('framenavigated', (frame) => {
      if (frame === existingPage.mainFrame()) navigations.push(`existing: ${frame.url()}`);
    });
    await existingPage.waitForLoadState('domcontentloaded');
    await existingPage.bringToFront();
    await expect.poll(async () => (await ownedTabUrls(worker)).some((url) =>
      new URL(url).searchParams.get('q') === 'what is apollo graphql readfragment'))
      .toBe(true);

    const newSearchPage = await createBrowserTab(context, worker);
    newSearchPage.on('framenavigated', (frame) => {
      if (frame === newSearchPage.mainFrame()) navigations.push(`new: ${frame.url()}`);
    });
    await expect(newSearchPage).toHaveURL(`${extensionBaseUrl(worker)}/newtab.html`);
    await newSearchPage.goto('https://www.google.com/?hl=en', {
      waitUntil: 'domcontentloaded',
    });
    await expect.poll(() => ownedTabUrls(worker)).toContain('https://www.google.com/?hl=en');
    const searchBox = await waitForSearchBox(newSearchPage);
    await searchBox.fill(nextSearch);
    await searchBox.press('Enter');

    await expect.poll(
      () => context.pages().map(searchQuery),
      { message: navigations.join('\n'), timeout: 15_000 },
    ).toContain(nextSearch);
    expect(newSearchPage.isClosed(), navigations.join('\n')).toBe(false);
    expect(context.pages().map(searchQuery), navigations.join('\n')).toContain(
      'what is apollo graphql readfragment',
    );
  }, { closeInitialPage: true, locale: 'en-US' });
});