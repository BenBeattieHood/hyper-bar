import { expect, test, type BrowserContext, type Locator, type Worker } from '@playwright/test';
import { localBookmarksRootId } from './fixtures/localBookmarks';
import { bookmarkTitle as storedTitle, callChrome, firstSpaceId } from './helpers/chrome';
import { openSidepanel, withExtension } from './helpers/extension';
import { dragWithPointer } from './helpers/sidebar';
import { createTab } from './helpers/tabs';
import { tabRowSelector } from './helpers/rows';

const DOCS_URL = 'https://names.test/docs';

const navigate = (worker: Worker, tabId: number, url: string) =>
  callChrome(worker, 'tabs.update', tabId, { url });

// An extension-created tab's first load bypasses context.route, so its title stays the address.
const openTab = (worker: Worker, url: string) => createTab(worker, url, { active: false });

/** A sidebar beside a space holding one bookmark the user named "Team docs". */
function withNamesFixture(name: string, run: (fixture: NamesFixture) => Promise<void>) {
  return withExtension(name, async (session) => run(await openNamesFixture(session)), { closeInitialPage: true });
}

type NamesFixture = Awaited<ReturnType<typeof openNamesFixture>>;

async function openNamesFixture({ context, worker }: { context: BrowserContext; worker: Worker }) {
  const titles: Record<string, string> = {
    'https://elsewhere.test/': 'Elsewhere page',
    [DOCS_URL]: 'Docs page',
    'https://names.test/other': 'Other page',
  };
  await context.route(/https:\/\/(names|elsewhere)\.test\//, (route) => route.fulfill({
    contentType: 'text/html',
    body: `<!doctype html><title>${titles[route.request().url()] ?? 'Page'}</title>`,
  }));
  const page = await openSidepanel(context, worker, { width: 900, height: 900 });
  const rootId = await localBookmarksRootId(worker, await firstSpaceId(worker));
  const bookmarkId = (await callChrome<{ id: string }>(worker, 'bookmarks.create', {
    parentId: rootId,
    title: 'Team docs {"isCustomName":true}',
    url: DOCS_URL,
  })).id;
  const bookmarkTitle = () => storedTitle(worker, bookmarkId);
  const tabRow = (tabId: number) =>
    page.locator(tabRowSelector(tabId));
  /** Renaming asks for a deliberate second click on the title, after the first focuses the item. */
  const startRenaming = async (title: Locator, focused: () => Promise<void>) => {
    const click = async () => {
      const bounds = await title.boundingBox();
      if (!bounds) throw new Error('The title was not measurable.');
      await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    };
    await click();
    await focused();
    await page.waitForTimeout(250);
    await click();
  };
  return { bookmarkId, bookmarkTitle, page, startRenaming, tabRow, worker };
}

test('a tab and its bookmark share the name the user gave either', async () => {
  await withNamesFixture('tab-bookmark-names', async ({ bookmarkTitle, page, startRenaming, tabRow, worker }) => {
    // A tab that reaches the bookmark's page by itself links to it, with a moment to undo.
    const tabId = await openTab(worker, DOCS_URL);
    const row = tabRow(tabId);
    const title = row.locator('.tab-title');
    const linkNotice = page.getByRole('status').filter({ hasText: 'Linked to bookmark' });
    await expect(title).toHaveText('Team docs');
    await expect(linkNotice).toBeVisible();
    await expect(page.getByRole('button', { name: 'No, cancel it' }).locator('svg.lucide-x')).toBeVisible();
    await expect(row.locator('.tab-bookmark-indicator.is-remove')).toBeVisible();
    await expect(linkNotice).toHaveCount(0, { timeout: 10_000 });

    // Within the bookmark's domain the tab keeps its name, marked as drifted.
    await navigate(worker, tabId, 'https://names.test/other');
    await expect(title).toHaveText('Team docs*');
    await expect(row.locator('.tab-bookmark-indicator.is-update')).toBeVisible();

    // Renaming the tab renames its bookmark.
    await startRenaming(title, () => expect(row).toHaveClass(/is-active/));
    const input = row.locator('input.tab-title');
    await expect(input).toHaveValue('Team docs');
    await input.fill('Handbook');
    await input.press('Enter');
    await expect.poll(bookmarkTitle).toBe('Handbook {"isCustomName":true}');
    await expect(title).toHaveText('Handbook*');

    // Another site ends the link and the name.
    await navigate(worker, tabId, 'https://elsewhere.test/');
    await expect(title).toHaveText('Elsewhere page');
    await expect(row.locator('.tab-bookmark-indicator.is-create')).toBeVisible();

    // Undoing a fresh link drops the bookmark's name and offers the bookmark again.
    const secondRow = tabRow(await openTab(worker, DOCS_URL));
    await expect(secondRow.locator('.tab-title')).toHaveText('Handbook');
    await expect(linkNotice).toBeVisible();
    await page.getByRole('button', { name: 'No, cancel it' }).click();
    await expect(secondRow.locator('.tab-title')).not.toHaveText('Handbook');
    await expect(secondRow.locator('.tab-bookmark-indicator.is-create')).toBeVisible();
    await expect(linkNotice).toHaveCount(0);
  });
});

