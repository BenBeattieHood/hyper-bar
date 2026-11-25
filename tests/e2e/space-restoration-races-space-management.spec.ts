import { expect, test } from '@playwright/test';
import { localBookmarksRootId, localBookmarksRootIds } from './fixtures/localBookmarks';
import { saveHyperPreference } from './fixtures/preferences';
import { firstUrl, restorationState, secondUrl } from './helpers/restoration';
import { dragSpaceToPaginationTarget, selectSpace, spaceDot } from './helpers/sidebar';
import {
  createExtraSpaces,
  createSecondSpace,
  moveSpaceGroupBefore,
  spaceAndGroupOrder,
  spaceIdByTitle,
} from './helpers/spaces';
import { createTab, currentWindowId, tabOwnershipSummary } from './helpers/tabs';
import type { ExtensionGlobal } from './helpers/extensionGlobal';
import { allBookmarks, bookmarkDescendants } from './helpers/chrome';
import { withProfile } from './helpers/extension';

test('keeps a named new space on its default tab', () => withProfile('new-space-tab', async (profile) => {
  const { page, worker } = await profile.launchHyper({ closeInitialPage: true });
  await expect(page.locator('.space-pagination-dot')).toHaveCount(1);
  const existingTabIds = [
    await createTab(worker, firstUrl),
    await createTab(worker, secondUrl),
  ];
  await expect.poll(() => tabOwnershipSummary(worker, existingTabIds))
    .toEqual({ allOwned: true, spaceCount: 1 });

  await page.getByRole('button', { name: 'Add space' }).click();
  const editor = page.getByRole('dialog', { name: 'New space' });
  await editor.getByLabel('Title').fill('Focused space');
  await editor.getByRole('button', { name: 'Save changes' }).click();
  await expect(editor).toHaveCount(0);
  await expect(spaceDot(page, 'Focused space')).toHaveAttribute('aria-current', 'page');

  const firstSpaceId = await spaceIdByTitle(worker, 'Space 1');
  const newSpaceId = await spaceIdByTitle(worker, 'Focused space');
  const windowId = await currentWindowId(worker);
  expect(firstSpaceId).toBeDefined();
  expect(newSpaceId).toBeDefined();
  await expect.poll(async () => {
    const state = await restorationState(worker, {
      firstSpaceId: firstSpaceId as string,
      secondSpaceId: newSpaceId as string,
      windowId,
    });
    const activeTab = state.tabs.find((tab) => tab.active);
    return {
      activeIsNew: activeTab?.id !== undefined && !existingTabIds.includes(activeTab.id),
      activeSpaceId: activeTab?.ownership?.spaceId,
      grouped: (activeTab?.groupId ?? -1) >= 0,
    };
  }).toEqual({
    activeIsNew: true,
    activeSpaceId: newSpaceId,
    grouped: true,
  });
}));

test('a new space takes the focused new tab page rather than opening another', () => withProfile('new-space-takes-tab', async (profile) => {
  const { page, worker } = await profile.launchHyper({ closeInitialPage: true });
  const webTabId = await createTab(worker, firstUrl);
  await expect.poll(() => tabOwnershipSummary(worker, [webTabId]))
    .toEqual({ allOwned: true, spaceCount: 1 });
  const newTabId = await worker.evaluate(async () => {
    const extension = globalThis as unknown as ExtensionGlobal;
    const tab = await extension.chrome.tabs.create({ active: true });
    if (tab.id === undefined) throw new Error('Chrome did not create the new tab');
    return tab.id;
  });
  await expect.poll(() => tabOwnershipSummary(worker, [webTabId, newTabId]))
    .toEqual({ allOwned: true, spaceCount: 1 });
  const windowId = await currentWindowId(worker);
  const tabIdsInWindow = () => worker.evaluate(async (targetWindowId) => {
    const extension = globalThis as unknown as ExtensionGlobal;
    return (await extension.chrome.tabs.query({ windowId: targetWindowId }))
      .map((tab) => tab.id).sort();
  }, windowId);
  const tabIdsBefore = await tabIdsInWindow();

  await page.getByRole('button', { name: 'Add space' }).click();
  const editor = page.getByRole('dialog', { name: 'New space' });
  await editor.getByLabel('Title').fill('Taken space');
  await editor.getByRole('button', { name: 'Save changes' }).click();
  await expect(editor).toHaveCount(0);

  const firstSpaceId = await spaceIdByTitle(worker, 'Space 1') as string;
  const newSpaceId = await spaceIdByTitle(worker, 'Taken space') as string;
  await expect.poll(async () => {
    const state = await restorationState(worker, {
      firstSpaceId,
      secondSpaceId: newSpaceId,
      windowId,
    });
    const activeTab = state.tabs.find((tab) => tab.active);
    return {
      activeSpaceId: activeTab?.ownership?.spaceId,
      activeTabId: activeTab?.id,
      grouped: (activeTab?.groupId ?? -1) >= 0,
      webTabSpaceId: state.tabs.find((tab) => tab.id === webTabId)?.ownership?.spaceId,
    };
  }).toEqual({
    activeSpaceId: newSpaceId,
    activeTabId: newTabId,
    grouped: true,
    webTabSpaceId: firstSpaceId,
  });
  expect(await tabIdsInWindow()).toEqual(tabIdsBefore);
}));

