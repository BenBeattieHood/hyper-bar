import {
  expect,
  test,
  type BrowserContext,
  type Frame,
  type Locator,
  type Page,
  type Worker,
} from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readActiveSpaceId } from './fixtures/activeSpace';
import { callChrome } from './helpers/chrome';
import {
  extensionBaseUrl,
  extensionPath,
  sidepanelUrl,
  withExtension,
  type ExtensionSession,
} from './helpers/extension';
import type { ExtensionGlobal } from './helpers/extensionGlobal';

const browserChannel = process.env.HYPER_BROWSER_CHANNEL ?? 'chromium';
const searchShortcut = process.platform === 'darwin' ? 'Meta+P' : 'Control+P';
const searchName = { name: 'Search tabs, bookmarks, history, or commands' };

const withShortcutBrowser = (name: string, run: (session: ExtensionSession) => Promise<void>) =>
  withExtension(name, run, { channel: browserChannel });

interface ChromiumManifest {
  commands?: Record<string, {
    suggested_key?: { default?: string; mac?: string };
  }>;
  content_scripts?: Array<{
    matches?: string[];
    js?: string[];
    all_frames?: boolean;
    run_at?: string;
  }>;
}

interface ExtensionTab {
  id?: number;
  url?: string;
  windowId: number;
}

/** Opens example.com, served locally so a run never depends on the network, in the first tab. */
async function openExamplePage(context: BrowserContext): Promise<Page> {
  const webpage = context.pages()[0] ?? await context.newPage();
  await context.route('https://example.com/**', (route) => route.fulfill({
    contentType: 'text/html',
    body: '<!doctype html><title>Example Domain</title><h1>Example Domain</h1>' +
      '<p>This domain is for use in documentation examples.</p>',
  }));
  await webpage.goto('https://example.com');
  return webpage;
}

/** Waits for the page's in-page Search frame and returns it with its field. */
async function searchOverlay(webpage: Page): Promise<{ search: ReturnType<Frame['getByRole']>; searchFrame: Frame }> {
  await expect.poll(() => webpage.frames().map((frame) => frame.url())).toEqual(
    expect.arrayContaining([expect.stringContaining('mode=search-overlay')]),
  );
  const searchFrame = webpage.frames().find((frame) =>
    new URL(frame.url()).searchParams.get('mode') === 'search-overlay');
  if (!searchFrame) throw new Error('The in-page Search frame did not open.');
  return { search: searchFrame.getByRole('combobox', searchName), searchFrame };
}

/** Moves focus to the document body, off any field. */
const focusBody = (target: Page | Frame) => target.evaluate(() => {
  document.body.tabIndex = -1;
  document.body.focus();
});

async function dispatchActionFromFocusedTab(worker: Worker, targetUrl: string) {
  return worker.evaluate(async (url) => {
    const extension = globalThis as unknown as {
      chrome: {
        action: {
          onClicked: {
            dispatch: (tab: ExtensionTab) => void;
          };
        };
        sidePanel: {
          open: (options: { windowId: number }) => Promise<void>;
        };
        tabs: {
          query: (options: Record<string, never>) => Promise<ExtensionTab[]>;
          update: (
            tabId: number,
            options: { active: boolean },
          ) => Promise<ExtensionTab>;
        };
      };
    };
    const openCalls: Array<{ windowId: number }> = [];
    extension.chrome.sidePanel.open = async (options) => {
      openCalls.push(options);
    };
    const tab = (await extension.chrome.tabs.query({})).find(
      (candidate) => candidate.url === url,
    );
    if (!tab || tab.id === undefined || tab.windowId === undefined) {
      throw new Error('The focused webpage tab could not be identified.');
    }
    await extension.chrome.tabs.update(tab.id, { active: true });
    extension.chrome.action.onClicked.dispatch(tab);
    return { openCalls, tabUrl: tab.url, windowId: tab.windowId };
  }, targetUrl);
}

test('routes the Chromium fallback action to Tabs from a focused webpage', async () => {
  const manifest = JSON.parse(
    await readFile(join(extensionPath, 'manifest.json'), 'utf8'),
  ) as ChromiumManifest;
  expect(manifest.commands).toEqual({
    _execute_action: {
      suggested_key: {
        default: 'Ctrl+Shift+P',
        mac: 'Command+Shift+P',
      },
    },
  });

  await withShortcutBrowser('page-shortcut', async ({ context, worker }) => {
    const webpage = await openExamplePage(context);

    const sidepanel = await context.newPage();
    await sidepanel.goto(sidepanelUrl(worker));
    const searchButton = sidepanel.getByRole('button', { name: 'Search tabs and history' });
    const search = sidepanel.getByRole('combobox', searchName);
    const tabs = sidepanel.locator('#workspace-panel-tabs');
    await expect(searchButton).toBeVisible();
    await expect(search).toHaveCount(0);
    await expect(tabs).toBeVisible();
    await searchButton.click();
    await expect(search).toBeVisible();
    await expect(search).toBeFocused();
    expect(await sidepanel.locator('.search-command-shell').evaluate(
      (element) => getComputedStyle(element, '::before').animationDuration,
    )).toBe('15s');

    await webpage.bringToFront();
    await webpage.locator('body').click();
    await expect.poll(() => webpage.evaluate(() => document.hasFocus())).toBe(true);

    const invocation = await dispatchActionFromFocusedTab(
      worker,
      'https://example.com/',
    );
    expect(invocation.tabUrl).toBe('https://example.com/');
    expect(invocation.openCalls).toEqual([{ windowId: invocation.windowId }]);
    await expect(search).toHaveCount(0);
    await expect(searchButton).toBeVisible();
    await expect(tabs).toBeVisible();
  });
});

