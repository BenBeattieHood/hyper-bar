import {
  expect,
  test,
  type Frame,
  type Locator,
  type Page,
  type Worker,
} from '@playwright/test';
import { waitForActivationQuiescence } from './fixtures/activation';
import { localBookmarksRootId } from './fixtures/localBookmarks';
import {
  extensionBaseUrl,
  openSidepanel,
  reloadHyperExtension,
  routeHtml,
  withProfile,
} from './helpers/extension';
import { exposeMotionTabsAsAudible, setMotionTabAudible } from './helpers/media';
import { createMotionFixture, launchMotionFixture, settleMotionFixture } from './helpers/motion';
import {
  permissionRequests,
  recordPermissionRequests,
  settledPermissionRequests,
} from './helpers/permissions';
import { beginPointerDrag, dragWithPointer, spaceDotById } from './helpers/sidebar';
import { movePointerToCenter } from './helpers/pointer';
import type { ExtensionGlobal } from './helpers/extensionGlobal';
import { bookmarkChildren, bookmarkParentId, callChrome } from './helpers/chrome';
import { activeTabId, browserTab, createTab } from './helpers/tabs';

/** A page whose muted video plays a canvas stream, so it plays without a media file. */
const playingVideoPage = `<!doctype html>
  <title>Shared motion page</title>
  <canvas width="8" height="8"></canvas>
  <video autoplay muted></video>
  <script>
    const canvas = document.querySelector('canvas');
    const context = canvas.getContext('2d');
    let frame = 0;
    setInterval(() => {
      context.fillStyle = frame++ % 2 ? '#000' : '#fff';
      context.fillRect(0, 0, canvas.width, canvas.height);
    }, 100);
    const video = document.querySelector('video');
    video.srcObject = canvas.captureStream(10);
    void video.play();
  </script>`;

/** Brings the first shared motion tab forward, since Chrome holds media back in tabs never shown. */
async function activateMotionMediaTab(worker: Worker): Promise<number> {
  return worker.evaluate(async () => {
    const runtime = globalThis as unknown as ExtensionGlobal;
    const mediaTab = (await runtime.chrome.tabs.query({})).find((tab) =>
      tab.id !== undefined && (tab.pendingUrl ?? tab.url)
        ?.startsWith('https://motion.test/shared'));
    if (mediaTab?.id === undefined) throw new Error('The media tab was not created');
    await runtime.chrome.tabs.update(mediaTab.id, { active: true });
    return mediaTab.id;
  });
}

/** Asks the tab's Hyper page script what is playing, or says no script answered. */
function pageScriptMediaState(worker: Worker, tabId: number): Promise<string> {
  return worker.evaluate(async (targetTabId) => {
    const runtime = globalThis as unknown as ExtensionGlobal;
    return runtime.chrome.tabs.sendMessage(targetTabId, {
      type: 'hyper:media-control',
      action: 'inspect',
    }).then((result) => result?.state ?? 'none', () => 'unreachable');
  }, tabId);
}

async function tabIsActive(worker: Worker, tabId: number): Promise<boolean> {
  return (await browserTab(worker, tabId)).active;
}

/** Opens in-page Search from the page's own content, as the user's shortcut does. */
async function openPageSearch(webpage: Page): Promise<Frame> {
  await webpage.locator('main').click();
  await webpage.keyboard.press(process.platform === 'darwin' ? 'Meta+P' : 'Control+P');
  await expect(webpage.locator('#hyper-search-overlay-host')).toHaveAttribute('data-open', 'true');
  await expect.poll(() => webpage.frames().some((frame) =>
    frame.url().includes('mode=search-overlay'))).toBe(true);
  const frame = webpage.frames().find((candidate) =>
    candidate.url().includes('mode=search-overlay'));
  if (!frame) throw new Error('The in-page Search frame did not open.');
  return frame;
}

function audioStateExpectation(tabOverlay: Locator, bookmarkOverlay: Locator) {
  return async (state: 'paused' | 'playing') => {
    await expect(tabOverlay).toHaveAttribute('data-audio-state', state);
    await expect(bookmarkOverlay).toHaveAttribute('data-audio-state', state);
  };
}

/** Rendered widths run from `from` to `to` through at least one in-between frame. */
function expectWidthTransition(widths: number[], from: number, to: number): void {
  expect(widths[0]).toBeCloseTo(from, 0);
  expect(widths.at(-1)).toBeCloseTo(to, 0);
  expect(widths.some((width) => width > 31 && width < 59)).toBe(true);
}

