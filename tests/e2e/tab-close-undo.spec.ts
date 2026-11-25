import { expect, test, type Page, type Worker } from '@playwright/test';
import { saveHyperPreference } from './fixtures/preferences';
import { callChrome } from './helpers/chrome';
import { openPlainSidebar, openSidepanel, routePathTitles, withExtension } from './helpers/extension';
import { answerNotice } from './helpers/sidebar';
import { createTab, tabsUnder } from './helpers/tabs';

const page = (path: string) => `https://close.test/${path}`;

const openUrls = async (worker: Worker) => (await tabsUnder(worker, page(''))).map((tab) => tab.url).sort();

const backingId = async (worker: Worker, url: string) =>
  (await callChrome<Array<{ id: string; title: string }>>(worker, 'bookmarks.search', { url }))
    .find((node) => node.title.includes('"tab":true'))?.id;

const tabRow = (sidebar: Page, url: string) => sidebar.locator(`.tab-row:has(.tab-main[data-url="${url}"])`);

const folderRow = (sidebar: Page, title: string) =>
  sidebar.locator('.tab-folder-row').filter({ has: sidebar.locator(`.folder-item[aria-label^="${title},"]`) });

/** Hovers the folder's row and clicks its X, as a person closing the folder does. */
async function closeFolder(sidebar: Page, title: string): Promise<void> {
  const row = folderRow(sidebar, title);
  await row.hover();
  await row.getByRole('button', { name: `Close tabs in ${title}` }).click();
}

/** Hovers the tab's row and clicks its X. */
async function closeTab(sidebar: Page, url: string): Promise<void> {
  const row = tabRow(sidebar, url);
  await row.hover();
  await row.locator('.tab-close').click();
}

test('closing tabs in a row offers one undo that counts them, which reopens them all', async () => {
  await withExtension('tab-close-undo', async ({ context, worker }) => {
    await routePathTitles(context, /^https:\/\/close\.test\//, 'Page ');
    const { sidebar } = await openPlainSidebar(context, worker);
    for (const path of ['a', 'b', 'c']) await createTab(worker, page(path), { active: false });
    await expect.poll(() => backingId(worker, page('c'))).toBeTruthy();
    const status = sidebar.locator('.topbar .countdown-notice').getByRole('status');

    await closeTab(sidebar, page('a'));
    await expect(status).toHaveText('Closed tab');
    await closeTab(sidebar, page('b'));
    await expect.poll(() => openUrls(worker)).toEqual([page('c')]);

    await answerNotice(sidebar, 'Closed 2 tabs', 'Undo', 'lucide-undo-2');
    await expect.poll(() => openUrls(worker)).toEqual([page('a'), page('b'), page('c')]);
    await expect(tabRow(sidebar, page('a'))).toHaveCount(1);
    await expect(tabRow(sidebar, page('b'))).toHaveCount(1);
  });
});

test('closing a tab folder offers one undo for the folder, which brings the folder and its tabs back', async () => {
  await withExtension('tab-folder-close-undo', async ({ context, worker }) => {
    await routePathTitles(context, /^https:\/\/close\.test\//, 'Page ');
    const { sidebar } = await openPlainSidebar(context, worker);
    const backings: string[] = [];
    for (const path of ['one', 'two', 'three']) {
      await createTab(worker, page(path), { active: false });
      await expect.poll(() => backingId(worker, page(path))).toBeTruthy();
      backings.push((await backingId(worker, page(path)))!);
    }

    await sidebar.getByRole('button', { name: 'Create tab folder' }).click();
    const editor = sidebar.getByRole('dialog');
    await editor.getByLabel('Title').fill('Reading');
    await editor.getByRole('button', { name: 'Save changes' }).click();
    const folderId = await folderRow(sidebar, 'Reading').getAttribute('data-tab-node-id');
    if (!folderId) throw new Error('The tab folder has no node ID');
    for (const id of backings.slice(0, 2)) await callChrome(worker, 'bookmarks.move', id, { parentId: folderId });
    await expect(folderRow(sidebar, 'Reading').locator('.folder-item')).toHaveAttribute('aria-label', 'Reading, 2 tabs');

    await closeFolder(sidebar, 'Reading');
    await expect.poll(() => openUrls(worker)).toEqual([page('three')]);

    await answerNotice(sidebar, 'Closed folder', 'Undo', 'lucide-undo-2');
    await expect.poll(() => openUrls(worker)).toEqual([page('one'), page('three'), page('two')].sort());
    await expect(folderRow(sidebar, 'Reading').locator('.folder-item')).toHaveAttribute('aria-label', 'Reading, 2 tabs');
  });
});

test('closing an autofolder offers one undo for the folder, which reopens its tabs', async () => {
  await withExtension('autofolder-close-undo', async ({ context, worker }) => {
    await routePathTitles(context, /^https:\/\/close\.test\//, 'Page ');
    await saveHyperPreference(worker, 'autofolders', true);
    const sidebar = await openSidepanel(context, worker, { width: 720, height: 900 });
    for (const path of ['x', 'y']) await createTab(worker, page(path), { active: false });
    await expect.poll(() => backingId(worker, page('y'))).toBeTruthy();
    await expect(folderRow(sidebar, 'close.test').locator('.folder-item')).toHaveAttribute('aria-label', 'close.test, 2 tabs');

    await closeFolder(sidebar, 'close.test');
    await expect.poll(() => openUrls(worker)).toEqual([]);

    await answerNotice(sidebar, 'Closed folder', 'Undo', 'lucide-undo-2');
    await expect.poll(() => openUrls(worker)).toEqual([page('x'), page('y')]);
    await expect(folderRow(sidebar, 'close.test').locator('.folder-item')).toHaveAttribute('aria-label', 'close.test, 2 tabs');
  });
});