test('clearing a name returns a tab or bookmark to its page title', async () => {
  await withNamesFixture('tab-bookmark-blank-names', async ({ bookmarkId, bookmarkTitle, page, startRenaming, tabRow, worker }) => {
    const tabId = await openTab(worker, DOCS_URL);
    const row = tabRow(tabId);
    const title = row.locator('.tab-title');
    await expect(title).toHaveText('Team docs');
    await navigate(worker, tabId, 'https://names.test/other');
    await expect(title).toHaveText('Team docs*');

    // A cleared tab name shows the tab's page title; its bookmark's page is not open to title it yet.
    await startRenaming(title, () => expect(row).toHaveClass(/is-active/));
    await row.locator('input.tab-title').fill('');
    await row.locator('input.tab-title').press('Enter');
    await expect(title).toHaveText('Other page');
    await expect.poll(bookmarkTitle).toBe('Team docs');

    // Once a tab shows the bookmark's page, clearing the bookmark's name takes that page's title.
    await callChrome(worker, 'bookmarks.update', bookmarkId, { title: 'Handbook {"isCustomName":true}' });
    await navigate(worker, tabId, DOCS_URL);
    await expect(title).toHaveText('Handbook');
    const bookmarkRow = page.locator(`[data-bookmark-node-id="${bookmarkId}"]`);
    const bookmarkName = bookmarkRow.locator('.tree-title');
    await expect(bookmarkName).toHaveText('Handbook');
    await startRenaming(bookmarkName, () => expect(bookmarkRow).toHaveClass(/is-foremost/));
    await bookmarkRow.locator('input.tree-title').fill('');
    await bookmarkRow.locator('input.tree-title').press('Enter');
    await expect.poll(bookmarkTitle).toBe('Docs page');
    await expect(bookmarkName).toHaveText('Docs page');
    await expect(title).toHaveText('Docs page');
  });
});

test('opening a bookmark unlinks a tab that drifted from it', async () => {
  await withNamesFixture('tab-bookmark-claims', async ({ bookmarkId, page, tabRow, worker }) => {
    const tabId = await openTab(worker, DOCS_URL);
    const row = tabRow(tabId);
    const title = row.locator('.tab-title');
    await expect(title).toHaveText('Team docs');
    await navigate(worker, tabId, 'https://names.test/other');
    await expect(title).toHaveText('Team docs*');

    // The bookmark opens its own page in a new tab, a better match than the tab that drifted.
    await page.locator(`[data-bookmark-node-id="${bookmarkId}"] .tree-item-main`).click();
    await expect(page.locator('.tab-title').filter({ hasText: /^Team docs$/ })).toHaveCount(1);
    await expect(title).toHaveText('Other page');
    await expect(row.locator('.tab-bookmark-indicator.is-create')).toBeVisible();
  });
});

test('a tab dropped into bookmarks keeps the name the user gave it', async () => {
  await withNamesFixture('tab-bookmark-drop-names', async ({ page, startRenaming, tabRow, worker }) => {
    const bookmarkTitlesAt = async (url: string) =>
      (await callChrome<Array<{ title: string }>>(worker, 'bookmarks.search', { url })).map(({ title }) => title).sort();
    const globalButton = page.getByRole('button', { name: 'Global bookmarks' });

    // A tab the user named itself.
    const ownId = await openTab(worker, 'https://elsewhere.test/');
    const own = tabRow(ownId);
    const ownTitle = own.locator('.tab-title');
    await expect(ownTitle).toHaveText(/Elsewhere page|elsewhere\.test/);
    await startRenaming(ownTitle, () => expect(own).toHaveClass(/is-active/));
    await own.locator('input.tab-title').fill('My reading');
    await own.locator('input.tab-title').press('Enter');
    await expect(ownTitle).toHaveText('My reading');
    await dragWithPointer(page, own, globalButton);
    await expect.poll(() => bookmarkTitlesAt('https://elsewhere.test/'))
      .toContainEqual(expect.stringMatching(/^My reading \{.*"isCustomName":true/));
    await expect(ownTitle).toHaveText('My reading');

    // A tab named by the bookmark it is linked to.
    const linkedId = await openTab(worker, DOCS_URL);
    const linked = tabRow(linkedId);
    await expect(linked.locator('.tab-title')).toHaveText('Team docs');
    await dragWithPointer(page, linked, globalButton);
    // Tab backings are bookmarks too, so the space's bookmark and the global copy are two of three.
    await expect.poll(async () => (await bookmarkTitlesAt(DOCS_URL)).filter(
      (title) => title === 'Team docs {"isCustomName":true}',
    )).toHaveLength(2);
    await expect(linked.locator('.tab-title')).toHaveText('Team docs');
  });
});