test('controls and bookmarks an audible tab from pagination', () => withProfile('media-control', async (profile) => {
  const { fixture, page, worker } = await launchMotionFixture(
    profile,
    'Shared motion page',
    { reducedMotion: 'no-preference' },
  );
  // Prune any stray space the background's structure repair created and let the
  // model settle on the seeded First space before the sidebar connects, so the
  // media tab's committed ownership is a fixture space rather than a race space.
  await settleMotionFixture(worker, fixture);
  await waitForActivationQuiescence(worker);
  const localFolderIds = await worker.evaluate(async ({
    firstRootId,
    secondRootId,
  }) => {
    const extension = globalThis as unknown as ExtensionGlobal;
    const [first, second] = await Promise.all([
      extension.chrome.bookmarks.create({
        parentId: firstRootId,
        title: 'First space media folder',
      }),
      extension.chrome.bookmarks.create({
        parentId: secondRootId,
        title: 'Second space media folder',
      }),
    ]);
    return { first: first.id, second: second.id };
  }, {
    firstRootId: await localBookmarksRootId(worker, fixture.firstSpaceId),
    secondRootId: await localBookmarksRootId(worker, fixture.secondSpaceId),
  });
  await openSidepanel(page, worker);

  const silentFooter = await page.locator('.space-pagination').evaluate((footer) => {
    const mediaRail = footer.querySelector<HTMLElement>('.space-pagination-rail-start');
    const dots = footer.querySelector<HTMLElement>('.space-pagination-items');
    return {
      dotsLeft: dots?.getBoundingClientRect().left,
      dotsWidth: dots?.getBoundingClientRect().width,
      mediaWidth: mediaRail?.getBoundingClientRect().width,
    };
  });
  expect(silentFooter.mediaWidth).toBe(0);
  await expect(page.getByRole('region', { name: 'Now playing' })).toHaveCount(0);
  await exposeMotionTabsAsAudible(page, worker);
  await page.reload();

  const nowPlaying = page.getByRole('region', { name: 'Now playing' });
  const mediaTabButton = nowPlaying.locator('.now-playing-source');
  await expect(nowPlaying).toBeVisible();
  await expect(mediaTabButton).toHaveAttribute('aria-label', /^Open audio tab:/);
  const mediaTabId = await nowPlaying.getAttribute('data-tab-id');
  if (!mediaTabId) throw new Error('Now Playing did not identify its selected tab');
  const mediaSpaceId = await worker.evaluate(async (tabId) => {
    const extension = globalThis as unknown as ExtensionGlobal;
    const key = `tabSpaceId:${tabId}`;
    const stored = (await extension.chrome.storage.session.get(key))[key];
    if (typeof stored === 'string') return stored;
    if (stored && typeof stored === 'object' && 'spaceId' in stored) {
      return (stored as { spaceId?: unknown }).spaceId;
    }
    return undefined;
  }, Number(mediaTabId));
  if (mediaSpaceId !== fixture.firstSpaceId && mediaSpaceId !== fixture.secondSpaceId) {
    throw new Error('The media tab did not belong to a fixture space');
  }
  const mediaSpace = mediaSpaceId === fixture.firstSpaceId
    ? { folderId: localFolderIds.first, title: 'First space' }
    : { folderId: localFolderIds.second, title: 'Second space' };
  const otherSpace = mediaSpaceId === fixture.firstSpaceId
    ? { folderId: localFolderIds.second, title: 'Second space' }
    : { folderId: localFolderIds.first, title: 'First space' };
  await page.getByRole('button', { name: `Open ${otherSpace.title}` }).click();
  await expect(page.getByRole('region', { name: otherSpace.title })).toBeVisible();
  await expect(page.locator(
    `[data-bookmark-node-id="${otherSpace.folderId}"]`,
  )).toBeVisible();
  await expect(page.locator(
    `[data-bookmark-node-id="${mediaSpace.folderId}"]`,
  )).toHaveCount(0);
  await expect(nowPlaying).toHaveCSS('opacity', '0.8');
  await expect(nowPlaying).toHaveCSS('transition-property', 'opacity');
  await expect(nowPlaying).toHaveCSS('transition-duration', '0.18s');
  await nowPlaying.hover();
  await expect(nowPlaying).toHaveCSS('opacity', '1');
  await expect(mediaTabButton).toHaveAttribute('title', /.+/);
  await expect(page.locator(
    '.space-pagination-rail-start > .now-playing-slot',
  )).toHaveCount(1);
  await expect(page.locator(
    '.space-pagination-rail-end',
  )).toHaveCount(0);
  const footerColumns = await page.locator('.space-pagination').evaluate((footer) => {
    const style = getComputedStyle(footer);
    const mediaRail = footer.querySelector<HTMLElement>('.space-pagination-rail-start');
    const dots = footer.querySelector<HTMLElement>('.space-pagination-items');
    const dotsBounds = dots?.getBoundingClientRect();
    return {
      columns: style.gridTemplateColumns,
      dotsLeft: dotsBounds?.left,
      dotsWidth: dotsBounds?.width,
      mediaWidth: mediaRail?.getBoundingClientRect().width,
    };
  });
  expect(footerColumns.mediaWidth).toBe(56);
  expect(footerColumns.dotsLeft).toBe((silentFooter.dotsLeft ?? 0) + 61);
  expect(footerColumns.dotsWidth).toBe((silentFooter.dotsWidth ?? 0) - 61);
  const bookmarkedTabRow = page.locator(
    `.tab-row[data-tab-id="${mediaTabId}"]:visible`,
  ).last();
  await expect(bookmarkedTabRow).toHaveCount(0);
  const mediaFaviconSrc = await mediaTabButton.locator('.favicon img')
    .getAttribute('src');
  const mediaIconCube = mediaTabButton.locator('.now-playing-source-icon-cube');
  await expect(mediaIconCube).toHaveAttribute('data-icon-state', 'media');
  const previousTabId = await createTab(worker, 'https://motion.test/previous-visible-tab');
  const activeBrowserTabId = () => activeTabId(worker);
  await expect.poll(activeBrowserTabId).toBe(previousTabId);
  await mediaTabButton.click();
  const mediaSpaceButton = page.getByRole('button', {
    name: `Open ${mediaSpace.title}`,
  });
  await expect(mediaSpaceButton).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('region', { name: mediaSpace.title })).toBeVisible();
  await expect(bookmarkedTabRow).toBeVisible();
  await expect(page.locator(
    `[data-bookmark-node-id="${mediaSpace.folderId}"]`,
  )).toBeVisible();
  await expect(page.locator(
    `[data-bookmark-node-id="${otherSpace.folderId}"]`,
  )).toHaveCount(0);
  await expect(mediaTabButton).toHaveAttribute(
    'aria-label',
    /^Return to previous tab: /,
  );
  const returnIcon = mediaTabButton.locator('.now-playing-return-icon');
  await expect(returnIcon).toBeVisible();
  await expect(returnIcon).toHaveClass(/lucide-arrow-left/);
  await expect(mediaIconCube).toHaveAttribute('data-icon-state', 'return');
  await expect(mediaIconCube).toHaveCSS('transform-style', 'preserve-3d');
  await expect(mediaIconCube).toHaveCSS('transition-duration', '0.36s');
  await expect(mediaTabButton.locator('.favicon img')).toHaveAttribute(
    'src',
    mediaFaviconSrc ?? '',
  );
  await mediaTabButton.click();
  await expect.poll(activeBrowserTabId).toBe(previousTabId);
  await expect(mediaTabButton).toHaveAttribute('aria-label', /^Open audio tab:/);
  await expect(mediaIconCube).toHaveAttribute('data-icon-state', 'media');
  await expect(mediaTabButton.locator('.favicon img')).toHaveAttribute(
    'src',
    mediaFaviconSrc ?? '',
  );
  await mediaTabButton.click();
  await expect.poll(activeBrowserTabId).toBe(Number(mediaTabId));
  await callChrome(worker, 'tabs.remove', previousTabId);
  await expect(mediaTabButton).toHaveAttribute('aria-label', /^Open audio tab:/);
  const audibleTabOverlay = bookmarkedTabRow.locator('.favicon-audio-overlay');
  const audibleBookmarkOverlay = page.locator(
    `[data-bookmark-node-id="${fixture.bookmarkId}"] .favicon-audio-overlay`,
  );
  const expectAudioState = audioStateExpectation(audibleTabOverlay, audibleBookmarkOverlay);
  await expect.poll(async () => {
    await setMotionTabAudible(page, worker, true);
    return audibleTabOverlay.count();
  }).toBe(1);
  await expect(audibleTabOverlay).toBeVisible();
  await expect(audibleTabOverlay.locator(':scope > rect')).toHaveCount(4);
  await expect(audibleBookmarkOverlay).toBeVisible();
  await expect(audibleBookmarkOverlay.locator(':scope > rect')).toHaveCount(4);
  await expectAudioState('playing');
  await expect(audibleTabOverlay).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  const audioColours = await audibleTabOverlay.evaluate((overlay) => ({
    bar: getComputedStyle(overlay.querySelector('rect') as SVGRectElement).fill,
    text: getComputedStyle(overlay).color,
  }));
  expect(audioColours.bar).toBe(audioColours.text);
  await expect(bookmarkedTabRow.locator('.favicon-top-left-overlay')).toHaveCount(0);
  const removeBookmark = bookmarkedTabRow.locator('.tab-bookmark-indicator.is-remove');
  await expect(removeBookmark).toBeVisible();
  await expect(removeBookmark).toHaveAccessibleName(/Remove bookmark for /);
  await expect(removeBookmark).toHaveCSS('border-top-width', '0px');
  await expect(removeBookmark).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  const bookmarkIcon = removeBookmark.locator('.tab-bookmark-icon');
  await expect(bookmarkIcon).toHaveAttribute('data-bookmark-icon-state', 'bookmarked');
  await expect(bookmarkIcon.locator('.tab-bookmark-icon-artwork')).toHaveCount(1);
  await expect(bookmarkedTabRow.locator('.tab-content > .tab-close')).toHaveCount(1);
  await expect(bookmarkedTabRow.locator(':scope > .tab-bookmark-indicator')).toHaveCount(1);
  await expect(bookmarkedTabRow.locator(
    ':scope > .bookmark-space-links + .tab-bookmark-indicator',
  )).toHaveCount(1);
  await worker.evaluate(async ({ firstSpaceId, tabId }) => {
    const extension = globalThis as unknown as ExtensionGlobal;
    const spacesRootId = (await extension.chrome.bookmarks.get(firstSpaceId))[0]?.parentId;
    const mediaTab = await extension.chrome.tabs.get(tabId);
    const url = mediaTab.pendingUrl ?? mediaTab.url;
    if (!spacesRootId || !url) throw new Error('Media space fixture was incomplete');
    const thirdSpace = await extension.chrome.bookmarks.create({
      parentId: spacesRootId,
      title: 'Third space',
    });
    const thirdTab = await extension.chrome.tabs.create({ active: false, url });
    if (thirdTab.id === undefined) throw new Error('Third-space tab was not created');
    await extension.chrome.storage.session.set({
      [`tabSpaceId:${thirdTab.id}`]: thirdSpace.id,
    });
  }, {
    firstSpaceId: fixture.firstSpaceId,
    tabId: Number(mediaTabId),
  });
  await page.reload();
  await expect(bookmarkedTabRow).toBeVisible();
  const spacePicker = bookmarkedTabRow.locator(':scope > .bookmark-space-links');
  const spaceSummary = spacePicker.locator('.bookmark-space-summary');
  const summaryDots = spaceSummary.locator('.bookmark-space-summary-dot');
  await expect(summaryDots).toHaveCount(2);
  await expect(spaceSummary).toHaveCSS('border-top-width', '0px');
  await expect(spaceSummary).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  const summaryColours = await summaryDots.evaluateAll((dots) =>
    dots.map((dot) => getComputedStyle(dot).backgroundColor));
  const expansionWidths = await spacePicker.evaluate((picker) =>
    new Promise<number[]>((resolveWidths) => {
      const widths = [picker.getBoundingClientRect().width];
      const startedAt = performance.now();
      picker.querySelector<HTMLButtonElement>('.bookmark-space-summary')?.click();
      const sample = () => {
        widths.push(picker.getBoundingClientRect().width);
        if (performance.now() - startedAt < 300) requestAnimationFrame(sample);
        else resolveWidths(widths);
      };
      requestAnimationFrame(sample);
    }));
  await expect(spacePicker).toHaveClass(/is-expanded/);
  await expect(bookmarkedTabRow.locator(':scope > .tab-bookmark-indicator')).toHaveCount(0);
  const expandedIndicators = spacePicker.locator('.bookmark-space-indicator');
  await expect(expandedIndicators).toHaveCount(2);
  const restingExpandedButton = spacePicker.locator('.bookmark-space-link').nth(1);
  await expect(restingExpandedButton).toHaveCSS('border-top-width', '0px');
  await expect(restingExpandedButton).toHaveCSS(
    'background-color',
    'rgba(0, 0, 0, 0)',
  );
  expect(await expandedIndicators.evaluateAll((indicators) =>
    indicators.map((indicator) => getComputedStyle(indicator).backgroundColor)))
    .toEqual(summaryColours);
  const expandedSpaceBounds = await spacePicker.boundingBox();
  if (!expandedSpaceBounds) throw new Error('Expanded space picker was not measurable');
  expectWidthTransition(expansionWidths, 30, 60);
  expect(expandedSpaceBounds.width).toBeCloseTo(60, 0);
  const collapseWidths = await spacePicker.evaluate((picker) =>
    new Promise<number[]>((resolveWidths) => {
      const bounds = picker.getBoundingClientRect();
      const widths = [bounds.width];
      const startedAt = performance.now();
      document.dispatchEvent(new PointerEvent('pointermove', {
        bubbles: true,
        clientX: bounds.x + bounds.width / 2,
        clientY: bounds.bottom + 25,
      }));
      const sample = () => {
        widths.push(picker.getBoundingClientRect().width);
        if (performance.now() - startedAt < 300) requestAnimationFrame(sample);
        else resolveWidths(widths);
      };
      requestAnimationFrame(sample);
    }));
  await expect(spacePicker).toHaveClass(/is-collapsed/);
  expectWidthTransition(collapseWidths, 60, 30);
  await expect(bookmarkedTabRow.locator(':scope > .tab-bookmark-indicator')).toHaveCount(1);
  await spaceSummary.focus();
  await page.keyboard.press('Enter');
  const firstSpaceChoice = spacePicker.locator(
    '.bookmark-space-link:not(.bookmark-space-summary)',
  ).first();
  await expect(firstSpaceChoice).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(spaceSummary).toBeFocused();
  await expect(bookmarkedTabRow.locator(':scope > .tab-bookmark-indicator')).toHaveCount(1);
  const [closeBounds, spaceBounds] = await Promise.all([
    bookmarkedTabRow.locator('.tab-close').boundingBox(),
    bookmarkedTabRow.locator('.bookmark-space-links').boundingBox(),
  ]);
  expect(closeBounds).not.toBeNull();
  expect(spaceBounds).not.toBeNull();
  expect(closeBounds!.x).toBeLessThan(spaceBounds!.x);

  const muteControl = nowPlaying.getByRole('button', { name: /^Mute / });
  await setMotionTabAudible(page, worker, false);
  await expect(nowPlaying).toBeVisible();
  await expect(nowPlaying).toHaveClass(/is-unavailable/);
  await expect(nowPlaying).toHaveCSS('opacity', '0.45');
  await expect(muteControl).toBeDisabled();

  await setMotionTabAudible(page, worker, true);
  await expect(nowPlaying).not.toHaveClass(/is-unavailable/);
  await expect(muteControl).toBeEnabled();
  await page.waitForTimeout(1_100);
  await expect(nowPlaying).toBeVisible();

  const unavailableAt = Date.now();
  await setMotionTabAudible(page, worker, false);
  await expect(muteControl).toBeDisabled();
  await page.waitForTimeout(Math.max(0, 900 - (Date.now() - unavailableAt)));
  await expect(nowPlaying).toBeVisible();
  await expect(nowPlaying).toHaveClass(/is-unavailable/);
  await expect(nowPlaying).toHaveCount(0, { timeout: 1_000 });
  expect(Date.now() - unavailableAt).toBeGreaterThanOrEqual(1_000);
  await setMotionTabAudible(page, worker, true);
  await expect(nowPlaying).toBeVisible();

  await nowPlaying.getByRole('button', { name: /^Mute / }).click();
  await expect(nowPlaying.getByRole('button', { name: /^Unmute / })).toBeVisible();
  await expectAudioState('paused');
  await expect(audibleTabOverlay.locator(':scope > rect').first())
    .toHaveCSS('animation-name', 'none');
  await nowPlaying.getByRole('button', { name: /^Unmute / }).click();
  await expectAudioState('playing');
  await expect(audibleTabOverlay.locator(':scope > rect').first())
    .toHaveCSS('animation-name', 'favicon-audio-level');

  await dragWithPointer(page, mediaTabButton, page.locator('.favourite-placeholder').first());
  await expect(page.locator('.favourite-tile.is-pinned')).toHaveCount(1);

  const bookmarkFolder = page.locator(
    `[data-bookmark-node-id="${fixture.outerBookmarkFolderId}"] .folder-item`,
  );
  await dragWithPointer(page, mediaTabButton, bookmarkFolder);
  await expect.poll(async () => (await bookmarkChildren(worker, fixture.outerBookmarkFolderId))
    .some((child) => child.url?.startsWith('https://motion.test/shared'))).toBe(true);

  await mediaTabButton.click();
  await expect.poll(() => worker.evaluate(async () => {
    const extension = globalThis as unknown as ExtensionGlobal;
    const [activeTab] = await extension.chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    return activeTab?.url;
  })).toMatch(/^https:\/\/motion\.test\/shared/);

  await beginPointerDrag(page, bookmarkedTabRow.locator('.tab-main'));
  await expect(nowPlaying).toHaveClass(/is-disabled/);
  await expect(nowPlaying).toHaveAttribute('aria-disabled', 'true');
  await expect(mediaTabButton).toBeDisabled();
  await expect(nowPlaying).toHaveCSS('filter', 'grayscale(1)');
  await page.keyboard.press('Escape');
  await page.mouse.up();

  const outerFolder = page.locator(
    `[data-bookmark-node-id="${fixture.outerBookmarkFolderId}"] .tree-item-main`,
  );
  await beginPointerDrag(page, outerFolder);
  await expect(nowPlaying).toHaveClass(/is-disabled/);
  await expect(mediaTabButton).toBeDisabled();
  await page.keyboard.press('Escape');
  await page.mouse.up();

  const localFolder = page.locator(
    `[data-bookmark-node-id="${mediaSpace.folderId}"] .tree-item-main`,
  );
  const otherSpaceId = mediaSpaceId === fixture.firstSpaceId
    ? fixture.secondSpaceId
    : fixture.firstSpaceId;
  const otherSpaceRootId = await localBookmarksRootId(worker, otherSpaceId);
  await beginPointerDrag(page, localFolder);
  await expect(nowPlaying).toHaveClass(/is-disabled/);
  const currentSpaceDropTarget = spaceDotById(page, mediaSpaceId);
  await expect(currentSpaceDropTarget).toHaveClass(/is-drop-disabled/);
  await expect(currentSpaceDropTarget).toBeDisabled();
  await expect(currentSpaceDropTarget).toHaveCSS('opacity', '0.38');
  const otherSpaceDropTarget = spaceDotById(page, otherSpaceId);
  await expect(otherSpaceDropTarget).toHaveClass(/is-drop-target/);
  await expect(otherSpaceDropTarget).not.toBeDisabled();
  await movePointerToCenter(page, otherSpaceDropTarget, 'Other space drop target was not measurable');
  await expect(otherSpaceDropTarget).toHaveClass(/is-over/);
  await page.mouse.up();
  await expect.poll(async () =>
    await bookmarkParentId(worker, mediaSpace.folderId) === otherSpaceRootId).toBe(true);
}));