test('focuses New Tab Search with Cmd/Ctrl+P', async () => {
  await withShortcutBrowser('newtab-shortcut', async ({ context, worker }) => {
    const newTab = context.pages()[0] ?? await context.newPage();
    await newTab.goto(`${extensionBaseUrl(worker)}/newtab.html`);
    const search = newTab.getByRole('combobox', searchName);
    await expect(search).toBeVisible();
    expect(await newTab.locator('.command-bar-input').evaluate(
      (element) => getComputedStyle(element, '::before').animationDuration,
    )).toBe('15s');
    await search.evaluate((input) => input.blur());
    await newTab.locator('body').focus();
    await expect(search).not.toBeFocused();

    await newTab.keyboard.press(searchShortcut);

    await expect(search).toBeFocused();
  });
});

test('shows New Tab and in-page Search results only for a query on a focused page', async () => {
  await withShortcutBrowser('results-need-query', async ({ context, worker }) => {
    // Playwright cannot focus the address bar, so stand in for the page losing focus.
    const leavePage = (target: Page | Frame) => target.evaluate(() => {
      document.hasFocus = () => false;
      window.dispatchEvent(new FocusEvent('blur'));
    });
    const returnToPage = (target: Page | Frame) => target.evaluate(() => {
      Reflect.deleteProperty(document, 'hasFocus');
    });
    const expectQueryResults = async (target: Page | Frame, search: Locator) => {
      const results = target.getByRole('listbox', { name: 'Command bar results' });
      await expect(search).toBeFocused();
      await expect(results).toHaveCount(0);
      await search.fill('example');
      await expect(results).toBeVisible();
      await leavePage(target);
      await expect(results).toHaveCount(0);
      await returnToPage(target);
      await search.click();
      await expect(results).toBeVisible();
      // An open result menu must not keep the results up once the page loses focus.
      await target.getByRole('option', { name: /example\.com/ }).first().click({ button: 'right' });
      const menu = target.locator('.context-menu');
      await expect(menu).toBeVisible();
      await leavePage(target);
      await expect(menu).toHaveCount(0);
      await expect(results).toHaveCount(0);
      await returnToPage(target);
      await search.click();
      await expect(results).toBeVisible();
      await search.fill('');
      await expect(results).toHaveCount(0);
    };

    const webpage = await openExamplePage(context);
    const newTab = await context.newPage();
    await newTab.goto(`${extensionBaseUrl(worker)}/newtab.html`);
    await expectQueryResults(newTab, newTab.getByRole('combobox', searchName));

    await webpage.bringToFront();
    await webpage.locator('body').click();
    await webpage.keyboard.press(searchShortcut);
    const { search, searchFrame } = await searchOverlay(webpage);
    await expectQueryResults(searchFrame, search);
  });
});

test('explains a search the browser cannot run, linking to its search engine setting', async () => {
  await withShortcutBrowser('newtab-no-engine', async ({ context, worker }) => {
    // Answer as Chromium does for a browser left without a default engine.
    await worker.evaluate(() => {
      const extension = globalThis as unknown as ExtensionGlobal;
      extension.chrome.search.query = () =>
        Promise.reject(new Error('Missing default search provider.'));
    });
    const newTab = context.pages()[0] ?? await context.newPage();
    await newTab.goto(`${extensionBaseUrl(worker)}/newtab.html`);
    const search = newTab.getByRole('combobox', searchName);
    await search.fill('weather tomorrow');
    await expect(newTab.locator('#command-bar-results')).toHaveAttribute('aria-busy', 'false');
    await search.press('Alt+Enter');

    const notice = newTab.getByRole('status');
    const edge = browserChannel.startsWith('msedge');
    await expect(notice).toHaveText(
      `${edge ? 'Edge' : 'Your browser'} has no default search engine — choose one in Settings`,
    );
    const settings = notice.getByRole('link', { name: 'Settings' });
    const settingsUrl = `${edge ? 'edge' : 'chrome'}://settings/search`;
    await expect(settings).toHaveAttribute('href', settingsUrl);
    // The results list stays open, so the click also proves nothing covers the link.
    await settings.click();
    await expect.poll(() => newTab.url()).toBe(settingsUrl);
  });
});

// Search pages answer only once released, so a new tab page stays shown while one loads.
const holdSearchPages = (context: BrowserContext, released: Promise<void>) =>
  context.route((url) => url.hostname === 'www.google.com', async (route) => {
    await released;
    await route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Results</title>' });
  });

