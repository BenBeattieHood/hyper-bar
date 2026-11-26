import { expect, test, type Worker } from '@playwright/test';
import { callChrome } from './helpers/chrome';
import { openPlainSidebar, withExtension } from './helpers/extension';
import { pressAndPull } from './helpers/sidebar';
import { createTab } from './helpers/tabs';

const page = (path: string) => `https://folders.test/${path}`;

const backingId = async (worker: Worker, url: string) =>
  (await callChrome<Array<{ id: string; title: string }>>(worker, 'bookmarks.search', { url }))
    .find((node) => node.title.includes('"tab":true'))?.id;

const parentOf = async (worker: Worker, id: string) =>
  (await callChrome<Array<{ parentId?: string }>>(worker, 'bookmarks.get', id).catch(() => []))[0]?.parentId ?? null;

test('dropping a tab folder on the bin closes its tabs here and keeps the rest', async () => {
  await withExtension('tab-folder-trash', async ({ context, worker }) => {
    const { sidebar, windowId } = await openPlainSidebar(context, worker);

    // Two tabs in this window, and one in another window showing the same space.
    for (const url of [page('one'), page('two')]) await createTab(worker, url, { active: false, windowId });
    await callChrome(worker, 'windows.create', { focused: false, url: page('three') });
    const backings = { one: '', three: '', two: '' };
    for (const path of ['one', 'two', 'three'] as const) {
      await expect.poll(() => backingId(worker, page(path))).toBeTruthy();
      backings[path] = (await backingId(worker, page(path)))!;
    }

    await sidebar.getByRole('button', { name: 'Create tab folder' }).click();
    const editor = sidebar.getByRole('dialog');
    await editor.getByLabel('Title').fill('Reading');
    await editor.getByRole('button', { name: 'Save changes' }).click();
    const folderRow = sidebar.locator('.tab-folder-row').filter({ hasText: 'Reading' });
    const folderId = await folderRow.getAttribute('data-tab-node-id');
    if (!folderId) throw new Error('The tab folder has no node ID');
    const tabsRootId = await parentOf(worker, folderId);
    for (const id of Object.values(backings)) await callChrome(worker, 'bookmarks.move', id, { parentId: folderId });
    const folder = folderRow.locator('.folder-item');
    await expect(folder).toHaveAttribute('aria-label', 'Reading, 2 tabs');

    await expect(folderRow.locator('xpath=ancestor::li[1]')).toHaveCSS('opacity', '1');
    await pressAndPull(sidebar, folder, 3, -12);
    const trash = sidebar.locator('.space-pagination-trash-target');
    await expect(trash).toBeVisible();
    const trashBox = (await trash.boundingBox())!;
    await sidebar.mouse.move(trashBox.x + trashBox.width / 2, trashBox.y + trashBox.height / 2, { steps: 8 });
    await expect(trash).toHaveClass(/is-over/);
    await sidebar.mouse.up();

    await expect(folderRow).toHaveCount(0);
    await expect.poll(() => parentOf(worker, folderId)).toBeNull();
    const openUrls = async () => (await callChrome<Array<{ url?: string }>>(worker, 'tabs.query', {}))
      .flatMap((tab) => tab.url?.startsWith('https://folders.test/') ? [tab.url] : []).sort();
    await expect.poll(openUrls).toEqual([page('three')]);
    // The other window's tab is not this window's to close: it moves to where the folder was.
    expect(await parentOf(worker, backings.three)).toBe(tabsRootId);
  });
});
