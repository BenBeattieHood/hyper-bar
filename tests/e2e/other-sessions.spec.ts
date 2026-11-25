import { expect, test, type Locator, type Page, type Worker } from '@playwright/test';
import { parseBookmarkTitle, serializeBookmarkTitle } from '../../entrypoints/lib/bookmarks';
import { saveHyperPreference } from './fixtures/preferences';
import {
  allBookmarks,
  bookmarkChildren,
  callChrome,
  type BookmarkNode,
} from './helpers/chrome';
import { openSidepanel, routeHtml, withExtension } from './helpers/extension';
import { liftTabRow } from './helpers/sidebar';
import { createTab, openTabUrls } from './helpers/tabs';

const page = (path: string) => `https://sessions.test/${path}`;

/**
 * Opens the sidebar with sites under `routes` answering, then this window's tab
 * on `page('here')`, and runs `run` once that tab has its backing.
 */
async function withSessions(
  name: string,
  routes: readonly string[],
  run: (session: { sidebar: Page; worker: Worker }) => Promise<void>,
): Promise<void> {
  await withExtension(name, async ({ context, worker }) => {
    for (const site of routes) {
      await routeHtml(context, site, '<!doctype html><title>Session page</title>');
    }
    const sidebar = await openSidepanel(
      context, worker, { width: 720, height: 900 }, { waitUntil: 'domcontentloaded' },
    );
    await createTab(worker, page('here'));
    await run({ sidebar, worker });
  }, { closeInitialPage: true });
}

/** Lists the pages another installation's session shows, in order. */
const sessionPagesIn = (session: Locator) => session
  .locator('.session-tab-row .tab-main')
  .evaluateAll((mains) => mains.map((main) => main.getAttribute('data-url')));

interface StoredBacking {
  id: string;
  parentId?: string;
  title: string;
  url?: string;
}

async function tabBackings(worker: Worker): Promise<StoredBacking[]> {
  return (await allBookmarks(worker)).flatMap(({ id, parentId, title, url }) =>
    url && title.includes('"tab":true') ? [{ id, parentId, title, url }] : []);
}

const installationOf = (backing: StoredBacking) =>
  (parseBookmarkTitle(backing.title).metadata.hyper as { installationId?: string }).installationId;

/** Which installations keep each page, in the order the bookmarks hold them. */
async function sessionsByPage(worker: Worker): Promise<Record<string, Array<string | undefined>>> {
  const pages: Record<string, Array<string | undefined>> = {};
  for (const backing of await tabBackings(worker)) {
    (pages[backing.url ?? ''] ??= []).push(installationOf(backing));
  }
  return pages;
}

/** Keeps a page for another installation, parked beside this one's backing of `template`. */
async function keepForSession(
  worker: Worker,
  template: string,
  url: string,
  installationId: string,
): Promise<void> {
  const source = (await tabBackings(worker)).find((backing) => backing.url === template);
  if (!source?.parentId) throw new Error('The template backing was not found.');
  const parsed = parseBookmarkTitle(source.title);
  const hyper = parsed.metadata.hyper as Record<string, unknown>;
  const title = serializeBookmarkTitle(url.slice(url.lastIndexOf('/') + 1), {
    ...parsed.metadata,
    hyper: { ...hyper, installationId, tabToken: `${installationId}:${url}`, windowId: undefined },
  });
  await callChrome(worker, 'bookmarks.create', { parentId: source.parentId, title, url });
}



async function dropOn(sidebar: Page, target: Locator, copy = false, fromTop = 0.5): Promise<void> {
  const box = await target.boundingBox();
  if (!box) throw new Error('The drop target had no geometry');
  if (copy) await sidebar.keyboard.down('Control');
  await sidebar.mouse.move(box.x + box.width / 2, box.y + box.height * fromTop, { steps: 8 });
  if (await target.evaluate((element) => element.classList.contains('other-session'))) {
    await expect(target).toHaveClass(/is-over/);
  }
  await sidebar.mouse.up();
  if (copy) await sidebar.keyboard.up('Control');
}