test('keeps pagination and native tab-group ordering synchronized', () => withProfile('space-group-order', async (profile) => {
  test.setTimeout(45_000);
  const { page, worker } = await profile.launchHyper({ closeInitialPage: true });
  const firstTabId = await createTab(worker, firstUrl);
  await expect.poll(() => tabOwnershipSummary(worker, [firstTabId]))
    .toEqual({ allOwned: true, spaceCount: 1 });
  const fixture = await createSecondSpace(worker);
  await expect(page.locator('.space-pagination-dot')).toHaveCount(2);
  await selectSpace(page, 'Second space');
  const secondTabId = await createTab(worker, secondUrl);
  await expect.poll(() => tabOwnershipSummary(worker, [firstTabId, secondTabId]))
    .toEqual({ allOwned: true, spaceCount: 2 });
  await worker.evaluate(async (localRootId) => {
    const extension = globalThis as unknown as ExtensionGlobal;
    const folder = await extension.chrome.bookmarks.create({
      parentId: localRootId,
      title: 'Deleted space folder',
    });
    await extension.chrome.bookmarks.create({
      parentId: folder.id,
      title: 'Deleted space nested bookmark',
      url: 'https://space-race.test/deleted-space-bookmark',
    });
  }, await localBookmarksRootId(worker, fixture.secondSpaceId));
  await selectSpace(page, 'Space 1');
  await expect.poll(() => spaceAndGroupOrder(worker, fixture)).toEqual({
    groupSpaceIds: [fixture.firstSpaceId, fixture.secondSpaceId],
    spaceIds: [fixture.firstSpaceId, fixture.secondSpaceId],
  });

  const trackedSpaceIds = [fixture.firstSpaceId, fixture.secondSpaceId];
  const localRootsBeforeReorder = await localBookmarksRootIds(worker, trackedSpaceIds);
  expect(Object.values(localRootsBeforeReorder).every(Boolean)).toBe(true);
  await moveSpaceGroupBefore(
    worker,
    fixture,
    fixture.secondSpaceId,
    fixture.firstSpaceId,
  );
  await expect.poll(() => spaceAndGroupOrder(worker, fixture)).toEqual({
    groupSpaceIds: [fixture.secondSpaceId, fixture.firstSpaceId],
    spaceIds: [fixture.secondSpaceId, fixture.firstSpaceId],
  });
  // Reorder must move each space folder, not the local root nested inside it.
  expect(await localBookmarksRootIds(worker, trackedSpaceIds))
    .toEqual(localRootsBeforeReorder);

  await dragSpaceToPaginationTarget(
    page,
    'Second space',
    '.space-pagination-dot[aria-label="Open Space 1"]',
  );

  await expect.poll(() => spaceAndGroupOrder(worker, fixture)).toEqual({
    groupSpaceIds: [fixture.firstSpaceId, fixture.secondSpaceId],
    spaceIds: [fixture.firstSpaceId, fixture.secondSpaceId],
  });
  const deletedSpace = (await allBookmarks(worker))
    .find((node) => node.id === fixture.secondSpaceId);
  if (!deletedSpace) throw new Error('The deleted space was not found before deletion.');
  const deletedSpaceResources = await worker.evaluate(async ({ deletedNodeIds, tabId }) => {
    const extension = globalThis as unknown as ExtensionGlobal;
    const tab = await extension.chrome.tabs.get(tabId);
    const group = await extension.chrome.tabGroups.get(tab.groupId);
    return {
      deletedGroupId: group.id,
      deletedNodeIds,
      deletedTabId: tabId,
      windowId: tab.windowId,
    };
  }, {
    deletedNodeIds: bookmarkDescendants([deletedSpace]).map((node) => node.id),
    tabId: secondTabId,
  });

  await dragSpaceToPaginationTarget(
    page,
    'Second space',
    '.space-pagination-trash-target',
  );
  // The space holds a bookmark, so deleting it first asks whether to keep it.
  const deletePrompt = page.getByRole('alertdialog', { name: 'Delete Second space' });
  await expect(deletePrompt)
    .toContainText('Second space has 1 bookmark. Move it to your default space?');
  await deletePrompt.getByRole('button', { name: 'Skip' }).click();
  await expect.poll(async () => {
    const bookmarkIds = new Set((await allBookmarks(worker)).map((node) => node.id));
    return {
      ...await worker.evaluate(async ({ deletedGroupId, deletedTabId, windowId }) => {
        const extension = globalThis as unknown as ExtensionGlobal;
        const [groups, tabs] = await Promise.all([
          extension.chrome.tabGroups.query({ windowId }),
          extension.chrome.tabs.query({}),
        ]);
        return {
          deletedGroupPresent: groups.some((group) => group.id === deletedGroupId),
          deletedTabPresent: tabs.some((tab) => tab.id === deletedTabId),
        };
      }, deletedSpaceResources),
      deletedNodesPresent: deletedSpaceResources.deletedNodeIds
        .some((nodeId) => bookmarkIds.has(nodeId)),
    };
  }).toEqual({
    deletedGroupPresent: false,
    deletedNodesPresent: false,
    deletedTabPresent: false,
  });
  await expect.poll(() => spaceIdByTitle(worker, 'Second space')).toBeUndefined();
  await expect(page.locator('.space-pagination-dot')).toHaveCount(1);
}));