test('uses play and pause without page-search access', () => withProfile('media-playback', async (profile) => {
  const { context, worker } = await profile.launchExtension({ closeInitialPage: true });
  const page = await context.newPage();
  await routeHtml(context, 'https://motion.test/**', playingVideoPage);
  const fixture = await createMotionFixture(worker);
  await activateMotionMediaTab(worker);
  await expect.poll(() => worker.evaluate(async () => {
    const runtime = globalThis as unknown as ExtensionGlobal;
    const tabs = (await runtime.chrome.tabs.query({})).filter((tab) =>
      tab.id !== undefined && (tab.pendingUrl ?? tab.url)
        ?.startsWith('https://motion.test/shared'));
    const states = await Promise.all(tabs.map((tab) => runtime.chrome.tabs.sendMessage(
      tab.id as number,
      { type: 'hyper:media-control', action: 'inspect' },
    ).then((result) => result?.state).catch(() => undefined)));
    return states.filter((state) => state === 'playing').length;
  })).toBeGreaterThan(0);
  await exposeMotionTabsAsAudible(page, worker);
  await openSidepanel(page, worker);

  await expect.poll(() => page.evaluate(async () => {
    const runtime = globalThis as unknown as ExtensionGlobal;
    return runtime.chrome.permissions.contains({ permissions: ['scripting'] });
  })).toBe(false);
  const nowPlaying = page.getByRole('region', { name: 'Now playing' });
  await page.getByRole('button', { name: 'Open First space' }).click();
  await expect(page.getByRole('region', { name: 'First space' })).toBeVisible();
  const mediaTabId = await nowPlaying.getAttribute('data-tab-id');
  if (!mediaTabId) throw new Error('Now Playing did not identify its selected tab');
  const audibleTabOverlay = page.locator(
    `.tab-row[data-tab-id="${mediaTabId}"]:visible .favicon-audio-overlay`,
  );
  const audibleBookmarkOverlay = page.locator(
    `[data-bookmark-node-id="${fixture.bookmarkId}"] .favicon-audio-overlay`,
  );
  const playbackIcon = nowPlaying.locator('[data-playback-icon="true"]');
  const playbackIconPath = playbackIcon.locator('path');
  const pausePath = 'M4 3 L4 15 L8 15 L8 3 Z M10 3 L10 15 L14 15 L14 3 Z';
  const playPath = 'M5 3 L5 9 L14 9 L5 3 Z M5 9 L5 15 L14 9 L5 9 Z';
  const expectAudioState = audioStateExpectation(audibleTabOverlay, audibleBookmarkOverlay);
  const audioBarBoxes = () => audibleTabOverlay.locator(':scope > rect').evaluateAll(
    (rects) => rects.map((rect) => {
      const bounds = (rect as SVGGraphicsElement).getBBox();
      return [bounds.x, bounds.y, bounds.width, bounds.height];
    }),
  );
  const expectPlayback = async (state: 'paused' | 'playing', barBoxes: number[][]) => {
    await expect(nowPlaying.getByRole('button', {
      name: state === 'paused' ? /^Play / : /^Pause /,
    })).toBeVisible();
    await expect(playbackIcon).toHaveAttribute('data-playback-state', state);
    await expect.poll(() => playbackIconPath.getAttribute('d'))
      .toBe(state === 'paused' ? playPath : pausePath);
    await expectAudioState(state);
    await expect.poll(audioBarBoxes).toEqual(barBoxes);
  };
  await expect(nowPlaying.getByRole('button', { name: /^Pause / })).toBeVisible();
  await expect(nowPlaying.getByRole('button', { name: /^(Mute|Unmute) / })).toHaveCount(0);
  await expect(playbackIcon).toHaveAttribute('data-playback-state', 'playing');
  await expect.poll(() => playbackIconPath.getAttribute('d')).toBe(pausePath);
  await expect(audibleTabOverlay.locator(':scope > rect')).toHaveCount(4);
  await expectAudioState('playing');

  await nowPlaying.getByRole('button', { name: /^Open audio tab:/ }).click();
  await expect.poll(() => context?.pages().filter((candidate) =>
    candidate.url().startsWith('https://motion.test/shared')).length).toBeGreaterThan(0);
  const mediaPage = context.pages().find((candidate) =>
    candidate.url().startsWith('https://motion.test/shared'));
  if (!mediaPage) throw new Error('The selected media page was not exposed to Playwright');
  await mediaPage.locator('video').evaluate((video: HTMLVideoElement) => video.pause());
  await expectPlayback('paused', [
    [2, 5, 0, 0],
    [2, 2, 2, 6],
    [6, 2, 2, 6],
    [8, 5, 0, 0],
  ]);

  await mediaPage.locator('video').evaluate((video: HTMLVideoElement) => video.play());
  await expectPlayback('playing', [
    [1, 2, 2, 6],
    [4, 4, 2, 4],
    [4, 4, 2, 4],
    [7, 3, 2, 5],
  ]);

  await nowPlaying.getByRole('button', { name: /^Pause / }).click();
  await expect(nowPlaying.getByRole('button', { name: /^Play / })).toBeVisible();
  await expect(nowPlaying.getByRole('button', { name: /^(Mute|Unmute) / })).toHaveCount(0);
  await expectAudioState('paused');
  await expect(audibleTabOverlay.locator(':scope > rect').first())
    .toHaveCSS('animation-name', 'none');

  await nowPlaying.getByRole('button', { name: /^Play / }).click();
  await expect(nowPlaying.getByRole('button', { name: /^Pause / })).toBeVisible();
  await expectAudioState('playing');

  const nextMediaTabId = await worker.evaluate(async (currentTabId) => {
    const runtime = globalThis as unknown as ExtensionGlobal;
    const nextTab = (await runtime.chrome.tabs.query({})).find((tab) =>
      tab.id !== undefined &&
      tab.id !== currentTabId &&
      (tab.pendingUrl ?? tab.url)?.startsWith('https://motion.test/shared'));
    if (nextTab?.id === undefined) throw new Error('The second media tab was not found');
    await runtime.chrome.tabs.update(nextTab.id, {
      url: 'https://motion.test/next-media',
    });
    return nextTab.id;
  }, Number(mediaTabId));
  await expect.poll(() => pageScriptMediaState(worker, nextMediaTabId)).toBe('playing');
  await setMotionTabAudible(page, worker, true, nextMediaTabId);
  await expect(nowPlaying).toHaveAttribute('data-tab-id', String(nextMediaTabId));
  await expect(nowPlaying.getByRole('button', { name: /^Pause / })).toBeVisible();
  await expect.poll(() => worker.evaluate(async ({ currentTabId, nextTabId }) => {
    const runtime = globalThis as unknown as ExtensionGlobal;
    const [current, next] = await Promise.all([
      runtime.chrome.tabs.sendMessage(currentTabId, {
        type: 'hyper:media-control',
        action: 'inspect',
      }),
      runtime.chrome.tabs.sendMessage(nextTabId, {
        type: 'hyper:media-control',
        action: 'inspect',
      }),
    ]);
    return { current: current?.state, next: next?.state };
  }, {
    currentTabId: Number(mediaTabId),
    nextTabId: nextMediaTabId,
  })).toEqual({ current: 'paused', next: 'playing' });
}));