interface UnderwayView {
  field: boolean;
  text?: string;
  results: boolean;
  borderColour?: string;
  font?: string;
  fieldBox?: { left: number; bottom: number };
  textBox?: { left: number; middle: number };
  lineBox?: { left: number; middle: number };
  spinner?: { lens: string; handle: string; turning: string };
}

// Playwright waits for a pending navigation before it reads a page, so a held one is read from
// another extension page in a window of its own, which leaves the new tab its window's active tab.
const openUnderwayProbe = async (context: BrowserContext, worker: Worker) => {
  const [probe] = await Promise.all([
    context.waitForEvent('page'),
    callChrome(worker, 'windows.create', { focused: false, url: sidepanelUrl(worker) }),
  ]);
  await probe.waitForLoadState('domcontentloaded');
  return probe;
};

const readUnderway = (probe: Page): Promise<UnderwayView> => probe.evaluate(() => {
  const { chrome } = globalThis as unknown as ExtensionGlobal;
  const views = chrome.extension.getViews({ type: 'tab' }) as unknown as Window[];
  const view = views
    .find((candidate) => candidate.location.pathname === '/newtab.html');
  const page = view?.document;
  const field = page?.querySelector('.command-bar-input');
  const underway = page?.querySelector('.command-bar-underway');
  const line = page?.querySelector('.command-bar-underway-line');
  const shown = {
    field: Boolean(page?.querySelector('.command-bar-input input')),
    results: Boolean(page?.querySelector('[role="listbox"]')),
  };
  if (!view || !page || !field || !underway || !line) return shown;
  const range = page.createRange();
  range.selectNodeContents(underway);
  const text = range.getBoundingClientRect();
  const fieldBox = field.getBoundingClientRect();
  const lineBox = line.getBoundingClientRect();
  const style = view.getComputedStyle(underway);
  const lens = page.querySelector('.command-bar-input > svg circle');
  const handle = page.querySelector('.command-bar-input > svg path');
  return {
    ...shown,
    text: underway.textContent ?? undefined,
    borderColour: view.getComputedStyle(field).borderTopColor,
    font: `${style.fontSize} ${style.fontWeight}`,
    fieldBox: { left: fieldBox.left, bottom: fieldBox.bottom },
    textBox: { left: text.left, middle: text.top + text.height / 2 },
    lineBox: { left: lineBox.left, middle: lineBox.top + lineBox.height / 2 },
    spinner: lens && handle ? {
      lens: view.getComputedStyle(lens).strokeDasharray,
      handle: view.getComputedStyle(handle).strokeDashoffset,
      turning: view.getComputedStyle(lens).animationName,
    } : undefined,
  };
});

test('shows a search the new tab page is loading in place of its field', async () => {
  let release = () => {};
  const released = new Promise<void>((resolve) => { release = resolve; });
  await withShortcutBrowser('newtab-underway', async ({ context, worker }) => {
    const newTab = context.pages()[0] ?? await context.newPage();
    await newTab.goto(`${extensionBaseUrl(worker)}/newtab.html`);
    await holdSearchPages(context, released);
    const probe = await openUnderwayProbe(context, worker);
    const search = newTab.getByRole('combobox', searchName);
    await search.fill('weather tomorrow');
    await expect(newTab.locator('#command-bar-results')).toHaveAttribute('aria-busy', 'false');
    const field = await newTab.locator('.command-bar-input').boundingBox();
    const typed = await search.evaluate((input) => {
      const box = input.getBoundingClientRect();
      return { left: box.left, middle: box.top + box.height / 2 };
    });
    // The search's page is held back, so the press must not wait for it to arrive.
    await search.press('Alt+Enter', { noWaitAfter: true });

    await expect.poll(async () => (await readUnderway(probe)).text).toBe('weather tomorrow');
    const shown = await readUnderway(probe);
    expect(shown.field).toBe(false);
    expect(shown.results).toBe(false);
    expect(shown.font).toBe('15px 560');
    expect(shown.borderColour).toBe('rgba(0, 0, 0, 0)');
    expect(shown.textBox?.left).toBeCloseTo(typed.left, 0);
    expect(Math.abs((shown.textBox?.middle ?? 0) - typed.middle)).toBeLessThanOrEqual(1);
    expect(shown.fieldBox?.bottom).toBeCloseTo((field?.y ?? 0) + (field?.height ?? 0), 0);
    expect(shown.lineBox?.left).toBeCloseTo((field?.x ?? 0) - 1, 0);
    // The magnifier has become a spinner once its handle is drawn in and its lens is an arc.
    await expect.poll(async () => (await readUnderway(probe)).spinner).toEqual({
      lens: '30px, 20.3px',
      handle: '-7px',
      turning: 'command-underway-spin',
    });
    expect(shown.lineBox?.middle).toBeCloseTo((field?.y ?? 0) + (field?.height ?? 0), 0);

    release();
    await expect.poll(() => newTab.url()).toContain('www.google.com/search');
  }).finally(() => release());
});