test('asks before deleting a space with bookmarks, then keeps the space or its bookmarks', () => withProfile('space-delete-prompt', async (profile) => {
  const { page, worker } = await profile.launchHyper({ closeInitialPage: true });
  await saveHyperPreference(worker, 'combineTabsAndBookmarks', false);
  await page.setViewportSize({ width: 420, height: 800 });
  const firstTabId = await createTab(worker, firstUrl);
  await expect.poll(() => tabOwnershipSummary(worker, [firstTabId]))
    .toEqual({ allOwned: true, spaceCount: 1 });
  const fixture = await createSecondSpace(worker);
  await createExtraSpaces(worker, 1);
  await expect(page.locator('.space-pagination-dot')).toHaveCount(3);

  // A space with no bookmarks goes without asking.
  await dragSpaceToPaginationTarget(page, 'Overflow space 1', '.space-pagination-trash-target');
  await expect(page.locator('.space-pagination-dot')).toHaveCount(2);
  await expect(page.getByRole('alertdialog')).toHaveCount(0);

  const [firstRootId, secondRootId] = await Promise.all([
    localBookmarksRootId(worker, fixture.firstSpaceId),
    localBookmarksRootId(worker, fixture.secondSpaceId),
  ]);
  const keptIds = await worker.evaluate(async (roots) => {
    const extension = globalThis as unknown as ExtensionGlobal;
    const { create } = extension.chrome.bookmarks;
    await create({ parentId: roots.firstRootId, title: 'Second space' });
    const page = await create({
      parentId: roots.secondRootId,
      title: 'Kept page',
      url: 'https://space-race.test/kept',
    });
    const folder = await create({ parentId: roots.secondRootId, title: 'Kept folder' });
    await create({
      parentId: folder.id,
      title: 'Kept nested page',
      url: 'https://space-race.test/kept-nested',
    });
    return [page.id, folder.id];
  }, { firstRootId, secondRootId });

  // Cancel keeps the space and opens it on the bookmarks it would have lost.
  await dragSpaceToPaginationTarget(page, 'Second space', '.space-pagination-trash-target');
  const prompt = page.getByRole('alertdialog', { name: 'Delete Second space' });
  await expect(prompt)
    .toContainText('Second space has 2 bookmarks. Move these to your default space?');
  await expect(prompt.getByRole('button', { name: 'Move' })).toBeFocused();
  await prompt.getByRole('button', { name: 'Cancel' }).click();
  await expect(prompt).toHaveCount(0);
  await expect(spaceDot(page, 'Second space'))
    .toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('tab', { name: 'Bookmarks' }))
    .toHaveAttribute('aria-selected', 'true');
  await expect(page.locator(`[data-bookmark-node-id="${keptIds[0]}"]`)).toBeVisible();
  await expect(page.locator('.space-pagination-dot')).toHaveCount(2);

  // Move gathers them in a folder named for the space, numbered past one already there.
  await dragSpaceToPaginationTarget(page, 'Second space', '.space-pagination-trash-target');
  await prompt.getByRole('button', { name: 'Move' }).click();
  await expect.poll(() => worker.evaluate(async ({ rootId, spaceId }) => {
    const extension = globalThis as unknown as ExtensionGlobal;
    const { get, getChildren } = extension.chrome.bookmarks;
    const topLevel = await getChildren(rootId);
    const moved = topLevel.at(-1);
    return {
      movedIds: moved ? (await getChildren(moved.id)).map((node) => node.id) : [],
      spaceRemoved: await get(spaceId).then(() => false, () => true),
      topLevel: topLevel.map((node) => node.title),
    };
  }, { rootId: firstRootId, spaceId: fixture.secondSpaceId })).toEqual({
    movedIds: keptIds,
    spaceRemoved: true,
    topLevel: ['Second space', 'Second space 2'],
  });
  await expect(page.locator('.space-pagination-dot')).toHaveCount(1);
}));

