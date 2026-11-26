import { expect, test, type Locator } from '@playwright/test';
import { waitForActivationQuiescence } from './fixtures/activation';
import { localBookmarksRootId } from './fixtures/localBookmarks';
import { paintedCustomProperty } from './fixtures/styles';
import {
  createMotionFixture,
  highlightExitSamples,
  launchMotionFixture,
  sampleHighlightEntry,
  settleMotionFixture,
  startHighlightExitSampling,
} from './helpers/motion';
import {
  beginPointerDrag,
  clickSelectionWithModifierReleased,
  dragMarqueeSelection,
  spaceDotById,
} from './helpers/sidebar';
import { movePointerToCenter } from './helpers/pointer';
import { activateTab, activeTabId, navigateTab, tabUrl } from './helpers/tabs';
import type { ExtensionGlobal } from './helpers/extensionGlobal';
import { tabRowSelector } from './helpers/rows';
import { bookmarkChildren, bookmarkParentId } from './helpers/chrome';
import { extensionBaseUrl, openSidepanel, withProfile } from './helpers/extension';

test('moves bookmarks, folders, and selected tabs through pagination roots', () => withProfile('multi-drag', async (profile) => {
  const { fixture, page, worker } = await launchMotionFixture(profile, 'Multi drag fixture');
  const firstSpaceRootId = await localBookmarksRootId(worker, fixture.firstSpaceId);
  const secondSpaceRootId = await localBookmarksRootId(worker, fixture.secondSpaceId);
  const dragFixture = await worker.evaluate(async ({ localRootId, spaceId }) => {
    const extension = globalThis as unknown as ExtensionGlobal;
    const tabs = await Promise.all([
      extension.chrome.tabs.create({
        active: false,
        url: 'https://motion.test/multi-tab-one',
      }),
      extension.chrome.tabs.create({
        active: false,
        url: 'https://motion.test/multi-tab-two',
      }),
    ]);
    const tabIds = tabs.flatMap((tab) => tab.id === undefined ? [] : [tab.id]);
    if (tabIds.length !== 2) throw new Error('Multi-drag tabs were not created');
    await extension.chrome.storage.session.set(Object.fromEntries(
      tabIds.map((tabId) => [`tabSpaceId:${tabId}`, spaceId]),
    ));
    const localFolder = await extension.chrome.bookmarks.create({
      parentId: localRootId,
      title: 'Local drag folder',
    });
    const localBookmark = await extension.chrome.bookmarks.create({
      parentId: localRootId,
      title: 'Local drag bookmark',
      url: 'https://motion.test/local-drag-bookmark',
    });
    const deletableBookmark = await extension.chrome.bookmarks.create({
      parentId: localRootId,
      title: 'Delete from row',
      url: 'https://motion.test/delete-from-row',
    });
    return {
      deletableBookmarkId: deletableBookmark.id,
      localBookmarkId: localBookmark.id,
      localFolderId: localFolder.id,
      selectedTabIds: tabIds,
    };
  }, { localRootId: firstSpaceRootId, spaceId: fixture.firstSpaceId });
  const baseUrl = extensionBaseUrl(worker);
  await page.goto(`${baseUrl}/sidepanel.html`);

  const pagination = page.locator('.space-pagination');
  const addSpaceButton = page.getByRole('button', { name: 'Add space' });
  const [paginationBox, addSpaceBox] = await Promise.all([
    pagination.boundingBox(),
    addSpaceButton.boundingBox(),
  ]);
  expect(paginationBox).not.toBeNull();
  expect(addSpaceBox).not.toBeNull();
  expect(paginationBox!.x + paginationBox!.width - (
    addSpaceBox!.x + addSpaceBox!.width
  )).toBeCloseTo(5, 0);

  const deletableBookmark = page.locator(
    `[data-bookmark-node-id="${dragFixture.deletableBookmarkId}"]`,
  );
  await expect(deletableBookmark).toBeVisible();
  await expect(deletableBookmark.locator('.bookmark-close')).toHaveCount(0);

  const bookmarkRow = page.locator(
    `[data-bookmark-node-id="${fixture.bookmarkId}"]`,
  );
  const bookmark = bookmarkRow.locator('.tree-item-main');
  await expect(bookmark).toBeVisible();
  const tabRow = page.locator(tabRowSelector(dragFixture.selectedTabIds[0]!));
  const tabClose = tabRow.locator('.tab-close');
  await expect(tabClose).toHaveCSS('width', '0px');
  await expect(tabClose).toHaveCSS('margin-right', '0px');
  await tabRow.hover();
  await expect(tabClose).toHaveCSS('width', '20px');
  await expect(tabClose).toHaveCSS('height', '20px');
  await expect(tabClose).toHaveCSS('margin-right', '5px');
  const bookmarkClose = bookmarkRow.locator('.bookmark-close');
  await expect(bookmarkClose).toHaveCount(1);
  await expect(bookmarkClose).toHaveAccessibleName(/^Close tabs? for /);
  await expect(bookmarkClose).toHaveCSS('width', '0px');
  await expect(bookmarkClose).toHaveCSS('margin-right', '0px');
  await expect(bookmarkClose).toHaveCSS('color', 'rgba(0, 0, 0, 0)');
  await bookmark.hover();
  await expect(bookmarkClose).toHaveCSS('width', '20px');
  await expect(bookmarkClose).toHaveCSS('height', '20px');
  await expect(bookmarkClose).toHaveCSS('margin-right', '5px');
  await expect(bookmarkClose).not.toHaveCSS('color', 'rgba(0, 0, 0, 0)');
  const [bookmarkCloseBounds, bookmarkCloseIconBounds] = await Promise.all([
    bookmarkClose.boundingBox(),
    bookmarkClose.locator('svg').boundingBox(),
  ]);
  expect(bookmarkCloseBounds).not.toBeNull();
  expect(bookmarkCloseIconBounds).not.toBeNull();
  expect(bookmarkCloseIconBounds!.width).toBeCloseTo(14, 0);
  expect(bookmarkCloseIconBounds!.height).toBeCloseTo(14, 0);
  expect(bookmarkCloseIconBounds!.x - bookmarkCloseBounds!.x).toBeCloseTo(3, 0);
  expect(bookmarkCloseIconBounds!.y - bookmarkCloseBounds!.y).toBeCloseTo(3, 0);
  expect(
    bookmarkCloseBounds!.x + bookmarkCloseBounds!.width -
    bookmarkCloseIconBounds!.x - bookmarkCloseIconBounds!.width,
  ).toBeCloseTo(3, 0);
  expect(
    bookmarkCloseBounds!.y + bookmarkCloseBounds!.height -
    bookmarkCloseIconBounds!.y - bookmarkCloseIconBounds!.height,
  ).toBeCloseTo(3, 0);

  await beginPointerDrag(page, bookmark);
  const trashTarget = page.locator('.space-pagination-trash-target');
  const trashVisual = trashTarget.locator('.space-pagination-trash-visual');
  const trashTargetBox = await trashTarget.boundingBox();
  if (!trashTargetBox) throw new Error('Pagination trash target was not measurable');
  expect(paginationBox!.x + paginationBox!.width - (
    trashTargetBox.x + trashTargetBox.width
  )).toBeCloseTo(5, 0);
  await page.mouse.move(
    trashTargetBox.x + trashTargetBox.width / 2,
    trashTargetBox.y + trashTargetBox.height / 2,
    { steps: 8 },
  );
  await expect(trashTarget).toHaveClass(/is-over/);
  await expect(trashTarget.locator('.space-pagination-trash-label'))
    .toHaveText('Delete Shared motion bookmark bookmark');
  await expect(page.locator('.space-pagination-items')).toHaveClass(/is-trash-over/);
  await expect(trashTarget.locator('.space-pagination-trash-label'))
    .toHaveCSS('opacity', '1');
  await expect.poll(async () => {
    const bounds = await trashVisual.boundingBox();
    return bounds && {
      leftInset: bounds.x - paginationBox!.x,
      rightInset: paginationBox!.x + paginationBox!.width - bounds.x - bounds.width,
    };
  }).toEqual({ leftInset: 5, rightInset: 5 });
  await page.keyboard.press('Escape');
  await page.mouse.up();

  const firstSpaceTarget = spaceDotById(page, fixture.firstSpaceId);
  const secondSpaceTarget = spaceDotById(page, fixture.secondSpaceId);
  const localBookmark = page.locator(
    `[data-bookmark-node-id="${dragFixture.localBookmarkId}"] .tree-item-main`,
  );
  const localFolder = page.locator(
    `[data-bookmark-node-id="${dragFixture.localFolderId}"] .tree-item-main`,
  );
  await expect(localFolder).toBeVisible();
  await expect(localBookmark).toBeVisible();
  const bookmarkSelectionSurface = page.locator('.bookmark-tree-stack');
  const activeBrowserTabId = await activeTabId(worker);
  await clickSelectionWithModifierReleased(page, bookmark);
  await expect(bookmark).toHaveAttribute('aria-selected', 'true');
  await expect(firstSpaceTarget).toHaveAttribute('aria-current', 'page');
  await expect.poll(() => activeTabId(worker)).toBe(activeBrowserTabId);
  await clickSelectionWithModifierReleased(page, bookmark);
  await expect(bookmark).toHaveAttribute('aria-selected', 'false');
  await expect.poll(() => page.locator('.space-pagination-items').evaluate(
    (pagination) => Number.parseFloat(getComputedStyle(pagination).columnGap),
  )).toBe(5);
  const bookmarkInsets = await bookmarkSelectionSurface.evaluate((surface) => {
    const row = surface.querySelector<HTMLElement>('[data-bookmark-node-id]');
    const pagination = document.querySelector<HTMLElement>('.space-pagination-items');
    const surfaceBounds = surface.getBoundingClientRect();
    const rowBounds = row?.getBoundingClientRect();
    return {
      left: rowBounds ? rowBounds.left - surfaceBounds.left : undefined,
      paginationGap: pagination
        ? Number.parseFloat(getComputedStyle(pagination).columnGap)
        : undefined,
      right: rowBounds ? surfaceBounds.right - rowBounds.right : undefined,
    };
  });
  expect(bookmarkInsets).toEqual({ left: 5, paginationGap: 5, right: 5 });
  const toggleWithMarquee = (row: Locator) => dragMarqueeSelection(
    page,
    bookmarkSelectionSurface,
    row,
    row,
    { fromRight: true, modifier: 'Meta' },
  );
  await dragMarqueeSelection(
    page,
    bookmarkSelectionSurface,
    localBookmark,
    localFolder,
  );
  await expect(localBookmark).toHaveAttribute('aria-selected', 'true');
  await expect(localFolder).toHaveAttribute('aria-selected', 'true');
  await toggleWithMarquee(bookmark);
  await expect(bookmark).toHaveAttribute('aria-selected', 'true');
  await toggleWithMarquee(localFolder);
  await expect(localFolder).toHaveAttribute('aria-selected', 'false');
  await expect(localBookmark).toHaveAttribute('aria-selected', 'true');
  await toggleWithMarquee(bookmark);
  await expect(bookmark).toHaveAttribute('aria-selected', 'false');
  await bookmarkSelectionSurface.click({ position: { x: 2, y: 2 } });
  await expect(localBookmark).toHaveAttribute('aria-selected', 'false');
  await expect(localFolder).toHaveAttribute('aria-selected', 'false');
  await beginPointerDrag(page, localBookmark);
  await expect(firstSpaceTarget).toHaveClass(/is-drop-target/);
  await expect(firstSpaceTarget).toHaveClass(/is-drop-disabled/);
  await expect(firstSpaceTarget).toBeDisabled();
  await expect(secondSpaceTarget).toHaveClass(/is-drop-target/);
  await movePointerToCenter(page, secondSpaceTarget, 'Space target was not measurable');
  await expect(secondSpaceTarget).toHaveClass(/is-over/);
  await expect(secondSpaceTarget.locator('.space-pagination-dot-visual'))
    .not.toHaveCSS('box-shadow', 'none');
  await page.mouse.up();
  await expect.poll(async () =>
    await bookmarkParentId(worker, dragFixture.localBookmarkId) === secondSpaceRootId).toBe(true);

  await beginPointerDrag(page, localFolder);
  await expect(firstSpaceTarget).toHaveClass(/is-drop-disabled/);
  await expect(firstSpaceTarget).toBeDisabled();
  await movePointerToCenter(page, secondSpaceTarget, 'Folder destination space was not measurable');
  await expect(secondSpaceTarget).toHaveClass(/is-over/);
  await page.mouse.up();
  await expect.poll(async () =>
    await bookmarkParentId(worker, dragFixture.localFolderId) === secondSpaceRootId).toBe(true);

  // dnd-kit swallows clicks for a moment after a drop ends.
  await page.waitForTimeout(100);
  await secondSpaceTarget.click();
  await expect(secondSpaceTarget).toHaveAttribute('aria-current', 'page');
  await page.reload();
  await expect(secondSpaceTarget).toHaveAttribute('aria-current', 'page');
  await expect(localBookmark).toBeVisible();
  await expect(page.getByRole('button', {
    name: 'Local drag folder',
    exact: true,
  })).toBeVisible();
  await expect(page.getByRole('button', {
    name: 'Local drag bookmark',
    exact: true,
  })).toBeVisible();

  const firstSpaceButton = spaceDotById(page, fixture.firstSpaceId);
  await firstSpaceButton.click();
  await expect(firstSpaceButton).toHaveAttribute('aria-current', 'page');

  const indicator = (kind: string) => page.locator(
    `${tabRowSelector(dragFixture.selectedTabIds[0]!)} .tab-bookmark-indicator.is-${kind}`,
  );
  const expectIndicator = async (kind: string, name: RegExp, iconState: string) => {
    const control = indicator(kind);
    await expect(control).toHaveAccessibleName(name);
    const icon = control.locator('.tab-bookmark-icon');
    await expect(icon).toHaveAttribute('data-bookmark-icon-state', iconState);
    const artwork = icon.locator('.tab-bookmark-icon-artwork');
    await expect(artwork).toHaveCount(1);
    await expect(artwork).toBeVisible();
    return control;
  };
  const createBookmark = await expectIndicator('create', /Create bookmark for /, 'add');
  await createBookmark.click();
  const spaceRootHasUrl = async (url: string) =>
    (await bookmarkChildren(worker, firstSpaceRootId)).some((node) => node.url === url);
  await expect.poll(() => spaceRootHasUrl('https://motion.test/multi-tab-one')).toBe(true);
  await expect(indicator('remove')).toBeVisible();
  const updatedUrl = 'https://motion.test/multi-tab-one?updated=1';
  await navigateTab(worker, dragFixture.selectedTabIds[0]!, updatedUrl);
  await expect.poll(() => tabUrl(worker, dragFixture.selectedTabIds[0]!)).toBe(updatedUrl);
  const updateBookmark = await expectIndicator('update', /Update bookmark to /, 'update');
  const primaryModifier = process.platform === 'darwin' ? 'Meta' : 'Control';
  await updateBookmark.hover();
  await expect(updateBookmark).toBeFocused();
  await page.keyboard.down(primaryModifier);
  const revertBookmark = await expectIndicator(
    'revert',
    /Revert .* to bookmarked page/,
    'revert',
  );
  await page.keyboard.up(primaryModifier);
  await expect(updateBookmark).toBeVisible();
  await page.keyboard.down(primaryModifier);
  await revertBookmark.click();
  await page.keyboard.up(primaryModifier);
  await expect.poll(() => tabUrl(worker, dragFixture.selectedTabIds[0]!))
    .toBe('https://motion.test/multi-tab-one');
  await navigateTab(worker, dragFixture.selectedTabIds[0]!, updatedUrl);
  await expect(updateBookmark).toBeVisible();
  await updateBookmark.click();
  await expect.poll(() => spaceRootHasUrl(updatedUrl)).toBe(true);
  const removeBookmark = page.locator(
    `[data-tab-id="${dragFixture.selectedTabIds[0]}"] .tab-bookmark-indicator.is-remove`,
  ).last();
  await expect(removeBookmark).toHaveAccessibleName(/Remove bookmark for /);
  const removeIcon = removeBookmark.locator('.tab-bookmark-icon');
  await expect(removeIcon).toHaveAttribute('data-bookmark-icon-state', 'bookmarked');
  await expect(removeIcon.locator('.tab-bookmark-icon-artwork')).toHaveCount(1);
  await expect(page.locator(
    `[data-tab-id="${dragFixture.selectedTabIds[0]}"] .favicon-top-left-overlay`,
  )).toHaveCount(0);
  await removeBookmark.click();
  await expect.poll(() => spaceRootHasUrl(updatedUrl)).toBe(false);
  await page.reload();
  await firstSpaceButton.click();
  await expect(firstSpaceButton).toHaveAttribute('aria-current', 'page');

  const selectedTabs = dragFixture.selectedTabIds.map((tabId) =>
    page.locator(`[data-tab-id="${tabId}"] .tab-main`).last());
  await expect(selectedTabs[0]!).toBeVisible();
  await expect(selectedTabs[0]!).toHaveAttribute('aria-disabled', 'false');
  await activateTab(worker, dragFixture.selectedTabIds[0]!);
  await expect(page.locator(
    `.tab-row.is-active[data-tab-id="${dragFixture.selectedTabIds[0]}"]`,
  )).toBeVisible();
  const tabsSelectionSurface = selectedTabs[0]!.locator(
    'xpath=ancestor::div[contains(@class, "tabs-tree-container")]',
  );
  const activeTabBeforeSelection = await activeTabId(worker);
  await clickSelectionWithModifierReleased(page, selectedTabs[0]!);
  await expect(selectedTabs[0]!).toHaveAttribute('aria-selected', 'true');
  await expect(firstSpaceButton).toHaveAttribute('aria-current', 'page');
  await expect.poll(() => activeTabId(worker)).toBe(activeTabBeforeSelection);
  await clickSelectionWithModifierReleased(page, selectedTabs[0]!);
  await expect(selectedTabs[0]!).toHaveAttribute('aria-selected', 'false');
  await dragMarqueeSelection(
    page,
    tabsSelectionSurface,
    selectedTabs[0]!,
    selectedTabs[1]!,
  );
  await expect(selectedTabs[0]!).toHaveAttribute('aria-selected', 'true');
  await expect(selectedTabs[1]!).toHaveAttribute('aria-selected', 'true');
  await beginPointerDrag(page, selectedTabs[0]!);
  await expect(page.locator('.drag-count-badge')).toHaveText('2');
  const tabSpaceTarget = spaceDotById(page, fixture.secondSpaceId);
  await movePointerToCenter(page, tabSpaceTarget, 'Tab destination space was not measurable');
  await page.mouse.up();
  await expect.poll(() => worker.evaluate(async ({ spaceId, tabIds }) => {
    const extension = globalThis as unknown as ExtensionGlobal;
    const tabs = await Promise.all(tabIds.map((tabId) =>
      extension.chrome.tabs.get(tabId)));
    const ownership = await extension.chrome.storage.session.get(tabs.map((tab) =>
      `spaceGroupId:${tab.windowId}:${spaceId}`));
    return tabs.every((tab) =>
      ownership[`spaceGroupId:${tab.windowId}:${spaceId}`] === tab.groupId);
  }, {
    spaceId: fixture.secondSpaceId,
    tabIds: dragFixture.selectedTabIds,
  })).toBe(true);
  await expect.poll(() => activeTabId(worker)).toBe(dragFixture.selectedTabIds[0]);
  await expect(page.locator(
    `.tab-row.is-active[data-tab-id="${dragFixture.selectedTabIds[0]}"]`,
  )).toBeVisible();
}));

