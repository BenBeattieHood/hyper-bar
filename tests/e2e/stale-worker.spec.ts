import { expect, test, type BrowserContext, type Frame, type Page } from '@playwright/test';
import { cp, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { saveHyperPreference } from './fixtures/preferences';
import {
  extensionBaseUrl as baseUrl,
  extensionPath as builtExtensionPath,
  nextHyperWorker,
  onProfile,
  openExtensionsInDeveloperMode,
  openRestartedSidepanel,
  pinExtensionHost,
  withUserDataDir,
  type Profile,
} from './helpers/extension';

const buildIdPattern = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g;

/**
 * Stands in for rebuilding Hyper into the folder the browser loaded it from.
 * Pages opened afterwards read the new files, while the running worker keeps
 * the script it started with until Hyper is reloaded.
 */
async function rebuildInPlace(extensionPath: string): Promise<void> {
  const workerSource = await readFile(join(extensionPath, 'background.js'), 'utf8');
  const builtIds = [...new Set(workerSource.match(buildIdPattern))];
  expect(builtIds).toHaveLength(1);
  const builtId = builtIds[0]!;
  const rebuiltId = new Date(Date.parse(builtId) + 60_000).toISOString();
  const rewritten: string[] = [];
  for (const file of await readdir(extensionPath, { recursive: true })) {
    if (!file.endsWith('.js')) continue;
    const path = join(extensionPath, file);
    const source = await readFile(path, 'utf8');
    if (!source.includes(builtId)) continue;
    await writeFile(path, source.replaceAll(builtId, rebuiltId));
    rewritten.push(file);
  }
  // The worker and the pages' shared chunk each carry the id.
  expect(rewritten).toContain('background.js');
  expect(rewritten.length).toBeGreaterThan(1);
}

const updateNotice = (scope: Frame | Page) => scope.getByRole('alert')
  .filter({ hasText: 'Hyper was updated.' });

/** Hyper with a web page in front and no sidebar, so the page can frame Search or the in-page sidebar. */
async function launchBehindWebPage(scratch: string, profile: Profile) {
  const extensionPath = join(scratch, 'extension');
  await cp(builtExtensionPath, extensionPath, { recursive: true });
  const { context, worker } = await profile.launchExtension({ extensionPath, workerTimeout: 10_000 });
  await (await openExtensionsInDeveloperMode(context)).close();
  await context.route('https://stale-worker.test/**', (route) => route.fulfill({
    contentType: 'text/html',
    body: '<title>Stale worker test</title><label>Page editor <input aria-label="Page editor"></label>',
  }));
  const page = context.pages()[0] ?? await context.newPage();
  await page.goto('https://stale-worker.test/');
  return { context, extensionOrigin: baseUrl(worker), extensionPath, page, worker };
}

/**
 * Launches with `launch` on a profile in a fresh scratch folder, closing the
 * browser and removing the folder afterwards.
 */
async function withScratch<Launched extends { context: BrowserContext }>(
  name: string,
  launch: (scratch: string, profile: Profile) => Promise<Launched>,
  run: (launched: Launched) => Promise<void>,
): Promise<void> {
  test.setTimeout(60_000);
  await withUserDataDir(name, (scratch) =>
    onProfile(join(scratch, 'profile'), async (profile) => run(await launch(scratch, profile))));
}

test('offers to reload Hyper when its pages are newer than its running worker', async () => {
  const extensionPath = (scratch: string) => join(scratch, 'extension');
  await withScratch('stale-worker', async (scratch, profile) => {
    await cp(builtExtensionPath, extensionPath(scratch), { recursive: true });
    return {
      ...await profile.launchHyper({ closeInitialPage: true, extensionPath: extensionPath(scratch) }),
      scratch,
    };
  }, async ({ context, page: firstSidebar, scratch, worker }) => {
    const extensionBaseUrl = baseUrl(worker);
    await (await openExtensionsInDeveloperMode(context)).close();
    await expect(firstSidebar.locator('.space-pagination-dot')).toHaveCount(1);
    await expect(updateNotice(firstSidebar)).toHaveCount(0);

    await rebuildInPlace(extensionPath(scratch));
    const sidebar = await context.newPage();
    await sidebar.goto(`${extensionBaseUrl}/sidepanel.html`);
    // The newer sidebar keeps working on the older worker while it asks for the reload.
    await expect(sidebar.locator('.space-pagination-dot')).toHaveCount(1);
    await expect(updateNotice(sidebar)).toBeVisible();
    const newTab = await context.newPage();
    await newTab.goto(`${extensionBaseUrl}/newtab.html`);
    await expect(updateNotice(newTab)).toBeVisible();
    // A page from the worker's own build has nothing to reload.
    await expect(updateNotice(firstSidebar)).toHaveCount(0);

    const reloadedWorker = nextHyperWorker(context, worker, 10_000);
    // Reloading Hyper unloads the page that asked for it, which can cut the click short.
    await updateNotice(sidebar).getByRole('button', { name: 'Reload Hyper' }).click({ timeout: 5_000 })
      .catch((error: unknown) => {
        if (!sidebar.isClosed()) throw error;
      });
    const reloaded = await reloadedWorker;
    const reloadedSidebar = await openRestartedSidepanel(context, extensionBaseUrl, { timeout: 3_000 });
    await pinExtensionHost(reloaded, extensionBaseUrl);
    await expect(reloadedSidebar.locator('.space-pagination-dot')).toHaveCount(1);
    await expect(updateNotice(reloadedSidebar)).toHaveCount(0);
  });
});

test('takes page Search down before reloading Hyper from it', async () => {
  await withScratch('stale-worker-search', launchBehindWebPage, async ({ context, extensionPath, page, worker }) => {
    await rebuildInPlace(extensionPath);
    await page.bringToFront();
    await page.getByRole('textbox', { name: 'Page editor' }).focus();
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+P' : 'Control+P');
    const overlayHost = page.locator('#hyper-search-overlay-host');
    await expect(overlayHost).toHaveAttribute('data-open', 'true');
    let search: Frame | undefined;
    await expect.poll(() => {
      search = page.frames().find((frame) => frame.url().includes('mode=search-overlay'));
      return search !== undefined;
    }).toBe(true);
    await expect(updateNotice(search!)).toBeVisible();

    const reloadedWorker = nextHyperWorker(context, worker, 10_000);
    await updateNotice(search!).getByRole('button', { name: 'Reload Hyper' }).click({ timeout: 5_000 });
    await reloadedWorker;
    // The page and its content script outlive the reload, which would strand Search over it.
    await expect(overlayHost).toHaveAttribute('data-open', 'false');
  });
});

test('the in-page sidebar says to reload its page once Hyper has reloaded from it', async () => {
  await withScratch('stale-worker-in-page', launchBehindWebPage, async ({ context, extensionOrigin, extensionPath, page, worker }) => {
    await saveHyperPreference(worker, 'inPageSidebar', true);
    const host = page.locator('#hyper-in-page-sidebar-host');
    await expect(host).toHaveCount(1);
    await rebuildInPlace(extensionPath);
    const viewport = page.viewportSize();
    if (!viewport) throw new Error('The page has no viewport.');
    const mark = { x: 14 + 19, y: viewport.height - 12 - 19 };
    await page.mouse.move(mark.x, mark.y);
    let sidebar: Frame | undefined;
    await expect.poll(() => {
      sidebar = page.frames().find((frame) => frame.url().startsWith(`${extensionOrigin}/inpage.html?token=`));
      return sidebar !== undefined;
    }).toBe(true);
    await page.mouse.click(mark.x, mark.y);
    await expect(host).toHaveAttribute('data-open', 'true');
    await expect(updateNotice(sidebar!)).toBeVisible();

    const reloadedWorker = nextHyperWorker(context, worker, 10_000);
    await updateNotice(sidebar!).getByRole('button', { name: 'Reload Hyper' }).click({ timeout: 5_000 });
    await reloadedWorker;
    // The page keeps the sidebar it framed, but only a page reload connects it to the reloaded Hyper.
    const stranded = sidebar!.getByRole('alert');
    await expect(stranded).toHaveText('Reload this page to use Hyper here.');
    await expect(stranded.getByRole('button')).toHaveCount(0);
  });
});
