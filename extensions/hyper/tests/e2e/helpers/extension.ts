import {
  chromium,
  expect,
  type BrowserContext,
  type Frame,
  type Page,
  type Worker,
} from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { saveHyperPreference } from '../fixtures/preferences';
import { allBookmarks, callChrome } from './chrome';

export const extensionPath = resolve(process.env.HYPER_EXTENSION_PATH ?? 'output/chrome-mv3-e2e');

type LaunchOptions = NonNullable<Parameters<typeof chromium.launchPersistentContext>[1]>;
type GotoOptions = Parameters<Page['goto']>[1];
type RouteUrl = Parameters<BrowserContext['route']>[0];
type Viewport = { height: number; width: number };

export interface ExtensionSession {
  context: BrowserContext;
  worker: Worker;
}

export interface HyperSession extends ExtensionSession {
  page: Page;
}

export interface ExtensionLaunchOptions extends Omit<LaunchOptions, 'args'> {
  /** Arguments after the ones that load the extensions. */
  args?: string[];
  closeInitialPage?: boolean;
  /** Loads Hyper from this folder instead of the end-to-end build. */
  extensionPath?: string;
  /** Further unpacked extensions loaded beside Hyper. */
  extraExtensionPaths?: string[];
  /** How long to wait for Hyper's worker, instead of the action timeout. */
  workerTimeout?: number;
}

const isHyperWorker = (worker: Worker) => worker.url().endsWith('/background.js');

/** Starts a plain headless Chromium with Hyper loaded, and its service worker. */
export async function launchExtension(
  userDataDir: string,
  {
    args = [],
    channel = 'chromium',
    closeInitialPage = false,
    extensionPath: hyperPath = extensionPath,
    extraExtensionPaths = [],
    workerTimeout,
    ...options
  }: ExtensionLaunchOptions = {},
): Promise<ExtensionSession> {
  const extensions = [hyperPath, ...extraExtensionPaths].join(',');
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel,
    headless: true,
    ...options,
    args: [
      `--disable-extensions-except=${extensions}`,
      `--load-extension=${extensions}`,
      ...args,
    ],
  });
  if (closeInitialPage) await context.pages()[0]?.close();
  const worker = context.serviceWorkers().find(isHyperWorker) ??
    await context.waitForEvent('serviceworker', {
      predicate: isHyperWorker,
      ...(workerTimeout === undefined ? {} : { timeout: workerTimeout }),
    });
  return { context, worker };
}

export interface HyperLaunchOptions extends ExtensionLaunchOptions {
  enableAudio?: boolean;
  restoreLastSession?: boolean;
  viewport?: Viewport;
}

/**
 * Starts Chromium (or `HYPER_E2E_CHANNEL`, headed) with Hyper and the
 * space-race fixture pages, and opens the sidebar in a pinned tab once Hyper
 * has built a space's bookmarks root.
 */