test('keeps overflowed pagination compact while reordering spaces', () => withProfile('space-autoscroll', async (profile) => {
  const { page, worker } = await profile.launchHyper({ closeInitialPage: true });
  await page.setViewportSize({ width: 300, height: 760 });
  await createExtraSpaces(worker, 8);
  await expect(page.locator('.space-pagination-dot')).toHaveCount(9);
  const source = page.locator('.space-pagination-dot').first();
  const sourceTitle = (await source.getAttribute('aria-label'))?.replace(/^Open /, '');
  expect(sourceTitle).toBeTruthy();
  const sourceBounds = await source.boundingBox();
  const sourceVisual = source.locator('.space-pagination-dot-visual');
  const sourceVisualBounds = await sourceVisual.boundingBox();
  const paginationBounds = await page.locator('.space-pagination').boundingBox();
  expect(sourceBounds).not.toBeNull();
  expect(sourceVisualBounds).not.toBeNull();
  expect(paginationBounds).not.toBeNull();
  expect(sourceBounds!.y).toBeCloseTo(paginationBounds!.y + 1, 1);
  expect(sourceBounds!.y + sourceBounds!.height)
    .toBeCloseTo(paginationBounds!.y + paginationBounds!.height, 1);
  await page.mouse.move(
    sourceBounds!.x + sourceBounds!.width / 2,
    sourceBounds!.y + 1,
  );
  await page.mouse.down();
  await page.mouse.move(
    sourceBounds!.x + sourceBounds!.width / 2 + 12,
    sourceBounds!.y + 1,
    { steps: 3 },
  );
  const list = page.locator('.space-pagination-items');
  await expect(list).toBeVisible();
  await expect(list).toHaveClass(/is-dot-mode/);
  await expect(page.locator('.space-drop-tray')).toHaveCount(0);
  await expect(page.locator('.space-pagination-trash-target')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add space' })).toHaveCount(0);
  const compactOverlay = page.locator('.space-drag-overlay.is-dot-mode');
  await expect(compactOverlay).toBeVisible();
  const compactOverlayBounds = await compactOverlay.boundingBox();
  expect(compactOverlayBounds).not.toBeNull();
  expect(compactOverlayBounds!.width).toBeCloseTo(sourceVisualBounds!.width, 1);
  expect(compactOverlayBounds!.height).toBeCloseTo(sourceVisualBounds!.height, 1);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Add space' })).toBeVisible();
  await expect(page.locator('.space-pagination-trash-target')).toHaveCount(0);

  const bottomBounds = await source.boundingBox();
  expect(bottomBounds).not.toBeNull();
  await page.mouse.move(
    bottomBounds!.x + bottomBounds!.width / 2,
    bottomBounds!.y + bottomBounds!.height - 1,
  );
  await page.mouse.down();
  await page.mouse.move(
    bottomBounds!.x + bottomBounds!.width / 2 + 12,
    bottomBounds!.y + bottomBounds!.height - 1,
    { steps: 3 },
  );
  await expect(page.locator('.space-drag-overlay.is-dot-mode')).toBeVisible();
  await page.keyboard.press('Escape');
}));