test('offers to restore play and pause after Hyper reloads', () => withProfile('media-access', async (profile) => {
  const launched = await profile.launchHyper({ closeInitialPage: true });
  const { context } = launched;
  let { page, worker } = launched;
  await routeHtml(context, 'https://motion.test/**', playingVideoPage);
  await createMotionFixture(worker);
  const mediaTabId = await activateMotionMediaTab(worker);
  await expect.poll(() => pageScriptMediaState(worker, mediaTabId)).toBe('playing');

  ({ page, worker } = await reloadHyperExtension(context, worker));
  // Chrome keeps the old page script in open pages, cut off from the reloaded Hyper.
  await expect.poll(() => pageScriptMediaState(worker, mediaTabId)).toBe('unreachable');
  await exposeMotionTabsAsAudible(page, worker);
  await recordPermissionRequests(worker);
  await openSidepanel(page, worker);
  await setMotionTabAudible(page, worker, true, mediaTabId);

  const nowPlaying = page.getByRole('region', { name: 'Now playing' });
  await expect(nowPlaying).toHaveAttribute('data-tab-id', String(mediaTabId));
  await expect(nowPlaying.getByRole('button', { name: /^(Mute|Unmute) / })).toBeVisible();
  await expect(nowPlaying.getByRole('button', { name: /^(Pause|Play) / })).toHaveCount(0);

  const notice = page.locator('.topbar .countdown-notice');
  await expect(notice.getByRole('status')).toHaveText('Fix play/pause?');
  await notice.getByRole('button', { name: 'Yes, do it' }).click();
  await expect.poll(async () =>
    (await permissionRequests(worker)).map((request) => request.access)).toEqual([
    { origins: ['https://motion.test/*'], permissions: ['scripting'] },
  ]);
  const [request] = await settledPermissionRequests(worker);
  // Chrome refuses at once outside a gesture; otherwise its prompt waits for an answer.
  expect(request?.outcome).not.toMatch(/user gesture/);
}));