export async function launchHyper(
  userDataDir: string,
  { args = [], enableAudio = false, restoreLastSession = false, viewport, ...options }: HyperLaunchOptions = {},
): Promise<HyperSession> {
  const { context, worker } = await launchExtension(userDataDir, {
    channel: process.env.HYPER_E2E_CHANNEL ?? 'chromium',
    headless: !process.env.HYPER_E2E_CHANNEL,
    ...(enableAudio ? { ignoreDefaultArgs: ['--mute-audio'] } : {}),
    ...options,
    args: [...(restoreLastSession ? ['--restore-last-session'] : []), ...args],
  });
  await context.route('https://space-race.test/**', (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/redirect-to-one') {
      return route.fulfill({
        status: 302,
        headers: { location: 'https://space-race.test/one' },
      });
    }
    return route.fulfill({
      contentType: 'text/html',
      body: url.pathname === '/audible'
        ? [
          '<!doctype html><title>Audible space fixture</title>',
          '<button id="start-audio">Start audio</button>',
          '<audio loop></audio>',
          '<script>',
          'document.querySelector("#start-audio").addEventListener("click", async () => {',
          '  const sampleRate = 8000;',
          '  const samples = sampleRate;',
          '  const buffer = new ArrayBuffer(44 + samples * 2);',
          '  const view = new DataView(buffer);',
          '  const write = (offset, value) => {',
          '    for (let index = 0; index < value.length; index += 1) {',
          '      view.setUint8(offset + index, value.charCodeAt(index));',
          '    }',
          '  };',
          '  write(0, "RIFF");',
          '  view.setUint32(4, 36 + samples * 2, true);',
          '  write(8, "WAVEfmt ");',
          '  view.setUint32(16, 16, true);',
          '  view.setUint16(20, 1, true);',
          '  view.setUint16(22, 1, true);',
          '  view.setUint32(24, sampleRate, true);',
          '  view.setUint32(28, sampleRate * 2, true);',
          '  view.setUint16(32, 2, true);',
          '  view.setUint16(34, 16, true);',
          '  write(36, "data");',
          '  view.setUint32(40, samples * 2, true);',
          '  for (let index = 0; index < samples; index += 1) {',
          '    view.setInt16(44 + index * 2, Math.sin(index * Math.PI * 0.11) * 12000, true);',
          '  }',
          '  const audio = document.querySelector("audio");',
          '  audio.src = URL.createObjectURL(new Blob([buffer], { type: "audio/wav" }));',
          '  await audio.play();',
          '  globalThis.hyperAudioFixture = { audio, buffer };',
          '});',
          '</script>',
        ].join('')
        : url.pathname === '/settles-elsewhere'
        ? '<!doctype html><title>Settling</title><script>setTimeout(() => location.replace("/settled"), 300)</script>'
        : url.pathname === '/auto-redirect-source'
        ? '<!doctype html><script>location.href = "/redirect-to-one"</script>'
        : url.pathname === '/link-source'
          ? [
            '<!doctype html>',
            '<a target="_blank" href="/redirect-to-one">Open redirect</a>',
            '<a target="_blank" rel="noopener" href="/redirect-to-one">Open noopener redirect</a>',
            '<a target="_blank" href="http://redirect.test/to-one">Open HTTP redirect</a>',
            '<a href="/redirect-to-one">Follow redirect</a>',
          ].join('')
          : '<!doctype html><title>Space restoration fixture</title>',
    });
  });
  await context.route('http://redirect.test/**', (route) => route.fulfill({
    status: 302,
    headers: { location: 'https://space-race.test/one' },
  }));
  const page = context.pages().find((candidate) =>
    candidate.url() === sidepanelUrl(worker)) ?? await context.newPage();
  if (page.url() !== sidepanelUrl(worker)) await page.goto(sidepanelUrl(worker));
  await pinExtensionHost(worker, extensionBaseUrl(worker));
  // Fixtures build on the repaired structure, so wait for a space's marked bookmarks root.
  await expect.poll(async () => (await allBookmarks(worker))
    .some((node) => node.title.startsWith('bookmarks {') && node.title.includes('spaceBookmarks'))).toBe(true);
  if (viewport) await page.setViewportSize(viewport);
  return { context, page, worker };
}

/** A fresh user data directory named for the test, removed once `run` settles. */
export async function withUserDataDir<Result>(
  name: string,
  run: (userDataDir: string) => Promise<Result>,
): Promise<Result> {
  const userDataDir = await mkdtemp(join(tmpdir(), `hyper-${name}-`));
  try {
    return await run(userDataDir);
  } finally {
    await removeUserDataDir(userDataDir);
  }
}

/**
 * Removes a browser's user data directory, or a folder holding one. The
 * browser's helper processes can still be writing to it just after it closes.
 */
export async function removeUserDataDir(path: string): Promise<void> {
  await rm(path, { force: true, maxRetries: 10, recursive: true });
}

/** Launches browsers on one user data directory, as a test that restarts the browser needs. */
export interface Profile {
  readonly userDataDir: string;
  launchExtension(options?: ExtensionLaunchOptions): Promise<ExtensionSession>;
  launchHyper(options?: HyperLaunchOptions): Promise<HyperSession>;
}

/** Runs `run` with launchers for `userDataDir`, closing the newest browser they started once it settles. */
export async function onProfile<Result>(
  userDataDir: string,
  run: (profile: Profile) => Promise<Result>,
): Promise<Result> {
  let context: BrowserContext | undefined;
  const track = async <Session extends ExtensionSession>(launched: Promise<Session>) => {
    const session = await launched;
    context = session.context;
    return session;
  };
  try {
    return await run({
      userDataDir,
      launchExtension: (options) => track(launchExtension(userDataDir, options)),
      launchHyper: (options) => track(launchHyper(userDataDir, options)),
    });
  } finally {
    await context?.close();
  }
}

