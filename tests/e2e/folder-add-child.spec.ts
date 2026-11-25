import { expect, test, type Locator, type Page, type Worker } from '@playwright/test';
import { allBookmarks, bookmarkChildren, callChrome } from './helpers/chrome';
import { withHyper } from './helpers/extension';
import { createTab } from './helpers/tabs';

const pageUrl = 'https://space-race.test/folder-add-child';
const folderTitle = 'Reading';

/** Adds a folder to the only space's bookmarks root and answers both ids. */
async function createFolder(worker: Worker): Promise<{ folderId: string; rootId: string }> {
  const root = (await allBookmarks(worker)).find((node) =>
    node.title.startsWith('bookmarks {') && node.title.includes('spaceBookmarks'));
  if (!root) throw new Error('The space has no bookmarks root');
  const folder = await callChrome<{ id: string }>(worker, 'bookmarks.create', { parentId: root.id, title: folderTitle });
  return { folderId: folder.id, rootId: root.id };
}

const childUrls = async (worker: Worker, parentId: string) =>
  (await bookmarkChildren(worker, parentId)).map((child) => ({ id: child.id, url: child.url }));

const withSidebar = (run: (page: Page, worker: Worker) => Promise<void>) =>
  withHyper('folder-add-child', ({ page, worker }) => run(page, worker), {
    closeInitialPage: true,
    viewport: { width: 720, height: 900 },
  });

/**
 * The e2e harness hosts the sidebar in a tab, so the page to bookmark must be
 * made current after the pointer reaches the button, and the sidebar comes
 * back to the front only once the bookmark is in `parentId`: the background
 * bookmarks whichever tab is current when it runs the intent. A real side panel
 * stays on screen beside the current tab. Chromium does not reliably deliver
 * pointer input to a background tab, so the click is dispatched to the button.
 */
async function bookmarkCurrentPageWith(
  page: Page,
  worker: Worker,
  parentId: string,
  button: () => Locator,
) {
  await button().hover();
  await expect(button()).toBeEnabled();
  await createTab(worker, pageUrl);
  await expect(page.locator(`.tab-row [data-url="${pageUrl}"]`).first()).toBeAttached();
  await button().dispatchEvent('click');
  await expect.poll(async () => (await childUrls(worker, parentId)).map((child) => child.url))
    .toContain(pageUrl);
  await page.bringToFront();
}

test('a folder\'s inline add button bookmarks the current tab inside that folder', async () => {
  await withSidebar(async (page, worker) => {
    const { folderId } = await createFolder(worker);
    const folderRow = page.locator(`.tree-row[data-bookmark-node-id="${folderId}"]`);
    const folder = folderRow.locator('.folder-item');
    await expect(folder).toBeVisible();

    await folder.hover();
    await bookmarkCurrentPageWith(page, worker, folderId, () => page
      .getByRole('group', { name: `Create items in ${folderTitle}` })
      .getByRole('button', { name: `Bookmark current tab in ${folderTitle}` }));

    await expect.poll(() => childUrls(worker, folderId)).toEqual([
      { id: expect.any(String), url: pageUrl },
    ]);
    const [created] = await childUrls(worker, folderId);
    await expect(folder).toHaveAttribute('aria-expanded', 'true');
    const createdRow = page.locator(`.tree-row[data-bookmark-node-id="${created!.id}"]`);
    await expect(createdRow).toBeVisible();
    await expect(createdRow.locator('.bookmark-item')).toHaveAttribute('data-url', pageUrl);
    // The new row sits under its folder, one level deeper, not beside it in the root.
    await expect.poll(() => createdRow.evaluate((row) =>
      (row as HTMLElement).style.getPropertyValue('--tree-depth'))).toBe('1');
  });
});