test('controls the music from Search in the sidebar, the new tab page and the page', () => withProfile('media-search', async (profile) => {
  const searchName = 'Search tabs, bookmarks, history, or commands';
  const pauseMusic = /^Pause music\s*Shared motion page$/;
  const playMusic = /^Play music\s*Shared motion page$/;
  const switchToMusic = /^Switch to music\s*Shared motion page$/;
  const { context, worker } = await profile.launchExtension({ closeInitialPage: true });
  const baseUrl = extensionBaseUrl(worker);
  const sidebar = await context.newPage();
  await routeHtml(context, 'https://motion.test/**', playingVideoPage);
  await context.route('https://quiet.test/**', (route) => route.fulfill({
    contentType: 'text/html',
    body: '<!doctype html><title>Quiet page</title><main>Quiet page</main>',
  }));
  await createMotionFixture(worker);
  const mediaTabId = await activateMotionMediaTab(worker);
  await expect.poll(() => pageScriptMediaState(worker, mediaTabId)).toBe('playing');
  await exposeMotionTabsAsAudible(sidebar, worker);
  await sidebar.goto(`${baseUrl}/sidepanel.html`);
  const nowPlaying = sidebar.getByRole('region', { name: 'Now playing' });
  await expect(nowPlaying).toHaveAttribute('data-tab-id', String(mediaTabId));
  await expect(nowPlaying.getByRole('button', { name: /^Pause / })).toBeVisible();

  // The music is in front, so the sidebar offers only what Now Playing does.
  expect(await tabIsActive(worker, mediaTabId)).toBe(true);
  await sidebar.getByRole('button', { name: 'Search tabs and history' }).click();
  await sidebar.getByRole('combobox', { name: searchName }).fill('music');
  await expect(sidebar.getByRole('option', { name: pauseMusic })).toBeVisible();
  await expect(sidebar.getByRole('option', {
    name: /^(Play|Mute|Unmute|Switch to) music/,
  })).toHaveCount(0);
  await sidebar.getByRole('option', { name: pauseMusic }).click();
  await expect.poll(() => pageScriptMediaState(worker, mediaTabId)).toBe('paused');
  await expect(nowPlaying.getByRole('button', { name: /^Play / })).toBeVisible();

  const newTab = await context.newPage();
  await newTab.goto(`${baseUrl}/newtab.html`);
  const newTabSearch = newTab.getByRole('combobox', { name: searchName });
  await newTabSearch.fill('music');
  await expect(newTab.getByRole('option', { name: switchToMusic })).toBeVisible();
  await newTab.getByRole('option', { name: playMusic }).click();
  await expect.poll(() => pageScriptMediaState(worker, mediaTabId)).toBe('playing');
  await expect(nowPlaying.getByRole('button', { name: /^Pause / })).toBeVisible();
  await newTabSearch.fill('music');
  // Like a tab result, switching to the music replaces the new tab page.
  const newTabClosed = newTab.waitForEvent('close');
  await newTab.getByRole('option', { name: switchToMusic }).click();
  await newTabClosed;
  await expect.poll(() => tabIsActive(worker, mediaTabId)).toBe(true);

  const webpage = await context.newPage();
  await webpage.goto('https://quiet.test/');
  await webpage.bringToFront();
  const pageSearch = await openPageSearch(webpage);
  await pageSearch.getByRole('combobox', { name: searchName }).fill('music');
  await expect(pageSearch.getByRole('option', { name: switchToMusic })).toBeVisible();
  await pageSearch.getByRole('option', { name: pauseMusic }).click();
  await expect.poll(() => pageScriptMediaState(worker, mediaTabId)).toBe('paused');
  await expect(webpage.locator('#hyper-search-overlay-host'))
    .toHaveAttribute('data-open', 'false');
  await openPageSearch(webpage);
  await pageSearch.getByRole('combobox', { name: searchName }).fill('music');
  await expect(pageSearch.getByRole('option', { name: playMusic })).toBeVisible();
  await pageSearch.getByRole('option', { name: switchToMusic }).click();
  await expect.poll(() => tabIsActive(worker, mediaTabId)).toBe(true);
}));