test('shows a page the address bar sends a new tab to in place of its field', async () => {
  let release = () => {};
  const released = new Promise<void>((resolve) => { release = resolve; });
  await withShortcutBrowser('newtab-underway-address-bar', async ({ context, worker }) => {
    const newTab = context.pages()[0] ?? await context.newPage();
    await newTab.goto(`${extensionBaseUrl(worker)}/newtab.html`);
    await holdSearchPages(context, released);
    await expect(newTab.getByRole('combobox', searchName)).toBeVisible();
    const probe = await openUnderwayProbe(context, worker);
    const [tab] = await callChrome<Array<{ id: number }>>(worker, 'tabs.query', { url: `${extensionBaseUrl(worker)}/newtab.html` });
    // An extension's navigation stands in for the address bar, which Playwright cannot type into.
    await callChrome(worker, 'tabs.update', tab?.id, { url: 'https://www.google.com/search?q=tide+times' });

    await expect.poll(async () => (await readUnderway(probe)).text).toBe('tide times');
    expect((await readUnderway(probe)).field).toBe(false);
    release();
    await expect.poll(() => newTab.url()).toContain('www.google.com/search');
  }).finally(() => release());
});

test('opens in-page Search from page content without invoking Print', async () => {
  const manifest = JSON.parse(
    await readFile(join(extensionPath, 'manifest.json'), 'utf8'),
  ) as ChromiumManifest;
  expect(manifest.content_scripts).toEqual([{
    matches: ['http://*/*', 'https://*/*'],
    js: ['content-scripts/page-shortcut.js'],
    all_frames: true,
    run_at: 'document_start',
  }]);

  await withShortcutBrowser('print-shortcut', async ({ context, worker }) => {
    // The overlay now runs its search over the model port rather than
    // runtime.sendMessage, so slow a single query at the port to keep the
    // in-flight (aria-busy) window observable. The overlay iframe is reused
    // across reopens, so this must be installed before the first port connects.
    await context.addInitScript(() => {
      const runtime = (globalThis as unknown as {
        chrome?: {
          runtime?: {
            connect?: (info?: unknown) => { postMessage: (message: unknown) => void };
          };
        };
      }).chrome?.runtime;
      if (!runtime?.connect) return;
      const connect = runtime.connect.bind(runtime);
      runtime.connect = (info?: unknown) => {
        const port = connect(info);
        const post = port.postMessage.bind(port);
        port.postMessage = (message: unknown) => {
          if (
            message &&
            typeof message === 'object' &&
            'type' in message &&
            (message as { type?: unknown }).type === 'search-query' &&
            'query' in message &&
            (message as { query?: unknown }).query === 'delayed unmatched query'
          ) {
            setTimeout(() => post(message), 300);
            return;
          }
          post(message);
        };
        return port;
      };
    });
    const webpage = context.pages()[0] ?? await context.newPage();
    await webpage.route('https://shortcut.test/**', (route) => route.fulfill({
      contentType: 'text/html',
      body: `
        <style>div { display: block; position: static; padding: 0; inset: auto; }</style>
        <label>Page editor <input aria-label="Page editor"></label>
        <script>
          globalThis.pagePrintShortcutCalls = 0;
          window.addEventListener('keydown', (event) => {
            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'p') {
              globalThis.pagePrintShortcutCalls += 1;
            }
          }, true);
        </script>
      `,
    }));
    await webpage.goto('https://shortcut.test/');
    const pageEditor = webpage.getByRole('textbox', { name: 'Page editor' });
    await webpage.bringToFront();
    await pageEditor.focus();
    await expect.poll(() => webpage.evaluate(() => document.hasFocus())).toBe(true);

    const pageCount = context.pages().length;
    await webpage.keyboard.press(searchShortcut);
    const { search, searchFrame } = await searchOverlay(webpage);
    const sourceTabId = Number(new URL(searchFrame.url()).searchParams.get('sourceTabId'));
    await expect.poll(async () => (await callChrome<{ url?: string }>(worker, 'tabs.get', sourceTabId)).url)
      .toBe('https://shortcut.test/');
    await expect(search).toBeVisible();
    await expect(search).toBeFocused();
    const searchBox = await search.boundingBox();
    expect(searchBox).not.toBeNull();
    await expect(webpage.locator('#hyper-search-overlay-host'))
      .toHaveAttribute('data-ready', 'true');
    await expect(webpage.locator('#hyper-search-overlay-host'))
      .toHaveAttribute('data-page-background', 'light');
    await expect(searchFrame.locator('html')).toHaveCSS(
      'background-color',
      'rgba(0, 0, 0, 0)',
    );
    // The host iframe declares the same scheme; a mismatch makes Chrome paint the frame opaque.
    await expect(searchFrame.locator('html')).toHaveCSS('color-scheme', 'light dark');
    await expect(searchFrame.locator('body')).toHaveCSS(
      'background-color',
      'rgba(0, 0, 0, 0)',
    );
    await expect(searchFrame.locator('#root')).toHaveCSS(
      'background-color',
      'rgba(0, 0, 0, 0)',
    );
    const searchSurface = searchFrame.locator('.command-bar-input');
    await expect(searchSurface).toHaveCSS('background-color', 'rgb(248, 250, 249)');
    expect(await searchSurface.evaluate(
      (element) => getComputedStyle(element, '::before').animationDuration,
    )).toBe('15s');
    await expect(searchSurface).toHaveCSS(
      'box-shadow',
      /rgba\(2, 5, 6, 0\.68\)/,
    );
    await webpage.emulateMedia({ colorScheme: 'dark' });
    await expect(searchSurface).toHaveCSS(
      'box-shadow',
      /rgba\(0, 0, 0, 0\.82\)/,
    );
    await webpage.emulateMedia({ colorScheme: 'light' });
    await expect(searchSurface).toHaveCSS(
      'box-shadow',
      /rgba\(2, 5, 6, 0\.68\)/,
    );
    expect(context.pages()).toHaveLength(pageCount);
    await expect(pageEditor).not.toBeFocused();
    expect(await webpage.evaluate(() => {
      const page = globalThis as typeof globalThis & { pagePrintShortcutCalls?: number };
      return page.pagePrintShortcutCalls;
    })).toBe(0);

    await search.fill('shortcut');
    const currentPageResult = searchFrame.getByRole('option', {
      name: /^shortcut\.test https:\/\/shortcut\.test\//,
    });
    await expect(currentPageResult).toBeVisible();
    // Only the surround is transparent: the results popup must stay opaque over the page.
    await expect(searchFrame.getByRole('listbox', { name: 'Command bar results' }))
      .toHaveCSS('background-color', 'rgb(248, 250, 249)');
    await expect(currentPageResult.locator('.favicon'))
      .toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    const expandedSearchBox = await search.boundingBox();
    expect(expandedSearchBox).not.toBeNull();
    expect(Math.abs(expandedSearchBox!.y - searchBox!.y)).toBeLessThan(2);
    const historyDate = searchFrame.locator('.command-history-date');
    await expect(historyDate).toHaveText(/^\d{2}:\d{2}$/);
    // The date shares the URL row, so the title keeps the full width of the copy column.
    const historyRow = searchFrame.locator('.command-result-row', { has: historyDate });
    const [titleBox, copyBox, urlBox, dateBox] = await Promise.all([
      historyRow.locator('.command-result-copy strong').boundingBox(),
      historyRow.locator('.command-result-copy').boundingBox(),
      historyRow.locator('.command-result-meta small').boundingBox(),
      historyDate.boundingBox(),
    ]);
    expect(titleBox!.width).toBeCloseTo(copyBox!.width, 0);
    expect(dateBox!.y).toBeGreaterThan(titleBox!.y + titleBox!.height - 1);
    expect(Math.abs((dateBox!.y + dateBox!.height) - (urlBox!.y + urlBox!.height))).toBeLessThan(3);
    expect(dateBox!.x).toBeCloseTo(copyBox!.x, 0);
    expect(urlBox!.x).toBeGreaterThan(dateBox!.x + dateBox!.width);
    const historyDelete = searchFrame.getByRole('button', {
      name: /Delete .* from history/,
    });
    await expect(historyDelete).toHaveCSS('width', '28px');
    await expect(historyDelete).toHaveCSS('height', '28px');
    await expect(historyDelete.locator('svg.lucide-trash-2')).toHaveCount(1);
    // History rows hold their glyph until the page icon loads, then fade it in.
    const historyIcon = searchFrame
      .locator('.command-result-row', { has: historyDelete })
      .locator('.history-result-icon');
    await expect(historyIcon.locator('.history-result-placeholder')).toHaveCount(1);
    await expect(historyIcon).toHaveAttribute('data-history-icon-state', 'loaded');
    await expect(historyIcon.locator('img')).toHaveCSS('opacity', '1');
    await expect(historyIcon.locator('.history-result-placeholder')).toHaveCSS('opacity', '0');
    await currentPageResult.click();
    await expect(webpage.locator('#hyper-search-overlay-host'))
      .toHaveAttribute('data-open', 'false');
    await expect.poll(() => callChrome(worker, 'storage.local.get', 'hyperSearchSelectionHistory')).toMatchObject({
      hyperSearchSelectionHistory: {
        shortcut: {
          'tab:https://shortcut.test/': { count: 1 },
        },
      },
    });

    await webpage.evaluate(() => {
      document.documentElement.style.background = '#101416';
      document.body.style.background = 'transparent';
      document.body.style.color = '#f5f7f7';
    });
    await webpage.keyboard.press(searchShortcut);
    await expect.poll(() => webpage.frames().filter((frame) =>
      frame.url().includes('mode=search-overlay')).length).toBeGreaterThan(0);
    const reopenedSearchFrame = webpage.frames().filter((frame) =>
      frame.url().includes('mode=search-overlay')).at(-1);
    if (!reopenedSearchFrame) throw new Error('The in-page Search frame did not reopen.');
    const reopenedSearch = reopenedSearchFrame.getByRole('combobox', searchName);
    const reopenedSearchSurface = reopenedSearchFrame.locator('.command-bar-input');
    const reopenedCurrentPageResult = reopenedSearchFrame.getByRole('option', {
      name: /^shortcut\.test https:\/\/shortcut\.test\//,
    });
    await expect(reopenedSearch).toBeFocused();
    await expect(webpage.locator('#hyper-search-overlay-host'))
      .toHaveAttribute('data-page-background', 'dark');
    await expect(reopenedSearchFrame.locator('html')).toHaveClass(/search-overlay-dark-page/);
    await expect(reopenedSearchSurface).toHaveCSS(
      'box-shadow',
      /rgba\(0, 0, 0, 0\.82\)/,
    );
    await webpage.emulateMedia({ colorScheme: 'dark' });
    await expect(reopenedSearchSurface).toHaveCSS(
      'box-shadow',
      /rgba\(0, 0, 0, 0\.9\)/,
    );
    await webpage.emulateMedia({ colorScheme: 'light' });
    await reopenedSearch.fill('delayed unmatched query');
    const results = reopenedSearchFrame.getByRole('listbox', {
      name: 'Command bar results',
    });
    await expect(results).toHaveAttribute('aria-busy', 'true');
    expect(await reopenedCurrentPageResult.count()).toBe(1);
    await expect(results).toHaveAttribute('aria-busy', 'false');
    await expect(reopenedCurrentPageResult).toHaveCount(0);

    await reopenedSearch.fill('https://shortcut.test/destination');
    const directNavigation = reopenedSearchFrame.getByRole('option', {
      name: /Go to shortcut\.test/,
    });
    await expect(directNavigation).toBeVisible();
    await directNavigation.click();
    await expect.poll(async () => (await callChrome<Array<{ id?: number; url?: string }>>(worker, 'tabs.query', {}))
      .map(({ id, url }) => ({ id, url }))).toContainEqual({ id: sourceTabId, url: 'https://shortcut.test/destination' });
    await expect(webpage).toHaveURL('https://shortcut.test/destination');
    await expect.poll(() => webpage.frames().some((frame) =>
      frame.url().includes('mode=search-overlay'))).toBe(false);
  });
});