test('hides other pagination targets while trashing a local folder', () => withProfile('pagination-trash', async (profile) => {
  const { context, worker } = await profile.launchExtension({ closeInitialPage: true });
  const page = await context.newPage();
  await page.setViewportSize({ width: 900, height: 900 });
  const fixture = await createMotionFixture(worker);
  const localFolderId = await worker.evaluate(async (localRootId) => {
    const extension = globalThis as unknown as ExtensionGlobal;
    return (await extension.chrome.bookmarks.create({
      parentId: localRootId,
      title: 'Trash visibility folder',
    })).id;
  }, await localBookmarksRootId(worker, fixture.firstSpaceId));
  await openSidepanel(page, worker);

  const folder = page.locator(
    `[data-bookmark-node-id="${localFolderId}"] .tree-item-main`,
  );
  await beginPointerDrag(page, folder);
  const pagination = page.locator('.space-pagination');
  const spaceTargets = page.locator([
    `.space-pagination-dot[data-space-id="${fixture.firstSpaceId}"]`,
    `.space-pagination-dot[data-space-id="${fixture.secondSpaceId}"]`,
  ].join(', '));
  const trashTarget = page.locator('.space-pagination-trash-target');
  const trashVisual = trashTarget.locator('.space-pagination-trash-visual');
  await expect(spaceTargets).toHaveCount(2);
  // With no Global target, a bookmark drag leaves the Now Playing slot collapsed.
  await expect.poll(() => pagination.evaluate((element) =>
    Number.parseFloat(getComputedStyle(element).gridTemplateColumns),
  )).toBe(0);
  const targetGeometry = () => spaceTargets.evaluateAll((targets) => targets.map((target) => {
    const bounds = target.getBoundingClientRect();
    return { x: bounds.x, width: bounds.width };
  }));
  const spaceTargetGeometry = await targetGeometry();
  const paginationBox = await pagination.boundingBox();
  if (!paginationBox) throw new Error('Pagination was not measurable');
  await movePointerToCenter(page, trashTarget, 'Folder trash target was not measurable');

  await expect(trashTarget).toHaveClass(/is-over/);
  await expect(pagination).toHaveClass(/is-trash-over/);
  await expect(page.locator('.space-pagination-rail-start')).toHaveCSS('opacity', '0');
  await expect(page.locator('.space-pagination-dots')).toHaveCSS('opacity', '0');
  await expect.poll(targetGeometry).toEqual(spaceTargetGeometry);
  await expect(trashTarget).toBeVisible();
  await expect.poll(async () => {
    const bounds = await trashVisual.boundingBox();
    return bounds && {
      leftInset: bounds.x - paginationBox.x,
      rightInset: paginationBox.x + paginationBox.width - bounds.x - bounds.width,
    };
  }).toEqual({ leftInset: 5, rightInset: 5 });

  await page.mouse.move(
    paginationBox.x + 28,
    paginationBox.y + paginationBox.height / 2,
    { steps: 8 },
  );
  await expect(pagination).not.toHaveClass(/is-trash-over/);
  await expect(page.locator('.space-pagination-rail-start')).toHaveCSS('opacity', '1');
  await expect(page.locator('.space-pagination-dots')).toHaveCSS('opacity', '1');
  await expect.poll(targetGeometry).toEqual(spaceTargetGeometry);
  await expect.poll(async () => {
    const bounds = await trashVisual.boundingBox();
    return bounds && {
      width: bounds.width,
      rightInset: paginationBox.x + paginationBox.width - bounds.x - bounds.width,
    };
  }).toEqual({ width: 24, rightInset: 5 });
  await page.keyboard.press('Escape');
}));

