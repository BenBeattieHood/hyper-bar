import {
  expect,
  test,
  type BrowserContext,
  type Locator,
  type Page,
  type Worker,
} from '@playwright/test';
import { localBookmarksRootId } from './fixtures/localBookmarks';
import { saveHyperPreference } from './fixtures/preferences';
import { paintedCustomProperty } from './fixtures/styles';
import { bookmarkParentId, callChrome, seedHyperSpace } from './helpers/chrome';
import {
  openSidepanel,
  sidepanelUrl,
  withExtension,
  type ExtensionLaunchOptions,
} from './helpers/extension';
import { dragBookmarkToScopeTarget, pressAndPull, spaceDotById } from './helpers/sidebar';
import { createTab } from './helpers/tabs';

interface AnimationSample {
  childPresent: boolean;
  elapsed: number;
  height: number;
  opacity: number;
  spacing: number;
}

type BookmarkFixture = Awaited<ReturnType<typeof createBookmarkFixture>>;

async function createBookmarkFixture(worker: Worker) {
  const ids = await seedHyperSpace<
    'closing' | `closing${number}` | 'final' | 'finalChild' | 'following' | 'opening' | 'openingChild'
  >(worker, {
    space: 'Space 1',
    tabs: [],
    bookmarks: [
      {
        key: 'opening',
        title: 'Opening animation folder',
        children: [{
          key: 'openingChild',
          title: 'Opening animation child',
          url: 'https://example.com/opening-animation-child',
        }],
      },
      {
        key: 'closing',
        title: 'Closing animation folder',
        children: Array.from({ length: 6 }, (_, index) => ({
          key: `closing${index}`,
          title: `Closing animation child ${index + 1}`,
          url: `https://example.com/closing-animation-child-${index + 1}`,
        })),
      },
      { key: 'following', title: 'Following bookmark', url: 'https://example.com/following-bookmark' },
      {
        key: 'final',
        title: 'Final single-child folder',
        children: [{
          key: 'finalChild',
          title: 'Final single child',
          url: 'https://example.com/final-single-child',
        }],
      },
    ],
  });
  return {
    bookmarksRootId: ids.spaceBookmarks,
    closingChildIds: Array.from({ length: 6 }, (_, index) => ids[`closing${index}`]!),
    closingFolderId: ids.closing,
    finalChildId: ids.finalChild,
    finalFolderId: ids.final,
    followingId: ids.following,
    openingChildId: ids.openingChild,
    openingFolderId: ids.opening,
    spaceId: ids.space,
    spacesId: ids.spaces,
  };
}

/** Runs `run` in a fresh browser holding the bookmark fixture, with no page open. */
async function withBookmarkFixture(
  name: string,
  run: (hyper: { context: BrowserContext; fixture: BookmarkFixture; worker: Worker }) => Promise<void>,
  options: ExtensionLaunchOptions = {},
): Promise<void> {
  await withExtension(name, async ({ context, worker }) => {
    await run({ context, fixture: await createBookmarkFixture(worker), worker });
  }, { closeInitialPage: true, ...options });
}

const openTab = (worker: Worker, url: string) => createTab(worker, url, { active: false });

/** Measures the tree list holding a folder row, its drop zone and its scroller. */
const folderGeometry = (folder: Locator) => folder.evaluate((row) => {
  const list = row.closest('ul');
  const dropZone = list?.parentElement;
  const stack = row.closest<HTMLElement>('.bookmark-tree-stack');
  return {
    dropZoneHeight: dropZone?.getBoundingClientRect().height ?? 0,
    listHeight: list?.getBoundingClientRect().height ?? 0,
    scrollHeight: stack?.scrollHeight ?? 0,
    scrollTop: stack?.scrollTop ?? 0,
    trailingTargetHeight: dropZone?.querySelector<HTMLElement>(
      ':scope > .tree-root-drop-target',
    )?.getBoundingClientRect().height ?? 0,
  };
});

/** Clicks the middle of a row five times in quick succession. */
async function clickRapidly(page: Page, row: Locator): Promise<void> {
  const bounds = await row.boundingBox();
  if (!bounds) throw new Error('Rapidly clicked row was not measurable');
  for (let clickIndex = 0; clickIndex < 5; clickIndex += 1) {
    await page.mouse.click(
      bounds.x + bounds.width / 2,
      bounds.y + bounds.height / 2,
      { delay: 8 },
    );
    if (clickIndex < 4) await page.waitForTimeout(35);
  }
}