test('tabs other sessions keep show per session, and drag between sessions to move, or with Ctrl to copy', async () => {
  await withSessions('other-sessions', ['https://sessions.test/**'], async ({ sidebar, worker }) => {
    const localRow = (path: string) => sidebar.locator(
      `.tabs-list .tab-row:not(.session-tab-row):has(.tab-main[data-url="${page(path)}"])`,
    );
    await expect(localRow('here')).toHaveCount(1);
    await expect.poll(async () => (await sessionsByPage(worker))[page('here')]?.length).toBe(1);
    const local = installationOf((await tabBackings(worker)).find((backing) => backing.url === page('here'))!);
    expect(local).toBeTruthy();
    await keepForSession(worker, page('here'), page('laptop-a'), 'laptop');
    await keepForSession(worker, page('here'), page('laptop-b'), 'laptop');
    await keepForSession(worker, page('here'), page('desktop-a'), 'desktop');

    // Off by default; the toggle sits at the top of the history menu.
    await expect(sidebar.locator('.other-sessions')).toHaveCount(0);
    await sidebar.getByRole('button', { name: 'Show recent tabs' }).first().click();
    const toggle = sidebar.getByRole('menuitemcheckbox', { name: 'Show tabs from other sessions' });
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await toggle.click();
    const session = (installationId: string) =>
      sidebar.locator(`.other-session[data-installation-id="${installationId}"]`);
    const sessionRow = (installationId: string, path: string) =>
      session(installationId).locator(`.session-tab-row:has(.tab-main[data-url="${page(path)}"])`);
    const sessionPages = (installationId: string) => sessionPagesIn(session(installationId));
    await expect(sidebar.locator('.other-session')).toHaveCount(2);
    await expect.poll(() => sessionPages('laptop')).toEqual([page('laptop-a'), page('laptop-b')]);
    await expect.poll(() => sessionPages('desktop')).toEqual([page('desktop-a')]);
    await expect(sidebar.locator(`.other-session[data-installation-id="${local}"]`)).toHaveCount(0);

    // Another session's tab dragged into this window's tabs opens here, and leaves that session.
    await liftTabRow(sidebar, sessionRow('laptop', 'laptop-a'));
    await dropOn(sidebar, localRow('here'), false, 0.85);
    await expect(localRow('laptop-a')).toHaveCount(1);
    await expect.poll(() => openTabUrls(worker)).toContain(page('laptop-a'));
    await expect.poll(async () => (await sessionsByPage(worker))[page('laptop-a')]).toEqual([local]);
    await expect.poll(() => sessionPages('laptop')).toEqual([page('laptop-b')]);

    // Ctrl copies this window's tab to another session and keeps it open here.
    await liftTabRow(sidebar, localRow('here'));
    await dropOn(sidebar, session('desktop'), true);
    await expect.poll(async () => (await sessionsByPage(worker))[page('here')]?.sort())
      .toEqual(['desktop', local].sort());
    await expect.poll(async () => (await sessionPages('desktop')).sort())
      .toEqual([page('desktop-a'), page('here')]);
    await expect(localRow('here')).toHaveCount(1);

    // Moving this window's tab to another session closes it here.
    await liftTabRow(sidebar, localRow('laptop-a'));
    await dropOn(sidebar, session('laptop'));
    await expect.poll(() => openTabUrls(worker)).not.toContain(page('laptop-a'));
    await expect.poll(async () => (await sessionsByPage(worker))[page('laptop-a')]).toEqual(['laptop']);
    await expect.poll(async () => (await sessionPages('laptop')).sort())
      .toEqual([page('laptop-a'), page('laptop-b')]);

    // A tab moves from one other session to another.
    await liftTabRow(sidebar, sessionRow('laptop', 'laptop-b'));
    await dropOn(sidebar, session('desktop'));
    await expect.poll(async () => (await sessionsByPage(worker))[page('laptop-b')]).toEqual(['desktop']);
    await expect.poll(() => sessionPages('laptop')).toEqual([page('laptop-a')]);
    await expect.poll(async () => (await sessionPages('desktop')).sort())
      .toEqual([page('desktop-a'), page('here'), page('laptop-b')]);

    // A click opens another session's tab here as well, leaving that session's.
    await sessionRow('desktop', 'desktop-a').locator('.tab-main').click();
    await expect(localRow('desktop-a')).toHaveCount(1);
    await expect.poll(async () => (await sessionsByPage(worker))[page('desktop-a')]?.sort())
      .toEqual(['desktop', local].sort());

    // Hidden again from the same menu.
    await sidebar.getByRole('button', { name: 'Show recent tabs' }).first().click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await toggle.click();
    await expect(sidebar.locator('.other-sessions')).toHaveCount(0);
  });
});

