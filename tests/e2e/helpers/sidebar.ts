import { expect, type Locator, type Page } from '@playwright/test';
import { waitForActivationQuiescence } from '../fixtures/activation';

const dropShownSelector = '.is-over, .drop-inside, .drop-before, .drop-after, .drop-split';

type Box = { height: number; width: number; x: number; y: number };

/** Presses the middle of `source` and lifts it to 12px above its top edge. */
async function pressAndLift(page: Page, source: Box): Promise<void> {
  await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
  await page.mouse.down();
  await page.mouse.move(source.x + source.width / 2, source.y - 12, { steps: 3 });
}

/**
 * `shownOn` names where the drop shows when the target does not show it itself:
 * a list's add row is not a drop target, so a drop over it shows after the last row.
 */
export async function dragWithPointer(
  page: Page,
  source: Locator,
  target: Locator,
  shownOn: Locator = target,
): Promise<void> {
  // Like a person, it presses the source where it settles, follows the target as the drag
  // reshapes the sidebar, and lets go only once the drop shows: a busy page
  // can still be acting on an earlier pointer position when the last move arrives.
  await source.hover();
  const sourceBox = await source.boundingBox();
  // Handles keep hold of the elements while the drag changes the attributes their locators name.
  const targetElement = await target.elementHandle();
  const shownElement = shownOn === target ? targetElement : await shownOn.elementHandle();
  if (!sourceBox || !targetElement || !shownElement) throw new Error('Drag fixture was not measurable');
  try {
    await pressAndLift(page, sourceBox);
    await expect(async () => {
      const targetBox = await targetElement.boundingBox();
      if (!targetBox) throw new Error('The drop target is not visible');
      await page.mouse.move(
        targetBox.x + targetBox.width / 2,
        targetBox.y + targetBox.height / 2,
        { steps: 8 },
      );
      expect(
        await shownElement.evaluate((element, shown) =>
          [element, element.closest('.tree-row, .tab-row')]
            .some((candidate) => candidate?.matches(shown) ?? false), dropShownSelector),
        'the drop target shows the drop',
      ).toBe(true);
    }).toPass({ timeout: 5_000 });
    await page.mouse.up();
  } finally {
    await targetElement.dispose();
    if (shownElement !== targetElement) await shownElement.dispose();
  }
}

/** The backed tab row showing `url`, leaving out a stand-in row for an unbacked tab. */
export const backedTabRow = (page: Page, url: string) => page.locator(
  `.tab-row:has(.tab-main[data-url="${url}"]):not([data-tab-node-id^="unsupported-tab:"])`,
);

/** The last character of each listed tab's URL under `prefix`, in list order. */
export const tabUrlSuffixOrder = (page: Page, prefix: string) =>
  page.locator('.tab-row .tab-main').evaluateAll((mains, urlPrefix) =>
    mains.flatMap((main) => {
      const url = main.getAttribute('data-url') ?? '';
      return url.startsWith(urlPrefix) ? [url.slice(-1)] : [];
    }), prefix);

/** Presses the middle of a drag handle and pulls it `pull` px down (up when negative), far enough to start dragging. */
export async function pressAndPull(page: Page, handle: Locator, steps = 2, pull = 12): Promise<void> {
  const box = await handle.boundingBox();
  if (!box) throw new Error('The drag handle had no geometry');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + pull, { steps });
}

/** Presses on a settled tab row and pulls it far enough to start dragging. */
export async function liftTabRow(page: Page, row: Locator): Promise<void> {
  await expect(row.locator('xpath=ancestor::li[1]')).toHaveCSS('opacity', '1');
  await pressAndPull(page, row.locator('.tab-main'));
  await expect(row).toHaveClass(/is-dragging/);
}