async function sampleFolderToggle(
  page: Page,
  folderId: string,
  childIds: string[],
  followingId: string,
): Promise<AnimationSample[]> {
  return page.evaluate(({
    childIds: targetChildIds,
    folderId: targetFolderId,
    followingId: targetFollowingId,
  }) =>
    new Promise<AnimationSample[]>((resolveSamples) => {
      const folder = document.querySelector<HTMLElement>(
        `[data-bookmark-node-id="${targetFolderId}"] .folder-item`,
      );
      if (!folder) throw new Error('Folder row was not rendered');
      const samples: AnimationSample[] = [];
      const startedAt = performance.now();
      folder.click();
      const sample = () => {
        const folderItem = document.querySelector<HTMLElement>(
          `[data-bookmark-node-id="${targetFolderId}"]`,
        )?.parentElement;
        const followingItem = document.querySelector<HTMLElement>(
          `[data-bookmark-node-id="${targetFollowingId}"]`,
        )?.parentElement;
        const childItems = targetChildIds.flatMap((targetChildId) => {
          const child = document.querySelector<HTMLElement>(
            `[data-bookmark-node-id="${targetChildId}"]`,
          )?.parentElement;
          return child ? [child] : [];
        });
        const child = childItems[0];
        if (child) {
          const style = getComputedStyle(child);
          const childrenHeight = childItems.reduce(
            (total, item) => total + item.getBoundingClientRect().height,
            0,
          );
          const spacing = folderItem && followingItem
            ? followingItem.getBoundingClientRect().top -
              folderItem.getBoundingClientRect().bottom - childrenHeight
            : 0;
          samples.push({
            childPresent: true,
            elapsed: performance.now() - startedAt,
            height: child.getBoundingClientRect().height,
            opacity: Number(style.opacity),
            spacing,
          });
        }
        if (performance.now() - startedAt < 300) requestAnimationFrame(sample);
        else resolveSamples(samples);
      };
      requestAnimationFrame(sample);
    }), { childIds, folderId, followingId });
}

function hasIntermediateFrame(samples: AnimationSample[]): boolean {
  const fullHeight = Math.max(...samples.map((sample) => sample.height));
  return samples.some((sample) =>
    (sample.height > 0.5 && sample.height < fullHeight - 0.5) ||
    (sample.opacity > 0.01 && sample.opacity < 0.99));
}

function hasIntermediateHeightFrame(samples: AnimationSample[]): boolean {
  const fullHeight = Math.max(...samples.map((sample) => sample.height));
  return samples.some((sample) =>
    sample.height > 0.5 && sample.height < fullHeight - 0.5);
}

function openingStartsNearCollapsed(samples: AnimationSample[]): boolean {
  const fullHeight = Math.max(...samples.map((sample) => sample.height));
  const firstVisibleFrame = samples.find((sample) => sample.height > 0.5);
  return Boolean(
    firstVisibleFrame && firstVisibleFrame.height < fullHeight * 0.5,
  );
}

function spacingTweensClosed(samples: AnimationSample[]): boolean {
  const mountedSamples = samples.filter((sample) => sample.childPresent);
  const initialSpacing = Math.max(...mountedSamples.map((sample) => sample.spacing));
  const finalMountedSpacing = mountedSamples.at(-1)?.spacing ?? initialSpacing;
  return finalMountedSpacing < initialSpacing / 2;
}

function contentLeadsOpeningGeometry(samples: AnimationSample[]): boolean {
  const fullHeight = Math.max(...samples.map((sample) => sample.height));
  const halfwaySample = samples.find((sample) => sample.height >= fullHeight / 2);
  return Boolean(halfwaySample && halfwaySample.opacity >= 0.6);
}

function contentTrailsClosingGeometry(samples: AnimationSample[]): boolean {
  const fullHeight = Math.max(...samples.map((sample) => sample.height));
  const halfwaySample = samples.find((sample) => sample.height <= fullHeight / 2);
  return Boolean(halfwaySample && halfwaySample.opacity >= 0.6);
}

