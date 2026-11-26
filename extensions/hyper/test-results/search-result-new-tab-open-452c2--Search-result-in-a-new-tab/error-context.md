# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: search-result-new-tab.spec.ts >> opens a Ctrl/Cmd-activated new tab page Search result in a new tab
- Location: tests\e2e\search-result-new-tab.spec.ts:90:1

# Error details

```
Error: browserType.launchPersistentContext: Executable doesn't exist at C:\Users\ben\AppData\Local\ms-playwright\chromium-1234\chrome-win64\chrome.exe
╔════════════════════════════════════════════════════════════╗
║ Looks like Playwright was just installed or updated.       ║
║ Please run the following command to download new browsers: ║
║                                                            ║
║     npx playwright install                                 ║
║                                                            ║
║ <3 Playwright Team                                         ║
╚════════════════════════════════════════════════════════════╝
```

# Test source

```ts
  1   | import {
  2   |   chromium,
  3   |   expect,
  4   |   type BrowserContext,
  5   |   type Frame,
  6   |   type Page,
  7   |   type Worker,
  8   | } from '@playwright/test';
  9   | import { mkdtemp, rm } from 'node:fs/promises';
  10  | import { tmpdir } from 'node:os';
  11  | import { join, resolve } from 'node:path';
  12  | import { saveHyperPreference } from '../fixtures/preferences';
  13  | import { allBookmarks, callChrome } from './chrome';
  14  | 
  15  | export const extensionPath = resolve(process.env.HYPER_EXTENSION_PATH ?? 'output/chrome-mv3-e2e');
  16  | 
  17  | type LaunchOptions = NonNullable<Parameters<typeof chromium.launchPersistentContext>[1]>;
  18  | type GotoOptions = Parameters<Page['goto']>[1];
  19  | type RouteUrl = Parameters<BrowserContext['route']>[0];
  20  | type Viewport = { height: number; width: number };
  21  | 
  22  | export interface ExtensionSession {
  23  |   context: BrowserContext;
  24  |   worker: Worker;
  25  | }
  26  | 
  27  | export interface HyperSession extends ExtensionSession {
  28  |   page: Page;
  29  | }
  30  | 
  31  | export interface ExtensionLaunchOptions extends Omit<LaunchOptions, 'args'> {
  32  |   /** Arguments after the ones that load the extensions. */
  33  |   args?: string[];
  34  |   closeInitialPage?: boolean;
  35  |   /** Loads Hyper from this folder instead of the end-to-end build. */
  36  |   extensionPath?: string;
  37  |   /** Further unpacked extensions loaded beside Hyper. */
  38  |   extraExtensionPaths?: string[];
  39  |   /** How long to wait for Hyper's worker, instead of the action timeout. */
  40  |   workerTimeout?: number;
  41  | }
  42  | 
  43  | const isHyperWorker = (worker: Worker) => worker.url().endsWith('/background.js');
  44  | 
  45  | /** Starts a plain headless Chromium with Hyper loaded, and its service worker. */
  46  | export async function launchExtension(
  47  |   userDataDir: string,
  48  |   {
  49  |     args = [],
  50  |     channel = 'chromium',
  51  |     closeInitialPage = false,
  52  |     extensionPath: hyperPath = extensionPath,
  53  |     extraExtensionPaths = [],
  54  |     workerTimeout,
  55  |     ...options
  56  |   }: ExtensionLaunchOptions = {},
  57  | ): Promise<ExtensionSession> {
  58  |   const extensions = [hyperPath, ...extraExtensionPaths].join(',');
> 59  |   const context = await chromium.launchPersistentContext(userDataDir, {
      |                   ^ Error: browserType.launchPersistentContext: Executable doesn't exist at C:\Users\ben\AppData\Local\ms-playwright\chromium-1234\chrome-win64\chrome.exe
  60  |     channel,
  61  |     headless: true,
  62  |     ...options,
  63  |     args: [
  64  |       `--disable-extensions-except=${extensions}`,
  65  |       `--load-extension=${extensions}`,
  66  |       ...args,
  67  |     ],
  68  |   });
  69  |   if (closeInitialPage) await context.pages()[0]?.close();
  70  |   const worker = context.serviceWorkers().find(isHyperWorker) ??
  71  |     await context.waitForEvent('serviceworker', {
  72  |       predicate: isHyperWorker,
  73  |       ...(workerTimeout === undefined ? {} : { timeout: workerTimeout }),
  74  |     });
  75  |   return { context, worker };
  76  | }
  77  | 
  78  | export interface HyperLaunchOptions extends ExtensionLaunchOptions {
  79  |   enableAudio?: boolean;
  80  |   restoreLastSession?: boolean;
  81  |   viewport?: Viewport;
  82  | }
  83  | 
  84  | /**
  85  |  * Starts Chromium (or `HYPER_E2E_CHANNEL`, headed) with Hyper and the
  86  |  * space-race fixture pages, and opens the sidebar in a pinned tab once Hyper
  87  |  * has built a space's bookmarks root.
  88  |  */
  89  | export async function launchHyper(
  90  |   userDataDir: string,
  91  |   { args = [], enableAudio = false, restoreLastSession = false, viewport, ...options }: HyperLaunchOptions = {},
  92  | ): Promise<HyperSession> {
  93  |   const { context, worker } = await launchExtension(userDataDir, {
  94  |     channel: process.env.HYPER_E2E_CHANNEL ?? 'chromium',
  95  |     headless: !process.env.HYPER_E2E_CHANNEL,
  96  |     ...(enableAudio ? { ignoreDefaultArgs: ['--mute-audio'] } : {}),
  97  |     ...options,
  98  |     args: [...(restoreLastSession ? ['--restore-last-session'] : []), ...args],
  99  |   });
  100 |   await context.route('https://space-race.test/**', (route) => {
  101 |     const url = new URL(route.request().url());
  102 |     if (url.pathname === '/redirect-to-one') {
  103 |       return route.fulfill({
  104 |         status: 302,
  105 |         headers: { location: 'https://space-race.test/one' },
  106 |       });
  107 |     }
  108 |     return route.fulfill({
  109 |       contentType: 'text/html',
  110 |       body: url.pathname === '/audible'
  111 |         ? [
  112 |           '<!doctype html><title>Audible space fixture</title>',
  113 |           '<button id="start-audio">Start audio</button>',
  114 |           '<audio loop></audio>',
  115 |           '<script>',
  116 |           'document.querySelector("#start-audio").addEventListener("click", async () => {',
  117 |           '  const sampleRate = 8000;',
  118 |           '  const samples = sampleRate;',
  119 |           '  const buffer = new ArrayBuffer(44 + samples * 2);',
  120 |           '  const view = new DataView(buffer);',
  121 |           '  const write = (offset, value) => {',
  122 |           '    for (let index = 0; index < value.length; index += 1) {',
  123 |           '      view.setUint8(offset + index, value.charCodeAt(index));',
  124 |           '    }',
  125 |           '  };',
  126 |           '  write(0, "RIFF");',
  127 |           '  view.setUint32(4, 36 + samples * 2, true);',
  128 |           '  write(8, "WAVEfmt ");',
  129 |           '  view.setUint32(16, 16, true);',
  130 |           '  view.setUint16(20, 1, true);',
  131 |           '  view.setUint16(22, 1, true);',
  132 |           '  view.setUint32(24, sampleRate, true);',
  133 |           '  view.setUint32(28, sampleRate * 2, true);',
  134 |           '  view.setUint16(32, 2, true);',
  135 |           '  view.setUint16(34, 16, true);',
  136 |           '  write(36, "data");',
  137 |           '  view.setUint32(40, samples * 2, true);',
  138 |           '  for (let index = 0; index < samples; index += 1) {',
  139 |           '    view.setInt16(44 + index * 2, Math.sin(index * Math.PI * 0.11) * 12000, true);',
  140 |           '  }',
  141 |           '  const audio = document.querySelector("audio");',
  142 |           '  audio.src = URL.createObjectURL(new Blob([buffer], { type: "audio/wav" }));',
  143 |           '  await audio.play();',
  144 |           '  globalThis.hyperAudioFixture = { audio, buffer };',
  145 |           '});',
  146 |           '</script>',
  147 |         ].join('')
  148 |         : url.pathname === '/settles-elsewhere'
  149 |         ? '<!doctype html><title>Settling</title><script>setTimeout(() => location.replace("/settled"), 300)</script>'
  150 |         : url.pathname === '/auto-redirect-source'
  151 |         ? '<!doctype html><script>location.href = "/redirect-to-one"</script>'
  152 |         : url.pathname === '/link-source'
  153 |           ? [
  154 |             '<!doctype html>',
  155 |             '<a target="_blank" href="/redirect-to-one">Open redirect</a>',
  156 |             '<a target="_blank" rel="noopener" href="/redirect-to-one">Open noopener redirect</a>',
  157 |             '<a target="_blank" href="http://redirect.test/to-one">Open HTTP redirect</a>',
  158 |             '<a href="/redirect-to-one">Follow redirect</a>',
  159 |           ].join('')
```