export async function beginPointerDrag(page: Page, source: Locator): Promise<void> {
  // Like a person, it presses the row where it settles: rows slide into place after an earlier drag.
  await source.hover();
  const sourceBox = await source.boundingBox();
  if (!sourceBox) throw new Error('Drag source was not measurable');
  await pressAndLift(page, sourceBox);
  await expect(page.getByRole('navigation', { name: 'Spaces' })).toBeVisible();
  await expect(page.locator('.space-drop-tray')).toHaveCount(0);
  await expect(page.locator('.space-pagination-trash-target')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add space' })).toHaveCount(0);
}

export async function dragMarqueeSelection(
  page: Page,
  surface: Locator,
  firstRow: Locator,
  lastRow: Locator = firstRow,
  options: { fromRight?: boolean; modifier?: 'Control' | 'Meta' } = {},
): Promise<void> {
  await firstRow.scrollIntoViewIfNeeded();
  await lastRow.scrollIntoViewIfNeeded();
  const surfaceBox = await surface.boundingBox();
  const firstBox = await firstRow.boundingBox();
  const lastBox = await lastRow.boundingBox();
  const surfaceClientWidth = await surface.evaluate((element) => element.clientWidth);
  if (!surfaceBox || !firstBox || !lastBox) {
    throw new Error('Marquee selection bounds were not measurable');
  }
  const top = Math.min(firstBox.y, lastBox.y);
  const bottom = Math.max(
    firstBox.y + firstBox.height,
    lastBox.y + lastBox.height,
  );
  if (options.modifier) await page.keyboard.down(options.modifier);
  await page.mouse.move(
    surfaceBox.x + (options.fromRight ? surfaceClientWidth - 2 : 2),
    top + 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    options.fromRight
      ? Math.min(firstBox.x, lastBox.x) + 2
      : Math.max(firstBox.x + firstBox.width, lastBox.x + lastBox.width) - 2,
    bottom - 2,
    { steps: 8 },
  );
  await expect(page.locator('.drag-selection-marquee')).toBeVisible();
  await page.mouse.up();
  if (options.modifier) await page.keyboard.up(options.modifier);
  await expect(page.locator('.drag-selection-marquee')).toHaveCount(0);
}

export async function clickSelectionWithModifierReleased(
  page: Page,
  target: Locator,
): Promise<void> {
  await target.scrollIntoViewIfNeeded();
  const targetBox = await target.boundingBox();
  if (!targetBox) throw new Error('Selection target bounds were not measurable');
  const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
  const modifierInit = process.platform === 'darwin'
    ? { metaKey: true }
    : { ctrlKey: true };
  const pointerInit = {
    button: 0,
    clientX: targetBox.x + targetBox.width / 2,
    clientY: targetBox.y + targetBox.height / 2,
  };
  await page.keyboard.down(modifier);
  await target.dispatchEvent('pointerdown', {
    ...pointerInit,
    ...modifierInit,
    buttons: 1,
    pointerId: 1,
    pointerType: 'mouse',
  });
  await target.dispatchEvent('mousedown', {
    ...pointerInit,
    ...modifierInit,
    buttons: 1,
  });
  await page.keyboard.up(modifier);
  await target.dispatchEvent('pointerup', {
    ...pointerInit,
    pointerId: 1,
    pointerType: 'mouse',
  });
  await target.dispatchEvent('mouseup', pointerInit);
  await target.dispatchEvent('click', { ...pointerInit, detail: 1 });
}

function tabOrder(page: Page, trackedTabIds: readonly number[], backedOnly: boolean): Promise<number[]> {
  return page.locator('[data-tab-id]').evaluateAll((rows, { backed, tabIds }) => {
    const trackedIds = new Set(tabIds);
    return rows.flatMap((row) => {
      const { tabId, tabNodeId } = (row as HTMLElement).dataset;
      return trackedIds.has(Number(tabId)) && !(backed && tabNodeId?.startsWith('unsupported-tab:'))
        ? [Number(tabId)]
        : [];
    });
  }, { backed: backedOnly, tabIds: [...trackedTabIds] });
}

export async function renderedTabOrder(
  page: Page,
  trackedTabIds: readonly number[],
): Promise<number[]> {
  return tabOrder(page, trackedTabIds, false);
}

/**
 * The tracked tabs whose rows stand for their bookmarks, in list order. A tab
 * opened a moment ago has a row before its bookmark exists, and only the
 * bookmark's place in the list lasts.
 */
export async function backedTabOrder(
  page: Page,
  trackedTabIds: readonly number[],
): Promise<number[]> {
  return tabOrder(page, trackedTabIds, true);
}

/**
 * Drops one tab row on the top edge of another, so it lands just before it.
 * Like a person, it presses the row once the row takes the press (a row that
 * just opened is still growing into place), and lets go once the drop line
 * shows above the target.
 */
export async function dragTabRowBefore(
  page: Page,
  sourceTabId: number,
  targetTabId: number,
): Promise<void> {
  const row = (tabId: number) => page.locator(`.tab-row[data-tab-id="${tabId}"]`);
  const source = row(sourceTabId);
  const target = row(targetTabId);
  const handle = source.locator('.tab-main');
  await expect(handle).toHaveAttribute('draggable', 'true');
  await handle.hover();
  const pressed = await handle.boundingBox();
  if (!pressed) throw new Error('The dragged tab row was not measurable');
  await page.mouse.down();
  await page.mouse.move(
    pressed.x + pressed.width / 2,
    pressed.y + pressed.height / 2 + 12,
    { steps: 3 },
  );
  await expect(source).toContainClass('is-dragging');
  await expect(async () => {
    const box = await target.boundingBox();
    if (!box) throw new Error('The target tab row was not measurable');
    await page.mouse.move(box.x + box.width / 2, box.y + 3, { steps: 4 });
    await expect(target).toContainClass('drop-before', { timeout: 1_000 });
  }).toPass();
  await page.mouse.up();
}

/** Expects the one header message to read `status`, then answers it with `button`, drawn as the `icon` class. */
export async function answerNotice(page: Page, status: string, button: string, icon: string): Promise<void> {
  const notices = page.locator('.topbar .countdown-notice');
  await expect(notices).toHaveCount(1);
  await expect(notices.getByRole('status')).toHaveText(status);
  const answer = notices.getByRole('button', { name: button });
  await expect(answer.locator(`svg.${icon}`)).toBeVisible();
  await answer.click();
  await expect(notices).toHaveCount(0);
}

export function spaceDot(page: Page, title: string): Locator {
  return page.locator(`.space-pagination-dot[aria-label="Open ${title}"]`);
}

export function spaceDotById(scope: Page | Locator, spaceId: string): Locator {
  return scope.locator(`.space-pagination-dot[data-space-id="${spaceId}"]`);
}

export async function selectSpace(page: Page, title: string): Promise<void> {
  const button = spaceDot(page, title);
  await button.click();
  await expect(button).toHaveAttribute('aria-current', 'page');
  await waitForActivationQuiescence(page);
}

export async function dragBookmarkToScopeTarget(
  page: Page,
  source: Locator,
  target: Locator,
  pickUpSteps = 3,
): Promise<void> {
  await expect(source).toBeVisible();
  await expect(source).toHaveAttribute('aria-disabled', 'false');
  await pressAndPull(page, source, pickUpSteps);
  await expect(page.locator('.space-pagination-trash-target')).toBeVisible();
  await expect(target).toBeVisible();
  const targetBounds = await target.boundingBox();
  if (!targetBounds) throw new Error('Bookmark scope drag target was not measurable');
  await page.mouse.move(
    targetBounds.x + targetBounds.width / 2,
    targetBounds.y + targetBounds.height / 2,
    { steps: 8 },
  );
  await expect(target).toHaveClass(/is-over/);
  await page.mouse.up();
}

export async function dragSpaceToPaginationTarget(
  page: Page,
  title: string,
  targetSelector: string,
): Promise<void> {
  const source = spaceDot(page, title);
  const sourceBounds = await source.boundingBox();
  const sourceVisual = source.locator('.space-pagination-dot-visual');
  const sourceVisualBounds = await sourceVisual.boundingBox();
  expect(sourceBounds).not.toBeNull();
  expect(sourceVisualBounds).not.toBeNull();
  await page.mouse.move(
    sourceBounds!.x + sourceBounds!.width / 2,
    sourceBounds!.y + sourceBounds!.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    sourceBounds!.x + sourceBounds!.width / 2 + 12,
    sourceBounds!.y + sourceBounds!.height / 2,
    { steps: 3 },
  );
  await expect(page.getByRole('navigation', { name: 'Spaces' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Move or delete item' }))
    .toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add space' })).toHaveCount(0);
  await expect(page.locator('.space-pagination-trash-target')).toBeVisible();
  await expect(source).toHaveClass(/is-dragging/);
  await expect(source).toHaveCSS('opacity', '0.25');
  const overlay = page.locator('.space-drag-overlay');
  await expect(overlay).toBeVisible();
  const overlayBounds = await overlay.boundingBox();
  expect(overlayBounds).not.toBeNull();
  expect(overlayBounds!.width).toBeCloseTo(sourceVisualBounds!.width, 1);
  expect(overlayBounds!.height).toBeCloseTo(sourceVisualBounds!.height, 1);
  const overlayBorder = await overlay.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      background: style.backgroundColor,
      color: style.borderTopColor,
      width: style.borderTopWidth,
    };
  });
  expect(overlayBorder.width).toBe('1px');
  expect(overlayBorder.color).toBe(await source.evaluate((element) =>
    getComputedStyle(element).color));
  const paginationBackground = await page.locator('.space-pagination').evaluate(
    (element) => getComputedStyle(element).backgroundColor,
  );
  const rgbChannels = (color: string) => color.match(/[\d.]+/g)?.slice(0, 3);
  expect(rgbChannels(overlayBorder.background)).toEqual(
    rgbChannels(paginationBackground),
  );
  expect(overlayBorder.background).toMatch(/^rgb\(/);
  const sourceCenterOffset = await source.evaluate((element) => {
    const visual = element.querySelector<HTMLElement>('.space-pagination-dot-visual');
    if (!visual) return Number.POSITIVE_INFINITY;
    const itemBounds = element.getBoundingClientRect();
    const visualBounds = visual.getBoundingClientRect();
    return visualBounds.top + visualBounds.height / 2 -
      (itemBounds.top + itemBounds.height / 2);
  });
  expect(sourceCenterOffset).toBeCloseTo(0, 1);
  const target = page.locator(targetSelector);
  const targetBounds = await target.boundingBox();
  expect(targetBounds).not.toBeNull();
  const sourceIndex = await source.evaluate((element) =>
    Array.from(element.parentElement?.children ?? []).indexOf(element));
  const targetIndex = await target.evaluate((element) =>
    Array.from(element.parentElement?.children ?? []).indexOf(element));
  const targetIsDot = await target.evaluate((element) =>
    element.classList.contains('space-pagination-dot'));
  // A space dropped on a dot lands beside its nearer edge, so aim at the far half to move past it.
  const xFraction = targetIsDot ? sourceIndex < targetIndex ? 0.75 : 0.25 : 0.5;
  await page.mouse.move(
    targetBounds!.x + targetBounds!.width * xFraction,
    targetBounds!.y + targetBounds!.height / 2,
    { steps: 8 },
  );
  if (targetIsDot) {
    await expect(target).not.toHaveAttribute('data-space-drop-position');
    await expect(target).toHaveClass(sourceIndex < targetIndex ? /is-insert-after/ : /is-insert-before/);
    expect(await target.evaluate((element) =>
      getComputedStyle(element, '::before').content)).not.toBe('none');
    // The dots hold still under the pointer rather than shuffling aside.
    expect(await source.evaluate((element) => getComputedStyle(element).transform)).toBe('none');
    expect(await target.evaluate((element) => getComputedStyle(element).transform)).toBe('none');
  } else {
    await expect(target).toHaveClass(/is-over/);
    await expect(target.locator('.space-pagination-trash-label'))
      .toHaveText(`Delete ${title}`);
    await expect(target.locator('.space-pagination-trash-label'))
      .toHaveCSS('opacity', '1');
    const trashIconBounds = await target.locator('svg').boundingBox();
    const trashLabelBounds = await target.locator(
      '.space-pagination-trash-label',
    ).boundingBox();
    expect(trashIconBounds).not.toBeNull();
    expect(trashLabelBounds).not.toBeNull();
    expect(trashLabelBounds!.x).toBeGreaterThan(
      trashIconBounds!.x + trashIconBounds!.width,
    );
    expect(trashLabelBounds!.y + trashLabelBounds!.height / 2).toBeCloseTo(
      trashIconBounds!.y + trashIconBounds!.height / 2,
      1,
    );
    const paginationItems = page.locator('.space-pagination-items');
    await expect(paginationItems).toHaveClass(/is-trash-over/);
    // The dots step aside as a group: the container fades and stops taking the
    // pointer, and the trash target grows across the row it leaves behind.
    const paginationDots = paginationItems.locator('.space-pagination-dots');
    await expect(paginationDots).toHaveCSS('opacity', '0');
    await expect(paginationDots).toHaveCSS('pointer-events', 'none');
    // The target keeps its own narrow column; it is the visual that stretches
    // across the row the dots vacated, and that carries the drop styling.
    const trashVisual = target.locator('.space-pagination-trash-visual');
    await expect.poll(async () => {
      const [paginationBounds, visualBounds] = await Promise.all([
        page.locator('.space-pagination').boundingBox(),
        trashVisual.boundingBox(),
      ]);
      if (!paginationBounds || !visualBounds) return 0;
      return visualBounds.width / paginationBounds.width;
    }).toBeGreaterThan(0.8);
    const trashFocus = await trashVisual.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        background: style.backgroundColor,
        border: style.borderColor,
        boxShadow: style.boxShadow,
      };
    });
    expect(trashFocus.background).not.toBe('rgba(0, 0, 0, 0)');
    expect(trashFocus.border).not.toBe('rgba(0, 0, 0, 0)');
    expect(trashFocus.boxShadow).not.toBe('none');
  }
  await page.mouse.up();
}

// A dot's tooltip names its shortcut after the title, as in "Space 1 (⌥1)".
export const spaceDotTitles = (page: Page) => page.locator('.space-pagination-dot')
  .evaluateAll((dots) => dots.map((dot) => dot.getAttribute('title')?.replace(/ \([^)]*\)$/, '')));