async function waitForStableFolderTree(
  page: Page,
  folderIds: string[],
  expanded: boolean,
): Promise<void> {
  await page.evaluate(({ targetFolderIds, targetExpanded }) =>
    new Promise<void>((resolveReady) => {
    let stableSince: number | undefined;
    const sample = () => {
      const matches = targetFolderIds.every((folderId) =>
        document.querySelector(
          `[data-bookmark-node-id="${folderId}"] .folder-item`,
        )?.getAttribute('aria-expanded') === String(targetExpanded));
      if (!matches) stableSince = undefined;
      else stableSince ??= performance.now();
      if (stableSince !== undefined && performance.now() - stableSince >= 500) resolveReady();
      else requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  }), { targetFolderIds: folderIds, targetExpanded: expanded });
}

async function expectControlsNotToOverlap(
  controls: Array<Locator>,
): Promise<void> {
  const boxes = await Promise.all(controls.map((control) => control.boundingBox()));
  expect(boxes.every(Boolean)).toBe(true);
  for (let index = 0; index < boxes.length; index += 1) {
    const box = boxes[index];
    if (!box) continue;
    for (const nextBox of boxes.slice(index + 1)) {
      if (!nextBox) continue;
      const overlapWidth = Math.min(box.x + box.width, nextBox.x + nextBox.width) -
        Math.max(box.x, nextBox.x);
      const overlapHeight = Math.min(box.y + box.height, nextBox.y + nextBox.height) -
        Math.max(box.y, nextBox.y);
      expect(overlapWidth <= 0 || overlapHeight <= 0).toBe(true);
    }
  }
}

async function assertBookmarkDragCollapsesSource(
  page: Page,
  sourceId: string,
  targetId: string,
): Promise<void> {
  const sourceRow = page.locator(`[data-bookmark-node-id="${sourceId}"]`);
  const sourceItem = sourceRow.locator('..');
  const sourceHandle = sourceRow.locator('.tree-item-main');
  const targetRow = page.locator(`[data-bookmark-node-id="${targetId}"]`);
  await expect(sourceItem).toHaveCSS('height', '36px');
  await expect(sourceItem).toHaveCSS('opacity', '1');
  await pressAndPull(page, sourceHandle);
  await expect(sourceRow).toHaveClass(/is-dragging/);
  await expect(sourceItem).toHaveCSS('height', '0px');
  await expect(sourceItem).toHaveCSS('min-height', '0px');
  const targetBox = await targetRow.boundingBox();
  if (!targetBox) throw new Error('Bookmark drag target was not measurable');
  await page.mouse.move(
    targetBox.x + targetBox.width / 2,
    targetBox.y + targetBox.height * 0.75,
    { steps: 8 },
  );
  await expect(page.locator('.tree-drop-placeholder')).toBeVisible();
  await page.mouse.up();
}

test('tweens bookmark folder children while opening and closing', async () => {
  await withBookmarkFixture('folder-animation', async ({ context, fixture, worker }) => {
    await saveHyperPreference(worker, 'combineTabsAndBookmarks', false);
    for (let index = 0; index < 10; index += 1) {
      await callChrome(worker, 'bookmarks.create', {
        index: 3,
        parentId: fixture.bookmarksRootId,
        title: `Preceding bookmark ${index + 1}`,
        url: `https://example.com/preceding-bookmark-${index + 1}`,
      });
    }
    const sidepanelPage = await context.newPage();
    await sidepanelPage.setViewportSize({ width: 600, height: 900 });
    await openTab(worker, 'https://example.com/final-single-child');
    await sidepanelPage.goto(sidepanelUrl(worker), { waitUntil: 'domcontentloaded' });
    await sidepanelPage.getByRole('tab', { name: 'Bookmarks' }).click();

    const folder = sidepanelPage.locator(
      `[data-bookmark-node-id="${fixture.openingFolderId}"] .folder-item`,
    );
    await expect(folder).toBeVisible();
    await expect(folder).toHaveAttribute('aria-expanded', 'false');
    await expect(sidepanelPage.locator(
      `[data-bookmark-node-id="${fixture.openingChildId}"]`,
    )).toHaveCount(0);
    const finalFolder = sidepanelPage.locator(
      `[data-bookmark-node-id="${fixture.finalFolderId}"] .folder-item`,
    );
    const finalChild = sidepanelPage.locator(
      `[data-bookmark-node-id="${fixture.finalChildId}"]`,
    );
    await expect(finalFolder).toHaveAttribute('aria-expanded', 'true');
    await expect(finalChild).toBeVisible();
    await finalFolder.click();
    await expect(finalFolder).toHaveAttribute('aria-expanded', 'false');
    await expect(finalChild).toHaveCount(0);
    await sidepanelPage.setViewportSize({ width: 600, height: 420 });
    await sidepanelPage.locator('.bookmark-tree-stack').evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    const collapsedGeometry = await folderGeometry(finalFolder);
    await expect(finalFolder).toBeInViewport();
    await finalFolder.click();
    await expect(finalChild).toBeInViewport({ ratio: 1 });
    await expect(finalChild.locator('..')).toHaveCSS('height', '36px');
    await expect(finalChild.locator('..')).toHaveCSS('opacity', '1');
    await expect.poll(() => finalChild.evaluate((child) => {
      const scroller = child.closest<HTMLElement>('.bookmark-tree-stack');
      if (!scroller) return false;
      const childBounds = child.getBoundingClientRect();
      const scrollerBounds = scroller.getBoundingClientRect();
      const scrollInset = Number.parseFloat(
        getComputedStyle(scroller).scrollPaddingBottom,
      ) || 0;
      return childBounds.bottom <= scrollerBounds.bottom - scrollInset;
    })).toBe(true);
    const expandedGeometry = await folderGeometry(finalFolder);
    expect(expandedGeometry.listHeight - collapsedGeometry.listHeight)
      .toBeCloseTo(37, 0);
    expect(expandedGeometry.dropZoneHeight - collapsedGeometry.dropZoneHeight)
      .toBeCloseTo(37, 0);
    expect(expandedGeometry.scrollHeight - collapsedGeometry.scrollHeight)
      .toBeCloseTo(37, 0);
    expect(collapsedGeometry.trailingTargetHeight).toBeCloseTo(37, 0);
    expect(expandedGeometry.trailingTargetHeight).toBeCloseTo(37, 0);
    expect(expandedGeometry.scrollTop).toBeCloseTo(collapsedGeometry.scrollTop, 0);
    await finalFolder.click();
    await expect(finalChild).toHaveCount(0);
    const rapidToggleGeometry = sidepanelPage.evaluate(() =>
      new Promise<Array<{ childrenHeight: number; listHeight: number }>>(
        (resolveSamples) => {
          const samples: Array<{ childrenHeight: number; listHeight: number }> = [];
          const startedAt = performance.now();
          const sample = () => {
            const list = document.querySelector<HTMLElement>('.bookmark-tree-stack > .tree-drop-zone > .tree-list');
            if (list) {
              const items = Array.from(list.children).filter(
                (child): child is HTMLElement => child instanceof HTMLElement,
              );
              samples.push({
                childrenHeight: items.reduce((total, item) => {
                  const style = getComputedStyle(item);
                  return total + item.getBoundingClientRect().height +
                    Number.parseFloat(style.marginTop) +
                    Number.parseFloat(style.marginBottom);
                }, 0),
                listHeight: list.getBoundingClientRect().height,
              });
            }
            if (performance.now() - startedAt < 800) requestAnimationFrame(sample);
            else resolveSamples(samples);
          };
          requestAnimationFrame(sample);
        },
      ));
    await clickRapidly(sidepanelPage, finalFolder);
    const rapidSamples = await rapidToggleGeometry;
    expect(rapidSamples.every((sample, index) =>
      index === 0 || sample.listHeight >= rapidSamples[index - 1]!.listHeight - 0.5),
    JSON.stringify(rapidSamples)).toBe(true);
    expect(Math.max(...rapidSamples.map((sample) =>
      Math.abs(sample.listHeight - sample.childrenHeight)))).toBeLessThan(1);
    await expect(finalChild).toBeInViewport({ ratio: 1 });
    await expect(finalChild.locator('..')).toHaveCSS('height', '36px');
    await expect(finalChild.locator('..')).toHaveCSS('opacity', '1');
    const settledRapidToggleGeometry = await finalFolder.evaluate((folder) => {
      const list = folder.closest('ul');
      if (!list) throw new Error('Final folder list was not rendered');
      const items = Array.from(list.children).filter(
        (child): child is HTMLElement => child instanceof HTMLElement,
      );
      const nodeIds = items.flatMap((item) => {
        const row = item.querySelector<HTMLElement>('[data-bookmark-node-id]');
        return row?.dataset.bookmarkNodeId ? [row.dataset.bookmarkNodeId] : [];
      });
      const childrenHeight = items.reduce((total, item) => {
        const style = getComputedStyle(item);
        return total + item.getBoundingClientRect().height +
          Number.parseFloat(style.marginTop) + Number.parseFloat(style.marginBottom);
      }, 0);
      return {
        childrenHeight,
        duplicateNodeIds: nodeIds.filter((id, index) => nodeIds.indexOf(id) !== index),
        listHeight: list.getBoundingClientRect().height,
      };
    });
    expect(settledRapidToggleGeometry.duplicateNodeIds).toEqual([]);
    expect(settledRapidToggleGeometry.listHeight)
      .toBeCloseTo(settledRapidToggleGeometry.childrenHeight, 0);
    await finalFolder.click();
    await expect(finalChild).toHaveCount(0);
    await sidepanelPage.setViewportSize({ width: 600, height: 900 });
    await waitForStableFolderTree(sidepanelPage, [
      fixture.openingFolderId,
      fixture.closingFolderId,
    ], false);

    await expect(sidepanelPage.locator('.space-title-input'))
      .toHaveCSS('cursor', 'text');

    const openingSamples = await sampleFolderToggle(
      sidepanelPage,
      fixture.openingFolderId,
      [fixture.openingChildId],
      fixture.followingId,
    );
    expect(hasIntermediateFrame(openingSamples), JSON.stringify(openingSamples))
      .toBe(true);
    expect(openingStartsNearCollapsed(openingSamples), JSON.stringify(openingSamples))
      .toBe(true);
    expect(contentLeadsOpeningGeometry(openingSamples), JSON.stringify(openingSamples))
      .toBe(true);
    await folder.click();
    await expect(folder).toHaveAttribute('aria-expanded', 'false');
    await expect(sidepanelPage.locator(
      `[data-bookmark-node-id="${fixture.openingChildId}"]`,
    )).toHaveCount(0);

    const closingFolder = sidepanelPage.locator(
      `[data-bookmark-node-id="${fixture.closingFolderId}"] .folder-item`,
    );
    const collapsedFolderIcon = closingFolder.locator('.bookmark-folder-icon');
    await expect(collapsedFolderIcon.locator('.lucide-folder')).toHaveCount(1);
    await expect(collapsedFolderIcon.locator('svg path')).toHaveCount(1);
    await expect(collapsedFolderIcon.locator('.folder-count')).toHaveText('6');
    await closingFolder.click();
    const closingChild = sidepanelPage.locator(
      `[data-bookmark-node-id="${fixture.closingChildIds[0]}"]`,
    ).locator('..');
    await expect(closingChild).toHaveCSS('height', '36px');
    await expect(closingChild).toHaveCSS('opacity', '1');

    const closingSamples = await sampleFolderToggle(
      sidepanelPage,
      fixture.closingFolderId,
      fixture.closingChildIds,
      fixture.followingId,
    );
    expect(hasIntermediateHeightFrame(closingSamples), JSON.stringify(closingSamples))
      .toBe(true);
    expect(spacingTweensClosed(closingSamples), JSON.stringify(closingSamples))
      .toBe(true);
    expect(contentTrailsClosingGeometry(closingSamples), JSON.stringify(closingSamples))
      .toBe(true);
    await expect(sidepanelPage.locator(
      `[data-bookmark-node-id="${fixture.closingChildIds[0]}"]`,
    )).toHaveCount(0);
    await clickRapidly(sidepanelPage, closingFolder);
    await expect(closingFolder).toHaveAttribute('aria-expanded', 'true');
    const rapidChildItems = fixture.closingChildIds.map((childId) =>
      sidepanelPage.locator(`[data-bookmark-node-id="${childId}"]`).locator('..'));
    await expect(rapidChildItems[0]!).toHaveCSS('height', '36px');
    await expect(rapidChildItems[0]!).toHaveCSS('opacity', '1');
    const settledMultiChildGeometry = await closingFolder.evaluate((folder) => {
      const list = folder.closest<HTMLElement>('ul');
      const dropZone = list?.parentElement;
      const rootTarget = dropZone?.querySelector<HTMLElement>(
        ':scope > .tree-root-drop-target',
      );
      if (!list || !dropZone || !rootTarget) {
        throw new Error('Closing folder tree geometry was not rendered');
      }
      const items = Array.from(list.children).filter(
        (child): child is HTMLElement => child instanceof HTMLElement,
      );
      const outerHeight = (element: HTMLElement) => {
        const style = getComputedStyle(element);
        return element.getBoundingClientRect().height +
          Number.parseFloat(style.marginTop) + Number.parseFloat(style.marginBottom);
      };
      return {
        childHeights: items.flatMap((item) =>
          item.querySelector('[data-bookmark-node-id]') ? [item.getBoundingClientRect().height] : []),
        dropZoneHeight: dropZone.getBoundingClientRect().height,
        expectedDropZoneHeight: outerHeight(list) + outerHeight(rootTarget),
        listHeight: list.getBoundingClientRect().height,
        expectedListHeight: items.reduce(
          (total, item) => total + outerHeight(item),
          0,
        ),
      };
    });
    expect(settledMultiChildGeometry.childHeights.every((height) => height === 36))
      .toBe(true);
    expect(settledMultiChildGeometry.listHeight)
      .toBeCloseTo(settledMultiChildGeometry.expectedListHeight, 0);
    expect(settledMultiChildGeometry.dropZoneHeight)
      .toBeCloseTo(settledMultiChildGeometry.expectedDropZoneHeight, 0);
    await closingFolder.click();
    await expect(sidepanelPage.locator(
      `[data-bookmark-node-id="${fixture.closingChildIds[0]}"]`,
    )).toHaveCount(0);
    await expect(folder).toHaveAttribute('aria-expanded', 'false');
    await Promise.all(Array.from({ length: 4 }, (_, index) =>
      callChrome(worker, 'bookmarks.create', {
        parentId: fixture.closingFolderId,
        title: `Capped count child ${index + 1}`,
        url: `https://example.com/capped-count-child-${index + 1}`,
      })));
    await expect(collapsedFolderIcon.locator('.folder-count')).toHaveText('9+');
    await folder.click();
    await expect(sidepanelPage.locator(
      `[data-bookmark-node-id="${fixture.openingChildId}"]`,
    )).toBeVisible();
    await assertBookmarkDragCollapsesSource(
      sidepanelPage,
      fixture.openingChildId,
      fixture.followingId,
    );
  }, { reducedMotion: 'no-preference' });
});

test('keeps successful bookmark scope changes out of the header', async () => {
  await withBookmarkFixture('silent-folder-scope', async ({ context, fixture, worker }) => {
    const { id: secondSpaceId } = await callChrome<{ id: string }>(worker, 'bookmarks.create', {
      parentId: fixture.spacesId,
      title: 'Space 2',
    });
    const sidepanelPage = await openSidepanel(
      context, worker, { width: 720, height: 900 }, { waitUntil: 'domcontentloaded' },
    );
    // The open sidebar's model ensures each space's structure, including its bookmarks root.
    const secondSpaceRootId = await localBookmarksRootId(worker, secondSpaceId);
    const folder = sidepanelPage.locator(
      `[data-bookmark-node-id="${fixture.openingFolderId}"] .folder-item`,
    );
    const secondSpaceTarget = spaceDotById(sidepanelPage, secondSpaceId);
    const folderIcon = folder.locator('.bookmark-folder-icon');
    await expect(folderIcon).not.toHaveClass(/is-local/);
    const folderColour = await folderIcon.evaluate(
      (icon) => getComputedStyle(icon).color,
    );
    await expect(sidepanelPage.locator(
      `[data-bookmark-node-id="${fixture.closingFolderId}"] .bookmark-folder-icon`,
    )).toHaveCSS('color', folderColour);
    await dragBookmarkToScopeTarget(sidepanelPage, folder, secondSpaceTarget, 2);
    await expect.poll(() => bookmarkParentId(worker, fixture.openingFolderId))
      .toBe(secondSpaceRootId);
    await expect(sidepanelPage.locator('.countdown-notice.is-error')).toHaveCount(0);

    await sidepanelPage.reload();
    await secondSpaceTarget.click();
    await expect(secondSpaceTarget).toHaveAttribute('aria-current', 'page');
    const movedFolder = sidepanelPage.getByRole('button', {
      name: 'Opening animation folder',
      exact: true,
    });
    const movedFolderIcon = movedFolder.locator('.bookmark-folder-icon');
    await expect(movedFolderIcon).not.toHaveClass(/is-local/);
    await expect(movedFolderIcon).toHaveCSS('color', folderColour);
    await expect(movedFolder.locator('.bookmark-folder-space-indicator')).toHaveCount(0);
    await movedFolder.click();
    await expect(sidepanelPage.locator(
      `[data-bookmark-node-id="${fixture.openingChildId}"]`,
    )).toBeVisible();
    await movedFolder.click();
    await expect(sidepanelPage.locator(
      `[data-bookmark-node-id="${fixture.openingChildId}"]`,
    )).toHaveCount(0);
    await expect(sidepanelPage.locator('.countdown-notice.is-error')).toHaveCount(0);
  });
});

test('uses direct bookmark and folder creation controls', async () => {
  await withBookmarkFixture('folder-actions', async ({ context, fixture, worker }) => {
    await saveHyperPreference(worker, 'autofolders', false);
    const sidepanelPage = await context.newPage();
    await openTab(worker, 'https://example.com/opening-animation-child?open-tab=1');
    await sidepanelPage.setViewportSize({ width: 720, height: 900 });
    await sidepanelPage.goto(sidepanelUrl(worker), { waitUntil: 'domcontentloaded' });
    const tabsHeaderActions = sidepanelPage.getByRole('group', {
      name: 'Create tab-list items',
    });
    const bookmarksHeaderActions = sidepanelPage.getByRole('group', {
      name: 'Create bookmark items',
    });
    const folderActions = sidepanelPage.getByRole('group', {
      name: 'Create items in Opening animation folder',
    });
    // Bookmarking the current tab is not a header button.
    await expect(tabsHeaderActions.getByRole('button')).toHaveCount(2);
    await expect(bookmarksHeaderActions.getByRole('button')).toHaveCount(1);
    for (const actions of [tabsHeaderActions, bookmarksHeaderActions]) {
      await expect(actions.locator('svg.lucide-bookmark-plus')).toHaveCount(0);
      await expect(actions.locator('svg.lucide-folder-plus')).toHaveCount(1);
    }
    await expect(sidepanelPage.locator('.create-action-group button[aria-haspopup]'))
      .toHaveCount(1);
    await expect(tabsHeaderActions.getByRole('button', { name: 'Show recent tabs' }))
      .toHaveAttribute('aria-haspopup', 'menu');

    await sidepanelPage.setViewportSize({ width: 600, height: 900 });
    const combinedToolbar = sidepanelPage.locator('.workspace-view-toolbar.is-combined');
    const combinedContent = sidepanelPage.locator('.workspace-view-content.is-combined');
    await expect(combinedToolbar).toBeVisible();
    await expect(tabsHeaderActions.getByRole('button')).toHaveCount(2);
    await expect(tabsHeaderActions.getByRole('button', {
      name: 'Create tab folder',
    })).toBeVisible();
    await expect(tabsHeaderActions.getByRole('button', {
      name: 'Show recent tabs',
    })).toBeVisible();
    const [combinedToolbarBounds, combinedContentBounds] = await Promise.all([
      combinedToolbar.boundingBox(),
      combinedContent.boundingBox(),
    ]);
    expect(combinedToolbarBounds).not.toBeNull();
    expect(combinedContentBounds).not.toBeNull();
    expect(combinedToolbarBounds!.y + combinedToolbarBounds!.height)
      .toBeLessThanOrEqual(combinedContentBounds!.y);

    await sidepanelPage.setViewportSize({ width: 720, height: 900 });
    await expect(bookmarksHeaderActions.getByRole('button')).toHaveCount(1);

    const folder = sidepanelPage.locator(
      `[data-bookmark-node-id="${fixture.openingFolderId}"] .folder-item`,
    );
    const folderIndicator = folder.locator('.folder-open-tab-indicator');
    await expect(folder).toHaveAttribute('aria-expanded', 'true');
    await waitForStableFolderTree(sidepanelPage, [fixture.openingFolderId], true);
    await expect.poll(() => folderActions.getByRole('button').evaluateAll((buttons) =>
      buttons.map((button) => button.getAttribute('aria-label')))).toEqual([
      'Create subfolder in Opening animation folder',
      'Bookmark current tab in Opening animation folder',
    ]);
    const folderRow = sidepanelPage.locator(
      `[data-bookmark-node-id="${fixture.openingFolderId}"]`,
    );
    const [folderSurfaceBounds, folderActionsBounds] = await Promise.all([
      folderRow.locator('.tree-item-surface').boundingBox(),
      folderActions.boundingBox(),
    ]);
    expect(folderSurfaceBounds).not.toBeNull();
    expect(folderActionsBounds).not.toBeNull();
    expect(folderActionsBounds!.x - (
      folderSurfaceBounds!.x + folderSurfaceBounds!.width
    )).toBeCloseTo(5, 0);
    const firstFolderAction = folderActions.getByRole('button').first();
    await expect(firstFolderAction).toHaveCSS('border-top-width', '0px');
    await expect(firstFolderAction).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    // A row's action buttons answer a hover with their colour; the row itself
    // carries the fill, so a second background here would double up on it.
    const restingColour = await firstFolderAction.evaluate(
      (element) => getComputedStyle(element).color,
    );
    await firstFolderAction.hover();
    await expect(firstFolderAction).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await expect.poll(() => firstFolderAction.evaluate(
      (element) => getComputedStyle(element).color,
    )).not.toBe(restingColour);
    await expect(sidepanelPage.getByRole('separator', { name: 'Local bookmarks' }))
      .toHaveCount(0);
    await folder.click();
    await expect(folder).toHaveAttribute('aria-expanded', 'false');
    await expect(folder).toHaveAttribute(
      'aria-label',
      /contains bookmarks open as tabs/,
    );
    await expect(folderIndicator.locator('.bookmark-space-indicator')).toHaveCount(1);
    await expect(folderIndicator.locator('svg')).toHaveCount(0);
    await expect(folderActions.getByRole('button')).toHaveCount(1);
    await expect(folderActions.getByRole('button')).toHaveAttribute(
      'aria-label',
      'Bookmark current tab in Opening animation folder',
    );
    await expect(folderActions.locator('svg.lucide-bookmark-plus')).toHaveCount(1);
    await expect(folderActions.locator('svg.lucide-folder-plus')).toHaveCount(0);
    const inactiveFolder = sidepanelPage.locator(
      `[data-bookmark-node-id="${fixture.closingFolderId}"] .folder-item`,
    );
    await expect(inactiveFolder.locator('.folder-open-tab-indicator')).toHaveCount(0);

    await folder.click();
    await expect(folder).toHaveAttribute('aria-expanded', 'true');
    await expect(folderIndicator).toHaveCount(0);
    await expect(folderActions.getByRole('button')).toHaveCount(2);
    await expect(folderActions.locator('svg.lucide-bookmark-plus')).toHaveCount(1);
    await expect(folderActions.locator('svg.lucide-folder-plus')).toHaveCount(1);
    await expect(folderActions.locator('svg.lucide-log-in')).toHaveCount(0);
    await expect(folder.locator('.bookmark-folder-space-indicator')).toHaveCount(0);
    await folderActions.getByRole('button', {
      name: 'Create subfolder in Opening animation folder',
    }).click();
    await expect(sidepanelPage.getByRole('dialog', { name: 'New folder' })).toBeVisible();
    await expect(folder).toHaveAttribute('aria-expanded', 'true');
    await sidepanelPage.getByRole('button', { name: 'Close editor' }).click();
    await folder.click();
    await expect(folder).toHaveAttribute('aria-expanded', 'false');

    const bookmarkFolderAction = bookmarksHeaderActions.getByRole('button', {
      name: 'Create bookmark folder',
    });
    await expect(bookmarkFolderAction).toBeEnabled();
    await bookmarkFolderAction.click();
    await expect(sidepanelPage.getByRole('dialog', { name: 'New folder' })).toBeVisible();
    await sidepanelPage.getByRole('button', { name: 'Close editor' }).click();

    const tabFolderAction = tabsHeaderActions.getByRole('button', {
      name: 'Create tab folder',
    });
    await expect(tabFolderAction).toBeEnabled();
    await tabFolderAction.click();
    const tabFolderDialog = sidepanelPage.getByRole('dialog', {
      name: 'New tab folder',
    });
    await expect(tabFolderDialog).toBeVisible();
    await tabFolderDialog.getByLabel('Title').fill('Responsive tab folder');
    await tabFolderDialog.getByRole('button', { name: 'Save changes' }).click();
    await expect(tabFolderDialog).toHaveCount(0);
    await expect(sidepanelPage.locator('.bookmark-picker-popover')).toHaveCount(0);
    const responsiveTabFolderActions = sidepanelPage.getByRole('group', {
      name: 'Create items in Responsive tab folder',
    });
    const responsiveTabFolderButton = sidepanelPage.getByRole('button', {
      name: 'Responsive tab folder, 0 tabs',
      exact: true,
    });
    const responsiveTabFolderRow = sidepanelPage.locator('.tab-folder-row').filter({
      has: responsiveTabFolderButton,
    });
    await sidepanelPage.setViewportSize({ width: 600, height: 900 });
    await responsiveTabFolderButton.click();
    await expect(responsiveTabFolderButton).toHaveAttribute('aria-expanded', 'false');
    await responsiveTabFolderActions.getByRole('button', {
      name: 'Create subfolder in Responsive tab folder',
    }).click();
    const nestedTabFolderDialog = sidepanelPage.getByRole('dialog', {
      name: 'New tab folder',
    });
    await nestedTabFolderDialog.getByLabel('Title').fill('Nested responsive tab folder');
    await nestedTabFolderDialog.getByRole('button', { name: 'Save changes' }).click();
    await expect(sidepanelPage.getByRole('button', {
      name: 'Nested responsive tab folder, 0 tabs',
    })).toBeVisible();
    const [tabFolderItemBounds, tabFolderActionsBounds] = await Promise.all([
      responsiveTabFolderButton.boundingBox(),
      responsiveTabFolderActions.boundingBox(),
    ]);
    expect(tabFolderItemBounds).not.toBeNull();
    expect(tabFolderActionsBounds).not.toBeNull();
    expect(tabFolderActionsBounds!.x - (
      tabFolderItemBounds!.x + tabFolderItemBounds!.width
    )).toBeCloseTo(5, 0);
    const firstTabFolderAction = responsiveTabFolderActions.getByRole('button').first();
    await expect(firstTabFolderAction).toHaveCSS('border-top-width', '0px');
    await expect(firstTabFolderAction).toHaveCSS(
      'background-color',
      'rgba(0, 0, 0, 0)',
    );
    // Like its close button, a tab folder's create buttons show only while its row is hovered or focused.
    await sidepanelPage.mouse.move(0, 0);
    await sidepanelPage.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await expect(firstTabFolderAction).toHaveCSS('color', 'rgba(0, 0, 0, 0)');
    await responsiveTabFolderRow.hover();
    await expect(firstTabFolderAction).not.toHaveCSS('color', 'rgba(0, 0, 0, 0)');
    await responsiveTabFolderRow.hover();
    await expect(responsiveTabFolderRow.locator('.tab-folder-content')).toHaveCSS(
      'background-color',
      await paintedCustomProperty(
        responsiveTabFolderRow.locator('.tab-folder-content'),
        '--row-hover-background',
      ),
    );

    // The narrowest sidebar that shows the lists keeps the header and folder controls
    // apart and inside their rows.
    await sidepanelPage.setViewportSize({ width: 150, height: 900 });
    const rootButtons = tabsHeaderActions.getByRole('button');
    await expect(rootButtons).toHaveCount(2);
    await expectControlsNotToOverlap([rootButtons.nth(0), rootButtons.nth(1)]);
    const [toolbarBounds, rootButtonBounds] = await Promise.all([
      combinedToolbar.boundingBox(),
      rootButtons.evaluateAll((buttons) => buttons.map((button) => {
        const bounds = button.getBoundingClientRect();
        return { left: bounds.left, right: bounds.right };
      })),
    ]);
    expect(toolbarBounds).not.toBeNull();
    expect(rootButtonBounds.every((bounds) =>
      bounds.left >= toolbarBounds!.x &&
      bounds.right <= toolbarBounds!.x + toolbarBounds!.width)).toBe(true);
    const responsiveBookmarkFolderActions = sidepanelPage.getByRole('group', {
      name: 'Create items in Opening animation folder',
    });
    const responsiveBookmarkFolder = sidepanelPage.locator(
      `[data-bookmark-node-id="${fixture.openingFolderId}"] .folder-item`,
    );
    const closeFolder = sidepanelPage.getByRole('button', {
      name: 'Close tabs in Responsive tab folder',
    });
    await expect(responsiveBookmarkFolder).toHaveAttribute('aria-expanded', /true|false/);
    if (await responsiveBookmarkFolder.getAttribute('aria-expanded') === 'true') {
      await responsiveBookmarkFolder.click();
    }
    await expect(responsiveBookmarkFolder).toHaveAttribute('aria-expanded', 'false');
    await expect(responsiveTabFolderActions.getByRole('button')).toHaveCount(2);
    await expect(responsiveBookmarkFolderActions.getByRole('button')).toHaveCount(1);
    // The close button shows only while its row is hovered.
    await responsiveTabFolderRow.hover();
    await expect(closeFolder).toBeVisible();
    await expect(closeFolder).toHaveCSS('width', '20px');
    await expect(closeFolder).toHaveCSS('height', '20px');
    await expect(closeFolder).toHaveCSS('margin-right', '5px');
    await expectControlsNotToOverlap([
      responsiveTabFolderActions.getByRole('button').nth(0),
      responsiveTabFolderActions.getByRole('button').nth(1),
      closeFolder,
    ]);
  });
});

test('drops a bookmark into the folder below it on the first try', async () => {
  await withBookmarkFixture('folder-drop', async ({ context, fixture, worker }) => {
    const page = await openSidepanel(
      context, worker, { width: 720, height: 900 }, { waitUntil: 'domcontentloaded' },
    );
    const followingRow = page.locator(`[data-bookmark-node-id="${fixture.followingId}"]`);
    const folderRow = page.locator(`[data-bookmark-node-id="${fixture.finalFolderId}"]`);
    await expect(followingRow).toBeVisible();
    await expect(folderRow).toBeVisible();
    await waitForStableFolderTree(page, [fixture.finalFolderId], false);

    const dropOntoFolder = async (sourceId: string) => {
      const sourceRow = page.locator(`[data-bookmark-node-id="${sourceId}"]`);
      const sourceHandle = sourceRow.locator('.tree-item-main').first();
      const folderBefore = await folderRow.boundingBox();
      if (!folderBefore) throw new Error('Drag rows were not measurable');
      await pressAndPull(page, sourceHandle);
      // Picking the source up folds it away, so the folder rises toward its place.
      await expect(sourceRow).toHaveClass(/is-dragging/);
      await expect.poll(async () => (await folderRow.boundingBox())?.y)
        .toBeLessThan(folderBefore.y - 20);
      const folderBox = await folderRow.boundingBox();
      if (!folderBox) throw new Error('Folder drop target was not measurable');
      await page.mouse.move(folderBox.x + folderBox.width / 2, folderBox.y + folderBox.height / 2, {
        steps: 8,
      });
      await expect(folderRow).toHaveClass(/drop-inside/);
      await page.mouse.up();
      await expect.poll(() => bookmarkParentId(worker, sourceId)).toBe(fixture.finalFolderId);
    };

    await dropOntoFolder(fixture.followingId);
    // An open folder folds its children away too, moving the target much further.
    const closingFolder = page.locator(`[data-bookmark-node-id="${fixture.closingFolderId}"] .folder-item`);
    await expect(async () => {
      if (await closingFolder.getAttribute('aria-expanded') !== 'true') await closingFolder.click();
      await expect(closingFolder).toHaveAttribute('aria-expanded', 'true', { timeout: 1_000 });
    }).toPass();
    await expect(page.locator(`[data-bookmark-node-id="${fixture.closingChildIds[5]}"]`)).toBeVisible();
    await waitForStableFolderTree(page, [fixture.closingFolderId], true);
    // In a scrolled tree, folding the source away also moves the scroll position, which
    // used to place the drop above the folder the pointer was over.
    await page.setViewportSize({ width: 720, height: 420 });
    await page.locator('.bookmark-tree-stack').evaluate((element, closingId) => {
      const row = element.querySelector<HTMLElement>(`[data-bookmark-node-id="${closingId}"]`);
      if (!row) throw new Error('The open folder was not rendered');
      element.scrollTop += row.getBoundingClientRect().top - element.getBoundingClientRect().top - 8;
    }, fixture.closingFolderId);
    expect(await page.locator('.bookmark-tree-stack').evaluate((element) => element.scrollTop))
      .toBeGreaterThan(0);
    await dropOntoFolder(fixture.closingFolderId);
  });
});