test('other sessions gather their tabs into autofolders while autofolders are on', async () => {
  await withSessions('session-autofolders', ['https://sessions.test/**', 'https://other.test/**'], async ({ sidebar, worker }) => {
    await expect.poll(async () => (await sessionsByPage(worker))[page('here')]?.length).toBe(1);
    const elsewhere = 'https://other.test/b';
    await keepForSession(worker, page('here'), page('a'), 'laptop');
    await keepForSession(worker, page('here'), elsewhere, 'laptop');
    await keepForSession(worker, page('here'), page('c'), 'laptop');
    await saveHyperPreference(worker, 'showOtherSessions', true);
    const laptop = sidebar.locator('.other-session[data-installation-id="laptop"]');
    const laptopPages = () => sessionPagesIn(laptop);
    await expect.poll(laptopPages).toEqual([page('a'), elsewhere, page('c')]);
    await expect(laptop.locator('.session-folder-row')).toHaveCount(0);

    // Each site's tabs gather in a folder, as this window's do.
    await saveHyperPreference(worker, 'autofolders', true);
    const sessionsFolder = laptop.getByRole('button', { name: 'sessions.test, 2 tabs' });
    await expect(sessionsFolder).toHaveAttribute('aria-expanded', 'true');
    await expect(laptop.getByRole('button', { name: 'other.test, 1 tabs' })).toBeVisible();
    await expect.poll(laptopPages).toEqual([page('a'), page('c'), elsewhere]);
    await expect(laptop.locator('.session-tab-row .tree-depth-guides')).toHaveCount(3);

    // A folder folds shut, counting its tabs, and opens again.
    await sessionsFolder.click();
    await expect(sessionsFolder).toHaveAttribute('aria-expanded', 'false');
    await expect(sessionsFolder.locator('.folder-count')).toHaveText('2');
    await expect.poll(laptopPages).toEqual([elsewhere]);
    await sessionsFolder.click();
    await expect.poll(laptopPages).toEqual([page('a'), page('c'), elsewhere]);

    // A tab still drags out of its folder into this window's tabs.
    await liftTabRow(sidebar, laptop.locator(`.session-tab-row:has(.tab-main[data-url="${page('c')}"])`));
    await dropOn(
      sidebar,
      sidebar.locator(`.tabs-list .tab-row:not(.session-tab-row):has(.tab-main[data-url="${page('here')}"])`),
      false,
      0.85,
    );
    await expect.poll(() => openTabUrls(worker)).toContain(page('c'));
    await expect.poll(laptopPages).toEqual([page('a'), elsewhere]);

    await saveHyperPreference(worker, 'autofolders', false);
    await expect(laptop.locator('.session-folder-row')).toHaveCount(0);
    await expect.poll(laptopPages).toEqual([page('a'), elsewhere]);
  });
});

/** A folder in the space's bookmarks, for pasting into. */
async function createSpaceBookmarkFolder(worker: Worker, title: string): Promise<string> {
  const root = (await allBookmarks(worker))
    .find((node) => !node.url && node.title.includes('"spaceBookmarks":true'));
  if (!root) throw new Error('The space has no bookmarks folder');
  return (await callChrome<BookmarkNode>(worker, 'bookmarks.create', { parentId: root.id, title })).id;
}

const bookmarkUrls = async (worker: Worker, parentId: string) =>
  (await bookmarkChildren(worker, parentId)).map((child) => child.url);