test('reuses and refocuses page shortcut Search in the current webpage', async () => {
  await withShortcutBrowser('cold-shortcut', async ({ context, worker }) => {
    const webpage = await openExamplePage(context);
    await webpage.bringToFront();
    await webpage.locator('body').click();

    const pageCount = context.pages().length;
    await webpage.keyboard.press(searchShortcut);
    const { search, searchFrame } = await searchOverlay(webpage);
    await expect(search).toBeVisible();
    await expect(search).toBeFocused();
    await expect(webpage.locator('#hyper-search-overlay-host'))
      .toHaveAttribute('data-ready', 'true');

    await focusBody(searchFrame);
    await expect(search).not.toBeFocused();
    await webpage.keyboard.press(searchShortcut);

    await expect(search).toBeFocused();
    expect(context.pages()).toHaveLength(pageCount);
    expect(webpage.frames().filter((frame) =>
      frame.url().includes('mode=search-overlay'))).toHaveLength(1);
    await search.press('Escape');
    await expect(webpage.locator('#hyper-search-overlay-host'))
      .toHaveAttribute('data-open', 'false');
    expect(webpage.frames().filter((frame) =>
      frame.url().includes('mode=search-overlay'))).toHaveLength(1);

    await webpage.keyboard.press(searchShortcut);

    await expect(webpage.locator('#hyper-search-overlay-host'))
      .toHaveAttribute('data-open', 'true');
    expect(webpage.frames().find((frame) =>
      frame.url().includes('mode=search-overlay'))).toBe(searchFrame);
    await expect(search).toBeFocused();
    await focusBody(searchFrame);
    await webpage.keyboard.press('Escape');
    await expect(webpage.locator('#hyper-search-overlay-host'))
      .toHaveAttribute('data-open', 'false');
  });
});

