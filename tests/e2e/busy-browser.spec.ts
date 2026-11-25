import { expect, test, type Page } from '@playwright/test';
import { callChrome } from './helpers/chrome';
import { extensionBaseUrl, routeHtml, withExtension } from './helpers/extension';

const browserChannel = process.env.HYPER_BROWSER_CHANNEL ?? 'chromium';

// Retitles itself and rewrites its address every 50ms, like a busy web app.
const busyPage = `<!doctype html><title>busy</title><script>
  let tick = 0;
  setInterval(() => {
    tick += 1;
    document.title = 'busy ' + tick;
    history.replaceState(null, '', '#' + tick);
  }, 50);
</script>`;

interface CountingChrome {
  chrome: Record<string, Record<string, unknown>>;
}

test('searches the web from a new tab while another window\'s page never stops changing', async () => {
  // The busy page loads the whole machine, which parallel tests share.
  test.setTimeout(90_000);
  await withExtension('busy-browser', async ({ context: browserContext, worker }) => {
    await routeHtml(browserContext, 'https://busy.test/**', busyPage);
    for (const engine of ['https://www.google.com/**', 'https://www.bing.com/**']) {
      await routeHtml(browserContext, engine, '<!doctype html><title>Results</title>');
    }
    // Other pages can open meanwhile, so each page is found by its address.
    const newPageAt = async (url: string, before: ReadonlySet<Page>) => {
      let found: Page | undefined;
      await expect.poll(() => {
        found = browserContext.pages().find((page) => !before.has(page) && page.url().startsWith(url));
        return found !== undefined;
      }, { timeout: 15_000 }).toBe(true);
      return found as Page;
    };

    await test.step('open a busy page in another window', async () => {
      const before = new Set(browserContext.pages());
      await callChrome(worker, 'windows.create', { focused: false, url: 'https://busy.test/' });
      const busy = await newPageAt('https://busy.test/', before);
      await expect.poll(() => busy.title(), { timeout: 15_000 }).toMatch(/^busy \d{2,}$/);
    });

    await test.step('keep reading and writing in check', async () => {
      // Every read asks for recently closed tabs once, and a busy page must not turn reading into a loop.
      const perSecond = await worker.evaluate(async () => {
        const extension = globalThis as unknown as CountingChrome;
        const counts = { reads: 0, writes: 0 };
        const sessions = extension.chrome.sessions as { getRecentlyClosed: (...args: unknown[]) => unknown };
        const bookmarks = extension.chrome.bookmarks as { update: (...args: unknown[]) => unknown };
        const read = sessions.getRecentlyClosed;
        const write = bookmarks.update;
        sessions.getRecentlyClosed = (...args) => {
          counts.reads += 1;
          return read.apply(sessions, args);
        };
        bookmarks.update = (...args) => {
          counts.writes += 1;
          return write.apply(bookmarks, args);
        };
        await new Promise((done) => setTimeout(done, 2_000));
        sessions.getRecentlyClosed = read;
        bookmarks.update = write;
        return { reads: counts.reads / 2, writes: counts.writes / 2 };
      });
      expect(perSecond.reads).toBeLessThanOrEqual(25);
      expect(perSecond.writes).toBeLessThanOrEqual(5);
    });

    await test.step('search the web from a new tab', async () => {
      const before = new Set(browserContext.pages());
      await callChrome(worker, 'tabs.create', { active: true });
      const newTab = await newPageAt(`${extensionBaseUrl(worker)}/newtab.html`, before);
      const search = newTab.getByRole('combobox', {
        name: 'Search tabs, bookmarks, history, or commands',
      });
      // Enter straight after typing, before any results can have arrived.
      await search.fill('hyper busy query');
      await search.press('Enter');

      await expect(newTab).toHaveURL(/[?&]q=hyper\+busy\+query/, { timeout: 15_000 });
    });
  }, { channel: browserChannel });
});