test('other sessions\u2019 tabs select, copy into bookmarks, cut and paste between sessions, and close', async () => {
  await withSessions('session-clipboard', ['https://sessions.test/**'], async ({ sidebar, worker }) => {
    await expect.poll(async () => (await sessionsByPage(worker))[page('here')]?.length).toBe(1);
    await keepForSession(worker, page('here'), page('a'), 'laptop');
    await keepForSession(worker, page('here'), page('b'), 'laptop');
    await keepForSession(worker, page('here'), page('c'), 'desktop');
    const readingId = await createSpaceBookmarkFolder(worker, 'Reading');
    await saveHyperPreference(worker, 'showOtherSessions', true);
    const session = (installationId: string) =>
      sidebar.locator(`.other-session[data-installation-id="${installationId}"]`);
    const sessionMain = (installationId: string, path: string) => session(installationId)
      .locator(`.session-tab-row .tab-main[data-url="${page(path)}"]`);
    const sessionPages = (installationId: string) => sessionPagesIn(session(installationId));
    await expect.poll(() => sessionPages('laptop')).toEqual([page('a'), page('b')]);
    const showView = async (name: 'Bookmarks' | 'Tabs') => {
      const tab = sidebar.getByRole('tab', { name });
      if (await tab.isVisible()) await tab.click();
    };

    // Ctrl or Cmd selects several, and the menu acts on them all; what cannot reach another device says why.
    await sessionMain('laptop', 'a').click({ modifiers: ['ControlOrMeta'] });
    await sessionMain('laptop', 'b').click({ modifiers: ['ControlOrMeta'] });
    await expect(sessionMain('laptop', 'a')).toHaveAttribute('aria-selected', 'true');
    await expect(sessionMain('laptop', 'b')).toHaveAttribute('aria-selected', 'true');
    await sessionMain('laptop', 'a').click({ button: 'right' });
    const menu = sidebar.getByRole('menu', { name: 'Actions for a' });
    const reload = menu.getByRole('menuitem', { name: /^Reload 2 tabs/ });
    await expect(reload).toHaveAttribute('aria-disabled', 'true');
    await expect(reload).toHaveAttribute('title', /cannot reach/);
    await expect(menu.getByRole('menuitem', { name: /^Close 2 tabs/ })).toHaveAttribute('title', /every device/);
    await menu.getByRole('menuitem', { name: /^Copy 2 items/ }).click();
    await expect(menu).toHaveCount(0);

    // Pasting the copy on a bookmark folder bookmarks both pages, and the session keeps its tabs.
    await showView('Bookmarks');
    await sidebar.locator(`[data-bookmark-node-id="${readingId}"] .tree-item-main`).first().focus();
    await sidebar.keyboard.press('ControlOrMeta+V');
    await expect.poll(() => bookmarkUrls(worker, readingId)).toEqual([page('a'), page('b')]);
    await showView('Tabs');
    await expect.poll(() => sessionPages('laptop')).toEqual([page('a'), page('b')]);

    // Cut from one session and pasted on another's heading, a tab changes hands.
    await sessionMain('laptop', 'b').click({ modifiers: ['ControlOrMeta'] });
    await expect(sessionMain('laptop', 'b')).toHaveAttribute('aria-selected', 'false');
    await sessionMain('laptop', 'a').focus();
    await sidebar.keyboard.press('ControlOrMeta+X');
    await session('desktop').locator('.other-session-label').click({ button: 'right' });
    await sidebar.getByRole('menuitem', { name: /^Paste/ }).click();
    await expect.poll(async () => (await sessionsByPage(worker))[page('a')]).toEqual(['desktop']);
    await expect.poll(() => sessionPages('desktop')).toEqual(expect.arrayContaining([page('a'), page('c')]));
    await expect.poll(() => sessionPages('laptop')).toEqual([page('b')]);

    // Closing forgets the tab everywhere, and Undo brings it back.
    await sessionMain('laptop', 'b').hover();
    await session('laptop').getByRole('button', { name: 'Close b' }).click();
    await expect.poll(async () => (await sessionsByPage(worker))[page('b')]).toBeUndefined();
    const notices = sidebar.locator('.topbar .countdown-notice');
    await expect(notices.getByRole('status')).toContainText('Closed tab');
    await notices.getByRole('button', { name: 'Undo' }).click();
    await expect.poll(async () => (await sessionsByPage(worker))[page('b')]).toEqual(['laptop']);
    await expect.poll(() => sessionPages('laptop')).toEqual([page('b')]);
  });
});