test('draws in-page Search where the new tab draws its mark and field', async () => {
  await withShortcutBrowser('overlay-newtab-geometry', async ({ context, worker }) => {
    const webpage = await openExamplePage(context);
    const newTab = await context.newPage();
    await newTab.goto(`${extensionBaseUrl(worker)}/newtab.html`);
    await webpage.bringToFront();
    await webpage.locator('body').click();
    await webpage.keyboard.press(searchShortcut);
    const { search, searchFrame } = await searchOverlay(webpage);
    await expect(search).toBeVisible();
    await expect(webpage.locator('#hyper-search-overlay-host'))
      .toHaveAttribute('data-ready', 'true');

    const boxes = async (target: Page | Frame) => {
      const [brand, field] = await Promise.all([
        target.locator('.newtab-brand').boundingBox(),
        target.locator('.command-bar-input').boundingBox(),
      ]);
      return { brand, field };
    };
    // Tall, short (the new tab's under-620px rule) and narrow windows.
    for (const size of [
      { width: 1280, height: 900 },
      { width: 1280, height: 560 },
      { width: 560, height: 760 },
    ]) {
      await Promise.all([webpage.setViewportSize(size), newTab.setViewportSize(size)]);
      const expected = await boxes(newTab);
      await expect.poll(() => boxes(searchFrame), { message: JSON.stringify(size) })
        .toEqual(expected);
    }
  });
});

