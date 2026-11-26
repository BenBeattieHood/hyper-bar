import {
  expect,
  test,
} from '@playwright/test';
import { waitForActivationQuiescence } from './fixtures/activation';
import { localBookmarksRootId } from './fixtures/localBookmarks';
import { readHyperPreferences } from './fixtures/preferences';
import { exposeMotionTabsAsAudible } from './helpers/media';
import {
  createMotionFixture,
  isMonotonic,
  sampleCompactViewSwitch,
  sampleSearchMorph,
  sampleSettingsTransition,
  sampleSpaceSwitch,
  settleMotionFixture,
} from './helpers/motion';
import { beginPointerDrag, spaceDot, spaceDotById } from './helpers/sidebar';
import { movePointerToCenter } from './helpers/pointer';
import type { ExtensionGlobal } from './helpers/extensionGlobal';
import { openSidepanel, routeHtml, titledPage, withProfile } from './helpers/extension';

test('slides settings in from and out to the right', () => withProfile('settings-motion', async (profile) => {
  const { context, worker } = await profile.launchExtension({ closeInitialPage: true, reducedMotion: 'no-preference' });
  const page = await context.newPage();
  await page.setViewportSize({ width: 600, height: 900 });
  await openSidepanel(page, worker);
  await expect(page.getByRole('button', { name: 'Open settings' })).toBeVisible();
  await expect(page.locator('.space-pagination-rail-start > .now-playing-slot'))
    .toHaveCSS('width', '56px');
  await expect(page.getByRole('region', { name: 'Now playing' })).toHaveCount(0);

  const settingsIn = await sampleSettingsTransition(page, 'open');
  expect(settingsIn.some(({ layerLeft }) => layerLeft > 20)).toBe(true);
  expect(settingsIn.some(({ backdropOpacity }) => (backdropOpacity ?? 0) > 0.5)).toBe(true);
  await expect(page.locator('.settings-layer')).toHaveCSS('transform', 'none');
  await expect(page.locator('.settings-backdrop')).toHaveCSS('opacity', '0.78');
  await expect(page.locator('.settings-backdrop')).toHaveCSS('z-index', '9');
  await expect(page.locator('.settings-layer')).toHaveCSS('z-index', '10');
  await expect(page.getByRole('slider', { name: 'Message timing' })).toBeVisible();

  const settingsOut = await sampleSettingsTransition(page, 'close');
  expect(settingsOut.some(({ layerLeft }) => layerLeft > 20)).toBe(true);
  expect(settingsOut.some(({ backdropOpacity }) =>
    backdropOpacity !== undefined && backdropOpacity < 0.5)).toBe(true);
  await expect(page.locator('.settings-layer')).toHaveCount(0);
  await expect(page.locator('.settings-backdrop')).toHaveCount(0);

  const settingsButton = page.getByRole('button', { name: 'Open settings' });
  await expect(settingsButton).toHaveCSS('border-width', '0px');
  const settingsAction = await settingsButton.boundingBox();
  const closedAction = await page.locator('.search-command-action').boundingBox();
  expect(settingsAction).not.toBeNull();
  expect(closedAction).not.toBeNull();
  expect(closedAction!.width).toBe(settingsAction!.width);
  expect(closedAction!.height).toBe(settingsAction!.height);
  await settingsButton.focus();
  await expect(settingsButton).toHaveCSS('outline-style', 'solid');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Search tabs and history' }))
    .toBeFocused();
  await expect(page.locator('.search-command-action')).toHaveCSS('outline-style', 'solid');
  // Search morphs through mid widths in one direction with its action held in place.
  const expectSearchMorph = (
    samples: Awaited<ReturnType<typeof sampleSearchMorph>>,
    direction: 'increasing' | 'decreasing',
  ) => {
    expect(samples.some(({ visibleWidth }) =>
      visibleWidth > 45 && visibleWidth < openBounds!.visibleWidth - 45))
      .toBe(true);
    expect(isMonotonic(samples.map(({ visibleWidth }) => visibleWidth), direction))
      .toBe(true);
    expect(Math.max(...samples.map(({ actionRight }) =>
      Math.abs(actionRight - closedAction!.x - closedAction!.width)))).toBeLessThan(1);
  };
  const searchIn = await sampleSearchMorph(page, 'open');
  const openBounds = searchIn.at(-1);
  expect(openBounds).toBeDefined();
  expect(openBounds!.visibleWidth).toBeGreaterThan(400);
  expectSearchMorph(searchIn, 'increasing');
  const closeAction = page.getByRole('button', { name: 'Close command bar' });
  await expect(closeAction).toBeVisible();
  await expect(page.getByRole('combobox', {
    name: 'Search tabs, bookmarks, history, or commands',
  })).toBeFocused();
  const openAction = await closeAction.boundingBox();
  expect(openAction?.width).toBe(26);
  expect(openAction?.height).toBe(26);
  await closeAction.hover();
  await expect(closeAction).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await closeAction.focus();
  await expect(closeAction).toHaveCSS('outline-style', 'solid');
  const results = page.getByRole('listbox', { name: 'Command bar results' });
  await expect(results).toBeVisible();
  await expect(results).toHaveCSS('animation-name', 'command-results-fade-in');
  await expect(results).toHaveCSS('transform', 'none');
  const resultsLeftSamples = searchIn.flatMap(({ resultsLeft }) =>
    resultsLeft === undefined ? [] : [resultsLeft]);
  expect(resultsLeftSamples.length).toBeGreaterThan(2);
  expect(Math.max(...resultsLeftSamples) - Math.min(...resultsLeftSamples)).toBeLessThan(1);

  const searchOut = await sampleSearchMorph(page, 'close');
  const closedBounds = searchOut.at(-1);
  expect(closedBounds).toBeDefined();
  expect(closedBounds!.visibleWidth).toBeLessThan(40);
  expectSearchMorph(searchOut, 'decreasing');
  await expect(page.getByRole('button', { name: 'Search tabs and history' }))
    .toBeFocused();
}));