test('grows and shrinks pagination hover colour with pointer direction', () => withProfile('pagination-state', async (profile) => {
  const { context, worker } = await profile.launchExtension({ closeInitialPage: true, reducedMotion: 'no-preference' });
  const page = await context.newPage();
  await page.setViewportSize({ width: 900, height: 900 });
  const fixture = await createMotionFixture(worker);
  // The pagination dot's active state is uniquely sensitive to the launch race
  // between this fixture and the background's structure repair. Prune any stray
  // space the repair created and let the model settle on the seeded First space
  // before the sidebar connects, so the first projection marks First current.
  await settleMotionFixture(worker, fixture);
  await waitForActivationQuiescence(worker);
  await openSidepanel(page, worker);

  const pagination = page.locator('.space-pagination');
  const firstSpace = spaceDotById(pagination, fixture.firstSpaceId);
  const secondSpace = spaceDotById(pagination, fixture.secondSpaceId);
  await expect(firstSpace).toBeVisible();
  await expect(secondSpace).toBeVisible();
  await expect(firstSpace).toHaveAttribute('aria-current', 'page');

  const stateRules = await page.evaluate(() => {
    const selectors = new Set([
      '.tab-row:hover .tab-content',
      '.tab-row.is-active .tab-content',
      '.tab-row.is-active.is-drag-selected:not(.is-dragging) .tab-content',
      '.space-pagination-hover-highlight',
      '.space-pagination-dot.is-active .space-pagination-dot-visual',
    ]);
    const declarations = new Map<string, string>();
    for (const sheet of Array.from(document.styleSheets)) {
      for (const rule of Array.from(sheet.cssRules)) {
        if (!(rule instanceof CSSStyleRule)) continue;
        for (const selector of rule.selectorText.split(',').map((value) => value.trim())) {
          if (selectors.has(selector)) {
            declarations.set(selector, rule.style.background);
          }
        }
      }
    }
    return Object.fromEntries(declarations);
  });
  expect(stateRules).toEqual({
    '.space-pagination-dot.is-active .space-pagination-dot-visual':
      'var(--list-selected-background)',
    '.space-pagination-hover-highlight': 'var(--list-hover-background)',
    '.tab-row.is-active .tab-content': 'var(--row-active-background)',
    '.tab-row.is-active.is-drag-selected:not(.is-dragging) .tab-content':
      'var(--row-active-background)',
    '.tab-row:hover .tab-content': 'var(--row-hover-background)',
  });

  const centerOffsets = await pagination.locator('.space-pagination-dot')
    .evaluateAll((items) => items.map((item) => {
      const visual = item.querySelector<HTMLElement>('.space-pagination-dot-visual');
      if (!visual) return Number.POSITIVE_INFINITY;
      const itemBounds = item.getBoundingClientRect();
      const visualBounds = visual.getBoundingClientRect();
      return visualBounds.top + visualBounds.height / 2 -
        (itemBounds.top + itemBounds.height / 2);
    }));
  expect(centerOffsets.every((offset) => Math.abs(offset) < 0.6)).toBe(true);

  const firstVisualBounds = await firstSpace.locator(
    '.space-pagination-dot-visual',
  ).boundingBox();
  const secondVisualBounds = await secondSpace.locator(
    '.space-pagination-dot-visual',
  ).boundingBox();
  expect(firstVisualBounds).not.toBeNull();
  expect(secondVisualBounds).not.toBeNull();
  expect(secondVisualBounds!.x).toBeGreaterThan(firstVisualBounds!.x);

  const isMidScale = (scale: number) => scale > 0.05 && scale < 0.95;
  await page.mouse.move(
    firstVisualBounds!.x - 2,
    firstVisualBounds!.y + firstVisualBounds!.height / 2,
  );
  await page.mouse.move(
    firstVisualBounds!.x + 1,
    firstVisualBounds!.y + firstVisualBounds!.height / 2,
  );
  const firstHighlight = firstSpace.locator(
    '.space-pagination-hover-highlight',
  );
  const leftEntry = await sampleHighlightEntry(firstHighlight);
  expect(leftEntry.originX).toBeLessThan(1);
  expect(leftEntry.scales.some(isMidScale)).toBe(true);

  await startHighlightExitSampling(firstHighlight);
  await page.mouse.move(
    secondVisualBounds!.x + 1,
    secondVisualBounds!.y + secondVisualBounds!.height / 2,
  );
  const secondHighlight = secondSpace.locator(
    '.space-pagination-hover-highlight',
  );
  const secondLeftEntry = await sampleHighlightEntry(secondHighlight);
  const rightExit = await highlightExitSamples(page);
  expect(secondLeftEntry.originX).toBeLessThan(1);
  expect(secondLeftEntry.scales.some(isMidScale))
    .toBe(true);
  expect(rightExit.some(({ originX, scaleX, width }) =>
    originX > width - 1 && isMidScale(scaleX))).toBe(true);

  await startHighlightExitSampling(secondHighlight);
  await page.mouse.move(
    firstVisualBounds!.x + firstVisualBounds!.width - 1,
    firstVisualBounds!.y + firstVisualBounds!.height / 2,
  );
  const rightEntry = await sampleHighlightEntry(firstHighlight);
  const leftExit = await highlightExitSamples(page);
  expect(rightEntry.originX).toBeGreaterThan(rightEntry.width - 1);
  expect(rightEntry.scales.some(isMidScale)).toBe(true);
  expect(leftExit.some(({ originX, scaleX }) =>
    originX < 1 && isMidScale(scaleX))).toBe(true);

  await expect(firstHighlight).toHaveCSS(
    'background-color',
    'rgba(255, 255, 255, 0.38)',
  );
  await expect(pagination.locator('.space-pagination-hover-highlight')).toHaveCount(1);
  await page.mouse.move(0, 0);
  await expect(pagination.locator('.space-pagination-hover-highlight')).toHaveCount(0);
  await expect(firstSpace.locator('.space-pagination-dot-visual')).toHaveCSS(
    'background-color',
    await paintedCustomProperty(
      firstSpace.locator('.space-pagination-dot-visual'),
      '--list-selected-background',
    ),
  );
}));