/** Runs `run` on a fresh profile named for the test, removing it afterwards. */
export const withProfile = <Result>(name: string, run: (profile: Profile) => Promise<Result>) =>
  withUserDataDir(name, (userDataDir) => onProfile(userDataDir, run));

/** Runs `run` against a fresh browser from `launchExtension`, closing it afterwards. */
export const withExtension = (
  name: string,
  run: (session: ExtensionSession) => Promise<void>,
  options: ExtensionLaunchOptions = {},
) => withProfile(name, async (profile) => run(await profile.launchExtension(options)));

/** Runs `run` against a fresh browser from `launchHyper`, closing it afterwards. */
export const withHyper = (
  name: string,
  run: (session: HyperSession) => Promise<void>,
  options: HyperLaunchOptions = {},
) => withProfile(name, async (profile) => run(await profile.launchHyper(options)));

export const extensionBaseUrl = (worker: Worker) => worker.url().replace(/\/[^/]*$/, '');

export const sidepanelUrl = (worker: Worker) => `${extensionBaseUrl(worker)}/sidepanel.html`;

/** Opens the sidebar in `target`, or in a new tab of a context, sized first when a viewport is given. */
export async function openSidepanel(
  target: BrowserContext | Page,
  worker: Worker,
  viewport?: Viewport,
  goto?: GotoOptions,
): Promise<Page> {
  const page = 'newPage' in target ? await target.newPage() : target;
  if (viewport) await page.setViewportSize(viewport);
  await page.goto(sidepanelUrl(worker), goto);
  return page;
}

/** Presses the Search shortcut in a web page that has focus and returns the in-page Search frame once it opens. */
export async function openPageSearch(webpage: Page): Promise<Frame> {
  await webpage.keyboard.press(process.platform === 'darwin' ? 'Meta+P' : 'Control+P');
  await expect(webpage.locator('#hyper-search-overlay-host')).toHaveAttribute('data-open', 'true');
  const overlayFrame = () => webpage.frames().find((frame) => frame.url().includes('mode=search-overlay'));
  await expect.poll(() => overlayFrame() !== undefined).toBe(true);
  return overlayFrame()!;
}

/**
 * Turns autofolders off and opens a 720x900 sidebar tab once its one space shows.
 * Returns the tab and its window.
 */
export async function openPlainSidebar(
  context: BrowserContext,
  worker: Worker,
): Promise<{ sidebar: Page; windowId: number }> {
  await saveHyperPreference(worker, 'autofolders', false);
  const sidebar = await openSidepanel(context, worker, { width: 720, height: 900 });
  await expect(sidebar.locator('.space-pagination-dot')).toHaveCount(1);
  const [tab] = await callChrome<Array<{ windowId: number }>>(worker, 'tabs.query', { url: sidepanelUrl(worker) });
  if (!tab) throw new Error('The sidebar tab was not found');
  return { sidebar, windowId: tab.windowId };
}

export const titledPage = (title: string) => `<!doctype html><title>${title}</title>`;

/** Answers every request matching `url` with the given HTML, or the HTML for the requested URL. */
export async function routeHtml(
  context: BrowserContext,
  url: RouteUrl,
  body: string | ((requested: URL) => string),
): Promise<void> {
  await context.route(url, (route) => route.fulfill({
    contentType: 'text/html',
    body: typeof body === 'string' ? body : body(new URL(route.request().url())),
  }));
}

/** Answers every request matching `url` with a page linking to `target` in the same tab (#same) and a new one (#new). */
export const routeLinkPage = (context: BrowserContext, url: RouteUrl, title: string, target: string) =>
  routeHtml(context, url, titledPage(title) +
    `<a id="same" href="${target}">Same tab</a> <a id="new" href="${target}" target="_blank">New tab</a>`);

/** Answers every request matching `url` with a page titled by its path, after `prefix`. */
export const routePathTitles = (context: BrowserContext, url: RouteUrl, prefix = '') =>
  routeHtml(context, url, ({ pathname }) => titledPage(`${prefix}${pathname.slice(1)}`));

