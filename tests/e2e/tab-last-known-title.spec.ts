import { expect, test, type Worker } from '@playwright/test';
import { localBookmarksRootId } from './fixtures/localBookmarks';
import { bookmarkTitle, callChrome, firstSpaceId } from './helpers/chrome';
import { openSidepanel, withExtension } from './helpers/extension';

const DOCS_URL = 'https://last-title.test/docs';

const tabsAt = (worker: Worker) =>
  callChrome<Array<{ id?: number; title?: string }>>(worker, 'tabs.query', { url: DOCS_URL });

test('a tab and its page bookmark keep the last known title while the page fails to load', async () => {
  await withExtension('last-known-title', async ({ context, worker }) => {
    let offline = false;
    await context.route(/https:\/\/last-title\.test\//, (route) => offline
      ? route.abort('internetdisconnected')
      : route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Docs page</title>' }));

    const panel = await openSidepanel(context, worker);
    const spaceId = await firstSpaceId(worker);
    const bookmarkId = (await callChrome<{ id: string }>(worker, 'bookmarks.create', {
      parentId: await localBookmarksRootId(worker, spaceId),
      title: 'Old words',
      url: DOCS_URL,
    })).id;
    const storedTitle = () => bookmarkTitle(worker, bookmarkId);
    const browserTitle = async () => (await tabsAt(worker))[0]?.title;

    const site = await context.newPage();
    await site.goto(DOCS_URL);
    const tabId = (await tabsAt(worker))[0]?.id;
    const title = panel
      .locator(`[data-tab-id="${tabId}"]:not([data-tab-node-id^="unsupported-tab:"]):not([data-bookmark-node-id])`)
      .locator('.tab-title');
    const bookmarkName = panel.locator(`[data-bookmark-node-id="${bookmarkId}"]`).locator('[data-item-title]');
    await expect(title).toHaveText('Docs page');
    await expect(bookmarkName).toHaveText('Docs page');
    await expect.poll(storedTitle).toBe('Docs page');

    // The browser stands in the host for a page that fails to load; Hyper keeps the name it knew.
    offline = true;
    await site.reload().catch(() => undefined);
    await expect.poll(browserTitle).toBe('last-title.test');
    // Title changes reach the backing at most once a second.
    await panel.waitForTimeout(1_500);
    await expect(title).toHaveText('Docs page');
    await expect(bookmarkName).toHaveText('Docs page');
    await expect.poll(storedTitle).toBe('Docs page');
  }, { closeInitialPage: true });
});