test('animates spaces and compact workspace views directionally', () => withProfile('workspace-motion', async (profile) => {
  const { context, worker } = await profile.launchExtension({ closeInitialPage: true, reducedMotion: 'no-preference' });
  const sidepanelPage = await context.newPage();
  await sidepanelPage.setViewportSize({ width: 900, height: 900 });
  await exposeMotionTabsAsAudible(sidepanelPage, worker);
  await routeHtml(context, 'https://motion.test/**', titledPage('Shared motion page'));
  const fixture = await createMotionFixture(worker);
  // See the pagination hover test: settle the launch race so the seeded First
  // space is current before the sidebar renders its directional animation.
  await settleMotionFixture(worker, fixture);
  await waitForActivationQuiescence(worker);
  // Bookmarks belong to spaces, so the second space holds its own copy of the tree.
  const copies = await worker.evaluate(async (parentId) => {
    const extension = globalThis as unknown as ExtensionGlobal;
    const create = extension.chrome.bookmarks.create;
    const bookmark = await create({
      parentId,
      title: 'Shared motion bookmark',
      url: 'https://motion.test/shared',
    });
    const outer = await create({ parentId, title: 'Open bookmark outer folder' });
    const inner = await create({ parentId: outer.id, title: 'Open bookmark inner folder' });
    const nested = await create({
      parentId: inner.id,
      title: 'Nested open bookmark',
      url: 'https://motion.test/nested',
    });
    return { bookmark: bookmark.id, inner: inner.id, nested: nested.id, outer: outer.id };
  }, await localBookmarksRootId(worker, fixture.secondSpaceId));
  const eitherNode = (firstId: string, copyId: string, suffix = '') =>
    `[data-bookmark-node-id="${firstId}"]${suffix}, [data-bookmark-node-id="${copyId}"]${suffix}`;
  await openSidepanel(sidepanelPage, worker);

  await expect(spaceDot(sidepanelPage, 'First space')).toBeVisible();
  await expect(spaceDot(sidepanelPage, 'Second space')).toBeVisible();
  const pagination = sidepanelPage.locator('.space-pagination');
  const firstSpaceDot = spaceDotById(pagination, fixture.firstSpaceId);
  const secondSpaceDot = spaceDotById(pagination, fixture.secondSpaceId);
  const firstSpaceLabel = firstSpaceDot.locator('.space-pagination-label');
  const secondSpaceLabel = secondSpaceDot.locator('.space-pagination-label');
  await expect(pagination.locator('.space-pagination-name-shelf')).toHaveCount(0);
  await expect(pagination.locator('.space-pagination-marker')).toHaveCount(0);
  const paginationRule = (locator: typeof firstSpaceDot) => locator
    .locator('.space-pagination-dot-visual').evaluate((element) => {
      const style = getComputedStyle(element, '::after');
      return {
        borderRadius: style.borderRadius,
        height: style.height,
      };
    });
  expect(await paginationRule(firstSpaceDot)).toEqual({
    borderRadius: '3px',
    height: '3px',
  });
  expect(await paginationRule(secondSpaceDot)).toEqual({
    borderRadius: '3px',
    height: '2px',
  });
  expect(await firstSpaceDot.locator('.space-pagination-dot-visual').evaluate((element) => ({
    bar: getComputedStyle(element, '::after').borderRadius,
    item: getComputedStyle(element).borderRadius,
  }))).toEqual({ bar: '3px', item: '3px' });
  await expect.poll(() => firstSpaceLabel.evaluate((element) =>
    Number.parseFloat(getComputedStyle(element).opacity))).toBeGreaterThan(0);
  expect(await firstSpaceDot.evaluate((element) => {
    const label = element.querySelector('.space-pagination-label');
    return label && getComputedStyle(label).color === getComputedStyle(element).color;
  })).toBe(true);
  await expect(firstSpaceLabel).toHaveCSS('text-overflow', 'clip');
  for (const label of [firstSpaceLabel, secondSpaceLabel]) {
    await expect(label).toHaveCSS('font-size', '11px');
    await expect(label).toHaveCSS('opacity', '1');
    await expect(label).toHaveCSS('mask-image', 'none');
  }
  const paginationBounds = await pagination.boundingBox();
  expect(paginationBounds).not.toBeNull();
  for (const dot of [firstSpaceDot, secondSpaceDot]) {
    const metrics = await dot.evaluate((element) => {
      const label = element.querySelector<HTMLElement>('.space-pagination-label');
      const visual = element.querySelector<HTMLElement>('.space-pagination-dot-visual');
      const style = visual ? getComputedStyle(visual) : undefined;
      return {
        labelWidth: label?.getBoundingClientRect().width ?? 0,
        minWidth: getComputedStyle(element).minWidth,
        paddingLeft: style?.paddingLeft,
        paddingRight: style?.paddingRight,
        width: visual?.getBoundingClientRect().width ?? 0,
      };
    });
    expect(metrics.minWidth).toBe('28px');
    expect(metrics.paddingLeft).toBe('4px');
    expect(metrics.paddingRight).toBe('4px');
    expect(metrics.width - metrics.labelWidth).toBeCloseTo(8, 1);
  }

  const paginationItems = pagination.locator('.space-pagination-items');
  const addSpaceButton = pagination.locator('.add-space-button');
  await expect(paginationItems).not.toHaveClass(/is-dot-mode/);
  const paginationHeight = paginationBounds!.height;
  const labelFontSize = await firstSpaceLabel.evaluate((element) =>
    getComputedStyle(element).fontSize);
  await firstSpaceLabel.evaluate((element) => {
    element.textContent = 'Address Book Handover';
  });
  await secondSpaceLabel.evaluate((element) => {
    element.textContent = 'Other';
  });
  await paginationItems.evaluate((element) => {
    element.style.width = '170px';
    element.style.justifySelf = 'center';
  });
  await expect(paginationItems).not.toHaveClass(/is-dot-mode/);
  await expect.poll(async () => {
    const [longLabel, shortLabel] = await Promise.all(
      [firstSpaceLabel, secondSpaceLabel].map((label) => label.evaluate((element) => ({
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
      }))),
    );
    return {
      longLabelTruncated: longLabel!.scrollWidth > longLabel!.clientWidth,
      shortLabelWhole: shortLabel!.scrollWidth - shortLabel!.clientWidth <= 1,
    };
  }).toEqual({ longLabelTruncated: true, shortLabelWhole: true });
  const constrainedLabels = await Promise.all(
    [firstSpaceLabel, secondSpaceLabel].map((label) => label.evaluate((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
    }))),
  );
  expect(constrainedLabels[0]!.scrollWidth).toBeGreaterThan(
    constrainedLabels[0]!.clientWidth,
  );
  expect(
    constrainedLabels[1]!.scrollWidth - constrainedLabels[1]!.clientWidth,
  ).toBeLessThanOrEqual(1);
  await expect(firstSpaceDot).toHaveClass(/is-truncated/);
  await expect(secondSpaceDot).not.toHaveClass(/is-truncated/);
  expect(await firstSpaceLabel.evaluate((element) =>
    getComputedStyle(element).maskImage)).toContain('linear-gradient');
  await expect(secondSpaceLabel).toHaveCSS('mask-image', 'none');
  expect(await firstSpaceDot.evaluate((element) =>
    element.getBoundingClientRect().width)).toBeGreaterThanOrEqual(28);
  expect(await secondSpaceDot.evaluate((element) =>
    element.getBoundingClientRect().width)).toBeGreaterThanOrEqual(28);

  const constrainedWidths = await paginationItems.evaluate((element) => {
    const dots = element.querySelectorAll<HTMLElement>('.space-pagination-dot');
    const action = element.querySelector<HTMLElement>('.space-pagination-tail-action');
    if (!action) throw new Error('Pagination action is missing');
    const itemsStyle = getComputedStyle(element);
    const actionStyle = getComputedStyle(action);
    const gap = Number.parseFloat(itemsStyle.columnGap) || 0;
    const actionWidth = action.getBoundingClientRect().width +
      (Number.parseFloat(actionStyle.marginLeft) || 0) +
      (Number.parseFloat(actionStyle.marginRight) || 0);
    return {
      dotMode: dots.length * 28 + actionWidth + gap * dots.length - 1,
      hideAdd: dots.length * 18 + actionWidth + gap * dots.length - 1,
    };
  });
  await paginationItems.evaluate((element, width) => {
    element.style.width = `${width}px`;
  }, constrainedWidths.dotMode);
  await expect(paginationItems).toHaveClass(/is-dot-mode/);
  await expect(addSpaceButton).toBeVisible();
  for (const dot of [firstSpaceDot, secondSpaceDot]) {
    await expect(dot).toHaveCSS('width', '18px');
    await expect(dot).toHaveCSS('padding-left', '0px');
    await expect(dot.locator('.space-pagination-label')).toBeHidden();
  }
  const dotRuleWidth = (locator: typeof firstSpaceDot) => locator
    .locator('.space-pagination-dot-visual').evaluate(
      (element) => getComputedStyle(element, '::after').width,
    );
  expect(await dotRuleWidth(firstSpaceDot)).toBe('15px');
  expect(await dotRuleWidth(secondSpaceDot)).toBe('5px');

  await paginationItems.evaluate((element, width) => {
    element.style.width = `${width}px`;
  }, constrainedWidths.hideAdd);
  await expect(paginationItems).toHaveClass(/hide-add-space/);
  await expect(addSpaceButton).toBeHidden();

  await paginationItems.evaluate((element) => {
    element.style.removeProperty('width');
    element.style.removeProperty('justify-self');
  });
  await expect(paginationItems).not.toHaveClass(/is-dot-mode/);
  await expect(paginationItems).not.toHaveClass(/hide-add-space/);
  await expect(addSpaceButton).toBeVisible();
  const activeMetrics = await firstSpaceDot.evaluate((element) => {
    const visual = element.querySelector<HTMLElement>('.space-pagination-dot-visual');
    const style = visual ? getComputedStyle(visual) : undefined;
    return {
      paddingLeft: style?.paddingLeft,
      paddingRight: style?.paddingRight,
      transitionProperty: style?.transitionProperty ?? '',
    };
  });
  expect(activeMetrics.paddingLeft).toBe('4px');
  expect(activeMetrics.paddingRight).toBe('4px');
  expect(activeMetrics.transitionProperty).not.toContain('max-width');

  await expect.poll(() => pagination.evaluate((element) =>
    element.getBoundingClientRect().height)).toBe(paginationHeight);
  await expect(firstSpaceLabel).toHaveCSS('font-size', labelFontSize);
  await expect(secondSpaceLabel).toHaveCSS('font-size', labelFontSize);

  await expect.poll(() => pagination.evaluate((element) =>
    element.getBoundingClientRect().height)).toBe(paginationBounds!.height);
  await spaceDot(sidepanelPage, 'First space').click();
  await expect(sidepanelPage.locator(
    `.tabs-space-layer[data-space-id="${fixture.firstSpaceId}"]`,
  )).toBeVisible();
  const bookmarkRow = sidepanelPage.locator(
    eitherNode(fixture.bookmarkId, copies.bookmark),
  );
  const outerBookmarkFolder = sidepanelPage.locator(
    eitherNode(fixture.outerBookmarkFolderId, copies.outer, ' .folder-item'),
  );
  const innerBookmarkFolder = sidepanelPage.locator(
    eitherNode(fixture.innerBookmarkFolderId, copies.inner, ' .folder-item'),
  );
  await expect(outerBookmarkFolder).toHaveAttribute('aria-expanded', 'true');
  await expect(innerBookmarkFolder).toHaveAttribute('aria-expanded', 'true');
  await expect(sidepanelPage.locator(
    `[data-bookmark-node-id="${fixture.nestedBookmarkId}"]`,
  )).toBeVisible();
  await expect(bookmarkRow.locator('.bookmark-current-space-indicator'))
    .toHaveCount(0);
  await expect(bookmarkRow.locator(
    ':scope > .tab-bookmark-indicator.is-open .tab-bookmark-open-dot',
  )).toBeVisible();
  await expect(bookmarkRow.locator('.bookmark-space-link')).toHaveCount(1);
  await expect(bookmarkRow.locator('.bookmark-space-summary')).toHaveCount(0);
  await expect(bookmarkRow.locator('.bookmark-space-indicator')).toHaveCount(1);
  await expect(bookmarkRow.locator('.bookmark-space-links')).toHaveClass(/is-single/);
  await expect(bookmarkRow.locator('.bookmark-space-link')).toHaveCSS(
    'background-color',
    'rgba(0, 0, 0, 0)',
  );
  await expect.poll(() => bookmarkRow.locator('.bookmark-space-links').evaluate(
    (group) => group.getBoundingClientRect().width,
  )).toBe(30);

  const spaceSamples = await sampleSpaceSwitch(
    sidepanelPage,
    fixture.bookmarkId,
  );
  // The bookmarks pane stays put; its space's rows slide with the space.
  expect(spaceSamples.every((sample) => sample.bookmarkSame)).toBe(true);
  const bookmarkLefts = spaceSamples.map((sample) => sample.bookmarkLeft);
  expect(Math.max(...bookmarkLefts) - Math.min(...bookmarkLefts)).toBeLessThan(1);
  expect(spaceSamples.some((sample) =>
    sample.tabXs[fixture.firstSpaceId]! < -2 &&
    sample.tabXs[fixture.secondSpaceId]! > 2)).toBe(true);
  expect(spaceSamples.some((sample) =>
    sample.stripXs[fixture.firstSpaceId]! < -2 &&
    sample.stripXs[fixture.secondSpaceId]! > 2)).toBe(true);
  await expect(outerBookmarkFolder).toHaveAttribute('aria-expanded', 'true');
  await expect(innerBookmarkFolder).toHaveAttribute('aria-expanded', 'true');
  await expect(sidepanelPage.locator(
    eitherNode(fixture.nestedBookmarkId, copies.nested),
  )).toBeVisible();

  await expect(sidepanelPage.locator(
    `.tabs-space-layer[data-space-id="${fixture.secondSpaceId}"]`,
  )).toHaveCount(1);
  await expect(sidepanelPage.locator(
    `.space-colour-strip[data-space-id="${fixture.secondSpaceId}"]`,
  )).toHaveCount(1);
  await expect.poll(() => sidepanelPage.evaluate(() => {
    const activeSpace = document.querySelector<HTMLElement>(
      '.space-pagination-dot[aria-current="page"]',
    );
    const strip = document.querySelector<HTMLElement>('.space-colour-strip');
    const colour = activeSpace?.dataset.groupColour;
    if (!strip || !colour) return false;
    const probe = document.createElement('span');
    probe.style.color = `var(--tab-group-${colour})`;
    document.body.append(probe);
    const expected = getComputedStyle(probe).color;
    probe.remove();
    return getComputedStyle(strip).backgroundColor === expected;
  })).toBe(true);

  await sidepanelPage.setViewportSize({ width: 600, height: 900 });
  await expect(sidepanelPage.locator(
    '.workspace-view-toolbar:not(.is-combined)',
  )).toHaveCount(0);
  await expect(sidepanelPage.locator(
    '.workspace-view-toolbar.is-combined',
  )).toHaveCount(1);
  await expect(sidepanelPage.locator('#workspace-panel-bookmarks')).toHaveCount(1);
  await expect(sidepanelPage.locator('.tabs-space-layer')).toHaveCount(1);
  await expect(sidepanelPage.locator(
    eitherNode(fixture.outerBookmarkFolderId, copies.outer, ' .folder-item'),
  )).toHaveAttribute('aria-expanded', 'true');
  await expect(sidepanelPage.locator(
    eitherNode(fixture.innerBookmarkFolderId, copies.inner, ' .folder-item'),
  )).toHaveAttribute('aria-expanded', 'true');
  await expect(sidepanelPage.locator(
    eitherNode(fixture.nestedBookmarkId, copies.nested),
  )).toBeVisible();
  const sharedTabRows = sidepanelPage.locator(
    '.tab-row:has(.tab-main[data-url^="https://motion.test/shared"])',
  );
  const nestedTabRows = sidepanelPage.locator(
    '.tab-row:has(.tab-main[data-url^="https://motion.test/nested"])',
  );
  await expect(sharedTabRows).toHaveCount(0);
  await expect(nestedTabRows).toHaveCount(0);
  const tabsBeforeCompactDrop = await worker.evaluate(async () => {
    const extension = globalThis as unknown as ExtensionGlobal;
    return (await extension.chrome.tabs.query({})).flatMap((tab) =>
      tab.id === undefined ? [] : [tab.id]);
  });
  const splitter = sidepanelPage.getByRole('separator', {
    name: 'Resize bookmarks and tabs panels',
  });
  await expect(splitter).toBeVisible();
  const bookmarkPanel = sidepanelPage.locator('#workspace-panel-bookmarks');
  const tabsPanel = sidepanelPage.locator(
    '.tabs-space-layer:not([data-motion-pop-id])',
  );
  const bookmarkHandle = bookmarkRow.locator('.tree-item-main');
  await bookmarkHandle.click({ modifiers: ['Meta'] });
  await outerBookmarkFolder.click({ modifiers: ['Meta'] });
  await beginPointerDrag(sidepanelPage, bookmarkHandle);
  await expect(sidepanelPage.locator('.drag-count-badge')).toHaveText('4');
  await movePointerToCenter(sidepanelPage, sidepanelPage.locator(
    '.tabs-drop-zone:visible > .tree-root-drop-target',
  ).last(), 'Lower tabs drop zone was not measurable');
  await expect(sidepanelPage.getByLabel('Cannot drop here')).toHaveCount(0);
  await sidepanelPage.mouse.up();
  await expect.poll(() => worker.evaluate(async ({ beforeIds, spaceId }) => {
    const extension = globalThis as unknown as ExtensionGlobal;
    const before = new Set(beforeIds);
    const openedTabs = (await extension.chrome.tabs.query({})).filter((tab) => {
      const url = tab.pendingUrl ?? tab.url;
      return tab.id !== undefined && !before.has(tab.id) &&
        (url === 'https://motion.test/shared' ||
          url === 'https://motion.test/nested');
    });
    const assignments = await extension.chrome.storage.session.get(openedTabs.flatMap(
      (tab) => [`spaceGroupId:${tab.windowId}:${spaceId}`],
    ));
    return {
      count: openedTabs.length,
      ownedByDestination: openedTabs.length === 2 && openedTabs.every((tab) =>
        assignments[`spaceGroupId:${tab.windowId}:${spaceId}`] === tab.groupId),
    };
  }, {
    beforeIds: tabsBeforeCompactDrop,
    spaceId: fixture.secondSpaceId,
  })).toEqual({ count: 2, ownedByDestination: true });
  await worker.evaluate(async (beforeIds) => {
    const extension = globalThis as unknown as ExtensionGlobal;
    const before = new Set(beforeIds);
    const openedTabIds = (await extension.chrome.tabs.query({})).flatMap((tab) => {
      const url = tab.pendingUrl ?? tab.url;
      return tab.id !== undefined && !before.has(tab.id) &&
        (url === 'https://motion.test/shared' ||
          url === 'https://motion.test/nested')
        ? [tab.id]
        : [];
    });
    if (openedTabIds.length > 0) await extension.chrome.tabs.remove(openedTabIds);
  }, tabsBeforeCompactDrop);
  const bookmarkHeightBefore = await bookmarkPanel.evaluate(
    (panel) => panel.getBoundingClientRect().height,
  );
  const tabsHeightBefore = await tabsPanel.evaluate(
    (panel) => panel.getBoundingClientRect().height,
  );
  const splitterBox = await splitter.boundingBox();
  if (!splitterBox) throw new Error('Compact panel splitter was not measurable');
  await sidepanelPage.mouse.move(
    splitterBox.x + splitterBox.width / 2,
    splitterBox.y + splitterBox.height / 2,
  );
  await sidepanelPage.mouse.down();
  await sidepanelPage.mouse.move(
    splitterBox.x + splitterBox.width / 2,
    splitterBox.y + splitterBox.height / 2 + 90,
    { steps: 4 },
  );
  await sidepanelPage.mouse.up();
  const bookmarkHeightAfter = await bookmarkPanel.evaluate(
    (panel) => panel.getBoundingClientRect().height,
  );
  const tabsHeightAfter = await tabsPanel.evaluate(
    (panel) => panel.getBoundingClientRect().height,
  );
  expect(bookmarkHeightAfter).toBeGreaterThan(bookmarkHeightBefore + 60);
  expect(tabsHeightAfter).toBeLessThan(tabsHeightBefore - 60);
  await expect.poll(async () => (await readHyperPreferences(worker)).bookmarkPanelPercent)
    .toBeGreaterThan(50);

  await sidepanelPage.getByRole('button', { name: 'Open settings' }).click();
  const combineSetting = sidepanelPage.getByRole('switch', {
    name: /Combine tabs and bookmarks/,
  });
  await expect(combineSetting).toHaveAttribute('aria-checked', 'true');
  await combineSetting.click();
  await expect(combineSetting).toHaveAttribute('aria-checked', 'false');
  await sidepanelPage.getByRole('button', { name: 'Back' }).click();
  await expect(sidepanelPage.getByRole('tab', { name: 'Bookmarks' })).toBeVisible();
  await expect(sidepanelPage.locator('#workspace-panel-bookmarks')).toHaveCount(0);
  await expect(sidepanelPage.locator('.tabs-space-layer')).toHaveCount(1);
  await expect(splitter).toHaveCount(0);
  await expect(sharedTabRows).toHaveCount(1);
  await expect(nestedTabRows).toHaveCount(1);
  await expect(sharedTabRows.locator('.bookmark-space-summary')).toHaveCount(0);
  await expect(sharedTabRows.locator('.bookmark-space-links')).toHaveClass(/is-single/);
  const tabSpaceIndicator = sharedTabRows.locator(
    '.bookmark-space-link .bookmark-space-indicator',
  );
  await expect(tabSpaceIndicator).toBeVisible();
  await expect(tabSpaceIndicator).toHaveCSS('width', '9px');
  await expect(tabSpaceIndicator).toHaveCSS('height', '9px');
  expect(await tabSpaceIndicator.evaluate((indicator) =>
    getComputedStyle(indicator).backgroundColor,
  )).not.toBe('rgba(0, 0, 0, 0)');
  await sidepanelPage.getByRole('button', { name: 'Search tabs and history' }).click();
  const commandInput = sidepanelPage.getByRole('combobox', {
    name: 'Search tabs, bookmarks, history, or commands',
  });
  await commandInput.fill('music');
  // The audible tab sits behind the space switch, and Hyper cannot reach a player
  // in its page, so Search offers what Now Playing does: muting it and going to it.
  await expect(sidepanelPage.getByRole('option', { name: /^Mute music/ })).toBeVisible();
  await expect(sidepanelPage.getByRole('option', { name: /^Switch to music/ })).toBeVisible();
  await expect(sidepanelPage.getByRole('option', {
    name: /^(Pause|Play|Unmute) music/,
  })).toHaveCount(0);
  await sidepanelPage.keyboard.press('Escape');

  await sidepanelPage.reload();
  await expect(sidepanelPage.getByRole('tab', { name: 'Bookmarks' })).toBeVisible();
  const toBookmarks = await sampleCompactViewSwitch(
    sidepanelPage,
    'bookmarks',
  );
  expect(toBookmarks.some((sample) =>
    sample.tabPanels > 0 &&
    sample.bookmarkPanels > 0 &&
    sample.bookmarkAnimations.includes('compact-bookmarks-in'))).toBe(true);
  await expect(sidepanelPage.locator('#workspace-panel-bookmarks')).toHaveCount(1);
  await expect(sidepanelPage.locator('.tabs-space-layer')).toHaveCount(0);
  await expect(outerBookmarkFolder).toHaveAttribute('aria-expanded', 'true');
  await expect(innerBookmarkFolder).toHaveAttribute('aria-expanded', 'true');
  await outerBookmarkFolder.click();
  await expect(outerBookmarkFolder).toHaveAttribute('aria-expanded', 'false');
  await expect(innerBookmarkFolder).toHaveCount(0);

  const toTabs = await sampleCompactViewSwitch(sidepanelPage, 'tabs');
  expect(toTabs.some((sample) =>
    sample.tabPanels > 0 &&
    sample.bookmarkPanels > 0 &&
    sample.bookmarkAnimations.includes('compact-bookmarks-out'))).toBe(true);
  await expect(sidepanelPage.locator('.tabs-space-layer')).toHaveCount(1);
  await expect(sidepanelPage.locator('#workspace-panel-bookmarks')).toHaveCount(0);
  await expect(splitter).toHaveCount(0);
  await expect(sharedTabRows).toHaveCount(1);
  await expect(nestedTabRows).toHaveCount(1);
  await sampleCompactViewSwitch(sidepanelPage, 'bookmarks');
  await expect(outerBookmarkFolder).toHaveAttribute('aria-expanded', 'false');
  await expect(innerBookmarkFolder).toHaveCount(0);
  await sampleCompactViewSwitch(sidepanelPage, 'tabs');

  await sidepanelPage.setViewportSize({ width: 900, height: 900 });
  await expect(sidepanelPage.locator('#workspace-panel-bookmarks')).toBeVisible();
  await expect(sidepanelPage.locator('.tabs-space-layer')).toHaveCount(1);
  await expect(splitter).toHaveCount(0);
  await expect(sharedTabRows).toHaveCount(1);
  await expect(nestedTabRows).toHaveCount(1);
  const widePanelPositions = await sidepanelPage.locator(
    '.workspace-view-content.is-split > .workspace-view-panel',
  ).evaluateAll((panels) => panels.map((panel) => {
    const bounds = panel.getBoundingClientRect();
    return { left: bounds.left, top: bounds.top };
  }));
  expect(widePanelPositions).toHaveLength(2);
  expect(Math.abs(widePanelPositions[0]!.top - widePanelPositions[1]!.top))
    .toBeLessThan(1);
  expect(Math.abs(widePanelPositions[0]!.left - widePanelPositions[1]!.left))
    .toBeGreaterThan(100);
  const wideAnimationNames = await sidepanelPage.locator(
    '.workspace-view-content.is-split .tree-list > li',
  ).evaluateAll((items) => items.map((item) => getComputedStyle(item).animationName));
  expect(wideAnimationNames.every((name) => !name.startsWith('compact-')))
    .toBe(true);
  await spaceDot(sidepanelPage, 'First space').click();
  await expect(sidepanelPage.locator(
    `[data-bookmark-node-id="${fixture.outerBookmarkFolderId}"] .folder-item`,
  )).toHaveAttribute('aria-expanded', 'true');
  await expect(sidepanelPage.locator(
    `[data-bookmark-node-id="${fixture.innerBookmarkFolderId}"] .folder-item`,
  )).toHaveAttribute('aria-expanded', 'true');
}));
