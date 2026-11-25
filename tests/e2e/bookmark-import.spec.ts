import { expect, test, type Locator, type Worker } from '@playwright/test';
import { callChrome, type BookmarkNode } from './helpers/chrome';
import { withHyper } from './helpers/extension';

const importedUrl = 'https://import.test/article';

async function createSourceFolder(worker: Worker): Promise<void> {
  const otherBookmarks = (await callChrome<BookmarkNode[]>(worker, 'bookmarks.getTree'))[0]?.children?.[1];
  if (!otherBookmarks) throw new Error('Other bookmarks was not created');
  const folder = await callChrome<BookmarkNode>(worker, 'bookmarks.create', { parentId: otherBookmarks.id, title: 'Reading list' });
  await callChrome(worker, 'bookmarks.create', { parentId: folder.id, title: 'Article', url: importedUrl });
}

const importedCopies = async (worker: Worker) =>
  (await callChrome<unknown[]>(worker, 'bookmarks.search', { url: importedUrl })).length;

const box = async (locator: Locator) => {
  const bounds = await locator.boundingBox();
  if (!bounds) throw new Error('The element was not measurable');
  return bounds;
};

/** Inside the list's width, with none of its text overflowing it. */
async function expectWithinList(element: Locator, list: Locator) {
  const [inner, outer, overflows] = await Promise.all([
    box(element),
    box(list),
    element.evaluate((node) => node.scrollWidth > node.clientWidth),
  ]);
  expect(inner.x).toBeGreaterThanOrEqual(outer.x - 0.5);
  expect(inner.x + inner.width).toBeLessThanOrEqual(outer.x + outer.width + 0.5);
  expect(overflows).toBe(false);
}

test('the empty bookmarks list fits the narrowest list', async () => {
  await withHyper('bookmark-empty-list', async ({ page }) => {
    const list = page.locator('.space-bookmarks-layer .tree-drop-zone');
    const message = list.getByRole('status');
    const importButton = list.getByRole('button', { name: 'Import bookmarks from another browser folder' });
    const label = importButton.locator('.empty-tree-action-label');
    await page.mouse.move(0, 0);

    // The narrowest list in the panel keeps the whole label beside the icon.
    await page.setViewportSize({ width: 150, height: 900 });
    await expect(message).toHaveText('No bookmarks found');
    await expectWithinList(message, list);
    await expectWithinList(importButton, list);
    await expectWithinList(label, list);
    await page.screenshot({ path: 'logs/bookmark-empty-list-150.png' });
  });
});

test('importing bookmarks asks for the destination space after a folder is chosen', async () => {
  await withHyper('bookmark-import', async ({ page, worker }) => {
    await page.setViewportSize({ width: 720, height: 900 });
    await expect(page.locator('.space-pagination-dot')).toHaveCount(1);
    await createSourceFolder(worker);

    await page.getByRole('button', { name: 'Open settings' }).click();
    await expect(page.locator('.settings-layer')).toHaveCSS('transform', 'none');
    await expect(page.locator('.settings-page select')).toHaveCount(0);
    const trigger = page.getByRole('button', { name: 'Import bookmarks from another browser folder' });
    await expect(trigger).toBeEnabled();

    // Cancelling the destination dialog imports nothing.
    await trigger.click();
    await page.getByRole('menuitem', { name: /Reading list/ }).click();
    let dialog = page.getByRole('dialog', { name: 'Import Reading list' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toHaveCount(0);
    expect(await importedCopies(worker)).toBe(1);

    await trigger.click();
    await page.getByRole('menuitem', { name: /Reading list/ }).click();
    dialog = page.getByRole('dialog', { name: 'Import Reading list' });
    const destination = dialog.getByRole('combobox', { name: 'Destination space' });
    const importButton = dialog.getByRole('button', { name: 'Import', exact: true });
    await expect(destination).toBeFocused();
    await expect(importButton).toBeDisabled();
    const firstSpace = await destination.locator('option:not([disabled])').first().getAttribute('value');
    if (!firstSpace) throw new Error('No destination space was offered');
    await expect(destination.getByRole('option', { name: 'Global bookmarks', exact: true })).toHaveCount(1);
    await destination.selectOption(firstSpace);
    await importButton.click();
    await expect(dialog).toHaveCount(0);
    await expect.poll(() => importedCopies(worker)).toBe(2);
  }, { closeInitialPage: true });
});
