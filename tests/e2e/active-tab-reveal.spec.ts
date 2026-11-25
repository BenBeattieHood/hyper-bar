import { expect, test, type Page, type Worker } from '@playwright/test';
import { saveHyperPreference } from './fixtures/preferences';
import { callChrome, seedHyperSpace } from './helpers/chrome';
import { openSidepanel, sidepanelUrl, withExtension } from './helpers/extension';
import { createTabs } from './helpers/tabs';

const page = (path: string) => `https://reveal.test/${path}`;

// The space's bookmarks: twenty pages, then Docs/ (Guide).
const createBookmarks = (worker: Worker) => seedHyperSpace<'docs' | 'guide'>(worker, {
  bookmarks: [
    ...Array.from({ length: 20 }, (_, index) => ({
      title: `Page ${index + 1}`,
      url: `https://reveal.test/page-${index + 1}`,
    })),
    { key: 'docs', title: 'Docs', children: [{ key: 'guide', title: 'Guide', url: page('guide') }] },
  ],
});

const backingId = async (worker: Worker, url: string) =>
  (await callChrome<Array<{ id: string; title: string }>>(worker, 'bookmarks.search', { url }))
    .find((node) => node.title.includes('"tab":true'))?.id;

/** Whether a row lies wholly inside the scrolling pane that holds it. */
const shownInPane = (sidebar: Page, rowSelector: string, paneSelector: string) => sidebar.evaluate(
  ({ pane, row }) => {
    const rowBox = document.querySelector(row)?.getBoundingClientRect();
    const paneBox = document.querySelector(pane)?.getBoundingClientRect();
    return Boolean(rowBox && paneBox && rowBox.top >= paneBox.top - 1 && rowBox.bottom <= paneBox.bottom + 1);
  },
  { pane: paneSelector, row: rowSelector },
);

test('switching to a tab shows it in the tab list and its bookmark in the bookmarks', async () => {
  await withExtension('active-tab-reveal', async ({ context, worker }) => {
    const { docs: docsId, guide: guideId } = await createBookmarks(worker);
    await saveHyperPreference(worker, 'autofolders', false);
    // Wide enough for both panes side by side, short enough that each scrolls.
    const sidebar = await openSidepanel(context, worker, { width: 800, height: 420 });
    const urls = [...Array.from({ length: 14 }, (_, index) => page(`tab-${index + 1}`)), page('guide')];
    const [sidebarTab] = await callChrome<Array<{ windowId: number }>>(worker, 'tabs.query', { url: sidepanelUrl(worker) });
    const tabIds = await createTabs(worker, urls, { active: false, windowId: sidebarTab!.windowId });
    const guideTabId = tabIds.at(-1)!;
    await expect.poll(() => backingId(worker, page('guide'))).toBeTruthy();
    const guideBackingId = (await backingId(worker, page('guide')))!;

    await sidebar.getByRole('button', { name: 'Create tab folder' }).click();
    const editor = sidebar.getByRole('dialog');
    await editor.getByLabel('Title').fill('Reading');
    await editor.getByRole('button', { name: 'Save changes' }).click();
    const reading = sidebar.locator('.tab-folder-row').filter({ hasText: 'Reading' }).locator('.folder-item');
    const readingId = await sidebar.locator('.tab-folder-row').filter({ hasText: 'Reading' })
      .getAttribute('data-tab-node-id');
    await callChrome(worker, 'bookmarks.move', guideBackingId, { parentId: readingId! });
    await expect(reading).toHaveAttribute('aria-label', 'Reading, 1 tabs');
    if (await reading.getAttribute('aria-expanded') === 'true') await reading.click();
    await expect(reading).toHaveAttribute('aria-expanded', 'false');
    const docs = sidebar.locator(`[data-bookmark-node-id="${docsId}"] .folder-item`);
    await expect(docs).toHaveAttribute('aria-expanded', 'false');
    await sidebar.evaluate(() => {
      for (const pane of document.querySelectorAll('.tabs-drop-zone, .bookmark-tree-stack')) pane.scrollTop = 0;
    });
    const guideTabRow = `.tab-row[data-tab-node-id="${guideBackingId}"]`;
    const guideBookmarkRow = `.bookmark-tree-stack .tree-row[data-bookmark-node-id="${guideId}"]`;
    expect(await shownInPane(sidebar, `.tab-folder-row[data-tab-node-id="${readingId}"]`, '.tabs-drop-zone'))
      .toBe(false);
    expect(await shownInPane(sidebar, `[data-bookmark-node-id="${docsId}"]`, '.bookmark-tree-stack'))
      .toBe(false);

    await callChrome(worker, 'tabs.update', guideTabId, { active: true });

    // The sidebar page is now a background tab, so its rows are measured rather than watched.
    await expect(reading).toHaveAttribute('aria-expanded', 'true');
    await expect(docs).toHaveAttribute('aria-expanded', 'true');
    await expect.poll(() => shownInPane(sidebar, guideTabRow, '.tabs-drop-zone')).toBe(true);
    await expect.poll(() => shownInPane(sidebar, guideBookmarkRow, '.bookmark-tree-stack')).toBe(true);
  }, { reducedMotion: 'reduce' });
});