test('closes in-page Search from a click on its transparent surround', async () => {
  await withShortcutBrowser('overlay-surround', async ({ context, worker }) => {
    const webpage = await openExamplePage(context);
    await webpage.bringToFront();
    await webpage.locator('body').click();
    const overlayHost = webpage.locator('#hyper-search-overlay-host');
    const openSearch = async () => {
      await webpage.keyboard.press(searchShortcut);
      await expect(overlayHost).toHaveAttribute('data-open', 'true');
      await expect(overlayHost).toHaveAttribute('data-ready', 'true');
    };

    await openSearch();
    const { search, searchFrame } = await searchOverlay(webpage);
    const surround = searchFrame.locator('main');
    await expect(search).toBeFocused();

    await search.click();
    await searchFrame.locator('.newtab-brand').click();
    await expect(overlayHost).toHaveAttribute('data-open', 'true');
    await expect(search).toBeFocused();

    // The frame spans more than the field, so this lands on its transparent padding.
    await surround.click({ position: { x: 8, y: 8 } });
    await expect(overlayHost).toHaveAttribute('data-open', 'false');

    await openSearch();
    await search.fill('example');
    const result = searchFrame.getByRole('option', { name: /example\.com/ }).first();
    await expect(result).toBeVisible();
    await searchFrame.locator('.command-bar-results').click({ position: { x: 24, y: 3 } });
    await expect(result).toBeVisible();
    await expect(search).toBeFocused();
    await expect(overlayHost).toHaveAttribute('data-open', 'true');

    await result.click({ button: 'right' });
    const menu = searchFrame.locator('.context-menu');
    await expect(menu).toBeVisible();
    await surround.click({ position: { x: 8, y: 8 } });
    await expect(menu).toHaveCount(0);
    await expect(overlayHost).toHaveAttribute('data-open', 'true');

    await surround.click({ position: { x: 8, y: 8 } });
    await expect(overlayHost).toHaveAttribute('data-open', 'false');
  });
});

test('switches spaces from in-page Search when the sidebar is not mounted', async () => {
  await withShortcutBrowser('space-command', async ({ context, worker }) => {
    await context.route('https://source-space.test/**', (route) => route.fulfill({
      contentType: 'text/html',
      body: '<main>Source space</main>',
    }));
    await context.route('https://target-space.test/**', (route) => route.fulfill({
      contentType: 'text/html',
      body: '<main>Target space</main>',
    }));
    const sourcePage = context.pages()[0] ?? await context.newPage();
    await sourcePage.goto('https://source-space.test/');
    const initialiser = await context.newPage();
    await initialiser.goto(sidepanelUrl(worker));
    await expect.poll(() => worker.evaluate(async () => {
      const extension = globalThis as unknown as ExtensionGlobal;
      const [root] = await extension.chrome.bookmarks.getTree();
      const hyper = root!.children
        ?.flatMap((node) => node.children ?? [])
        .find((node) => node.title === 'hyper');
      const spaces = hyper?.children?.find((node) => node.title === 'spaces');
      // Repair is complete once the first space carries its marked tabs root.
      return spaces?.children?.[0]?.children
        ?.some((node) => node.title.startsWith('tabs {')) ?? false;
    })).toBe(true);

    const fixture = await worker.evaluate(async (sourceUrl) => {
      const extension = globalThis as unknown as ExtensionGlobal;
      type BookmarkNode = {
        children?: BookmarkNode[];
        id: string;
        title: string;
      };
      const [root] = await extension.chrome.bookmarks.getTree() as BookmarkNode[];
      const hyper = root!.children
        ?.flatMap((node) => node.children ?? [])
        .find((node) => node.title === 'hyper');
      const spaces = hyper?.children?.find((node) => node.title === 'spaces');
      const sourceSpace = spaces?.children?.[0];
      const sourceTab = (await extension.chrome.tabs.query({})).find(
        (tab) => tab.url === sourceUrl,
      );
      if (!spaces || !sourceSpace || sourceTab?.id === undefined) {
        throw new Error('Hyper space fixture could not be initialized.');
      }
      const targetSpace = await extension.chrome.bookmarks.create({
        parentId: spaces.id,
        title: 'Target Space',
      });
      await extension.chrome.bookmarks.create({
        parentId: targetSpace.id,
        title: `tabs {"hyper":{"spaceTabs":true,"spaceId":"${targetSpace.id}"}}`,
      });
      const targetTab = await extension.chrome.tabs.create({
        active: false,
        url: 'https://target-space.test/',
        windowId: sourceTab.windowId,
      });
      if (targetTab.id === undefined) throw new Error('Target tab was not created.');
      const ownership = {
        spaceId: targetSpace.id,
        windowId: targetTab.windowId,
      };
      await extension.chrome.storage.session.set({
        [`tabSpaceId:${targetTab.id}`]: ownership,
      });
      const initialiserTab = (await extension.chrome.tabs.query({})).find(
        (tab) => tab.url?.endsWith('/sidepanel.html'),
      );
      if (initialiserTab?.id !== undefined) {
        await extension.chrome.tabs.remove(initialiserTab.id);
      }
      await extension.chrome.tabs.update(sourceTab.id, { active: true });
      return {
        targetSpaceId: targetSpace.id,
        targetTabId: targetTab.id,
        windowId: sourceTab.windowId,
      };
    }, 'https://source-space.test/');

    await sourcePage.bringToFront();
    await sourcePage.keyboard.press(searchShortcut);
    const { search, searchFrame } = await searchOverlay(sourcePage);
    await search.fill('Switch to Target Space');
    await searchFrame.getByRole('option', {
      name: 'Switch to Target Space Hyper space',
    }).click();

    await expect.poll(async () => {
      const [tab, activeSpaceId] = await Promise.all([
        callChrome<{ active: boolean }>(worker, 'tabs.get', fixture.targetTabId),
        readActiveSpaceId(worker, fixture.windowId),
      ]);
      return {
        active: tab.active,
        activeSpaceId,
        targetSpaceId: fixture.targetSpaceId,
      };
    }, { timeout: 10_000 }).toEqual({
      active: true,
      activeSpaceId: fixture.targetSpaceId,
      targetSpaceId: fixture.targetSpaceId,
    });
  });
});