/**
 * Chromium disables an unpacked extension that reloads while developer mode is
 * off, and anyone who loads Hyper unpacked has it on.
 */
export async function openExtensionsInDeveloperMode(context: BrowserContext): Promise<Page> {
  const extensionsPage = await context.newPage();
  await extensionsPage.goto('chrome://extensions');
  const developerMode = extensionsPage.locator('#devMode');
  if (await developerMode.getAttribute('aria-pressed') !== 'true') {
    await developerMode.press('Space');
  }
  await expect(developerMode).toHaveAttribute('aria-pressed', 'true');
  return extensionsPage;
}

/** The Hyper worker that starts after `worker`, as a reload or re-enable starts one. */
export const nextHyperWorker = (context: BrowserContext, worker: Worker, timeout?: number) =>
  context.waitForEvent('serviceworker', {
    predicate: (candidate) => candidate !== worker && isHyperWorker(candidate),
    ...(timeout === undefined ? {} : { timeout }),
  });

/** Opens the sidebar in a new tab, retrying for 10s while Hyper restarts and its pages cannot load yet. */
export async function openRestartedSidepanel(
  context: BrowserContext,
  baseUrl: string,
  goto: GotoOptions = { waitUntil: 'domcontentloaded' },
): Promise<Page> {
  const page = await context.newPage();
  await expect.poll(async () => {
    try {
      await page.goto(`${baseUrl}/sidepanel.html`, goto);
      return true;
    } catch {
      return false;
    }
  }, { timeout: 10_000 }).toBe(true);
  return page;
}

export async function reloadHyperExtension(
  context: BrowserContext,
  worker: Worker,
): Promise<HyperSession> {
  const baseUrl = extensionBaseUrl(worker);
  const extensionId = new URL(baseUrl).host;
  const extensionsPage = await openExtensionsInDeveloperMode(context);
  const nextWorker = nextHyperWorker(context, worker);
  await extensionsPage.locator(`extensions-item#${extensionId}`)
    .locator('#dev-reload-button').click();
  let reloadedPage: Page;
  try {
    reloadedPage = await openRestartedSidepanel(context, baseUrl);
  } catch (error) {
    const itemState = await extensionsPage.locator(`extensions-item#${extensionId}`)
      .evaluate((element) => ({
        attributes: Object.fromEntries(
          [...element.attributes].map((attribute) => [attribute.name, attribute.value]),
        ),
        text: element.shadowRoot?.textContent,
      }));
    throw new Error(`Hyper did not reload: ${JSON.stringify(itemState)}`, {
      cause: error,
    });
  }
  const reloadedWorker = await nextWorker;
  await pinExtensionHost(reloadedWorker, baseUrl);
  await extensionsPage.close();
  return { context, page: reloadedPage, worker: reloadedWorker };
}

export async function reenableHyperExtension(
  context: BrowserContext,
  worker: Worker,
  whileDisabled?: () => Promise<void>,
): Promise<HyperSession> {
  const baseUrl = extensionBaseUrl(worker);
  const extensionId = new URL(baseUrl).host;
  const extensionsPage = await context.newPage();
  await extensionsPage.goto('chrome://extensions');
  const toggle = extensionsPage.locator(`extensions-item#${extensionId}`)
    .locator('#enableToggle');
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await whileDisabled?.();
  const nextWorker = nextHyperWorker(context, worker);
  await toggle.click();
  const reenabledPage = await openRestartedSidepanel(context, baseUrl);
  const reenabledWorker = await nextWorker;
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await pinExtensionHost(reenabledWorker, baseUrl);
  await extensionsPage.close();
  return { context, page: reenabledPage, worker: reenabledWorker };
}

export async function pinExtensionHost(worker: Worker, baseUrl: string): Promise<void> {
  const host = (await callChrome<Array<{ id?: number; url?: string }>>(worker, 'tabs.query', {})).find((tab) =>
    tab.url?.startsWith(baseUrl) && tab.url.endsWith('/sidepanel.html'));
  if (host?.id === undefined) throw new Error('The sidepanel host tab was not found');
  await callChrome(worker, 'tabs.update', host.id, { pinned: true });
}