test('focuses the Hyper new-tab search and closes sidebar Search', async () => {
  await withShortcutBrowser('newtab-shortcut', async ({ context, worker }) => {
    const sidepanel = context.pages()[0] ?? await context.newPage();
    await sidepanel.goto(sidepanelUrl(worker));
    const sidebarSearchButton = sidepanel.getByRole('button', {
      name: 'Search tabs and history',
    });
    const sidebarSearch = sidepanel.getByRole('combobox', searchName);
    await sidebarSearchButton.click();
    await expect(sidebarSearch).toBeVisible();

    const newtab = await context.newPage();
    await newtab.goto(`${extensionBaseUrl(worker)}/newtab.html`);
    const newtabSearch = newtab.getByRole('combobox', searchName);
    const brand = newtab.locator('.newtab-brand');
    await expect(brand).toHaveAttribute('aria-label', 'Hyper');
    const brandPresentation = await brand.evaluate((element) => {
      const glyph = getComputedStyle(element, '::before');
      return {
        animationDuration: glyph.animationDuration,
        background: getComputedStyle(element).backgroundColor,
        dotContent: getComputedStyle(element, '::after').content,
        glyphAnimation: glyph.animationName,
        glyphBackground: glyph.backgroundImage,
        glyphContent: glyph.content,
        glyphPaddingTop: glyph.paddingTop,
        glyphSize: glyph.fontSize,
      };
    });
    expect(brandPresentation.glyphContent).toContain('𝒉');
    expect(brandPresentation.glyphAnimation).toBe('hyper-mark-gradient-spin');
    expect(brandPresentation.glyphBackground).toContain('conic-gradient');
    expect(brandPresentation.glyphBackground).toContain('at 100% 75%');
    expect(brandPresentation.glyphBackground).toContain('60%');
    expect(brandPresentation.glyphBackground).toContain('80%');
    expect(brandPresentation.glyphPaddingTop).toBe('2px');
    expect(brandPresentation.glyphSize).toBe('27px');
    expect(brandPresentation.animationDuration).toBe('40s');
    expect(brandPresentation.background).toBe('rgb(255, 255, 255)');
    expect(brandPresentation.dotContent).toBe('none');
    const initialGradientAngle = await brand.evaluate((element) =>
      getComputedStyle(element, '::before').getPropertyValue('--hyper-mark-angle'));
    await expect.poll(() => brand.evaluate((element) =>
      getComputedStyle(element, '::before').getPropertyValue('--hyper-mark-angle')))
      .not.toBe(initialGradientAngle);
    await newtab.emulateMedia({ reducedMotion: 'reduce' });
    await expect.poll(() => brand.evaluate((element) => {
      const glyph = getComputedStyle(element, '::before');
      return {
        angle: glyph.getPropertyValue('--hyper-mark-angle'),
        animation: glyph.animationName,
      };
    })).toEqual({ angle: '150deg', animation: 'none' });
    await newtab.emulateMedia({ reducedMotion: 'no-preference' });
    await expect(newtabSearch).toBeFocused();
    await expect(sidebarSearch).toHaveCount(0);

    await focusBody(newtab);
    await expect(newtabSearch).not.toBeFocused();
    await newtab.locator('main').click({ position: { x: 4, y: 4 } });
    await expect(newtabSearch).toBeFocused();
    await focusBody(newtab);
    await newtab.keyboard.press(searchShortcut);
    await expect(newtabSearch).toBeFocused();
    await expect(sidebarSearch).toHaveCount(0);
  });
});