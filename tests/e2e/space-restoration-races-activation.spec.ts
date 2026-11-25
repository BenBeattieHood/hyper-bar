import { expect, test, type BrowserContext, type Worker } from '@playwright/test';
import { resolve } from 'node:path';
import { waitForActivationQuiescence } from './fixtures/activation';
import { readActiveSpaceId } from './fixtures/activeSpace';
import { localBookmarksRootId } from './fixtures/localBookmarks';
import { reenableHyperExtension, reloadHyperExtension, withProfile } from './helpers/extension';
import {
  audibleUrl,
  bookmarkOnlyRecoveryUrl,
  createBookmarkOnlyBacking,
  firstSpaceRecoveryUrls,
  firstUrl,
  ownedTabCount,
  recoveryTargetCounts,
  recoveryUrls,
  restorationCounts,
  restorationState,
  secondSpaceRecoveryUrls,
  secondUrl,
  targetCounts,
} from './helpers/restoration';
import { dragBookmarkToScopeTarget, selectSpace, spaceDot, spaceDotById } from './helpers/sidebar';
import { createSecondSpace, createSecondSpaceAfterRecoveryTabs, createTwoSpacesWithTabs } from './helpers/spaces';
import {
  activateTab,
  browserTab,
  clearHyperRuntimeOwnership,
  closeWindow,
  createTab,
  currentWindowId,
  pageAtUrl,
  recordedTabLifecycle,
  resetRecordedTabLifecycle,
  tabOwnership,
  tabOwnershipSummary,
  transientCreatedTabs,
} from './helpers/tabs';
import type { ExtensionGlobal } from './helpers/extensionGlobal';
import { bookmarkParentId, callChrome } from './helpers/chrome';

async function tabObserverWorker(context: BrowserContext): Promise<Worker> {
  return context.serviceWorkers().find((candidate) =>
    candidate.url().endsWith('/observer.js')) ?? await context.waitForEvent(
    'serviceworker',
    { predicate: (candidate) => candidate.url().endsWith('/observer.js') },
  );
}

test('overlapping native and sidepanel space activation never duplicates tabs', () => withProfile('overlapping-space-activation', async (profile) => {
  test.setTimeout(45_000);
  const { page, worker } = await profile.launchHyper({ closeInitialPage: true });
  const { firstTabId, fixture, secondTabId } = await createTwoSpacesWithTabs(page, worker);

  const firstSpaceButton = spaceDot(page, 'Space 1');
  const secondSpaceButton = spaceDot(page, 'Second space');
  for (let iteration = 0; iteration < 4; iteration += 1) {
    await Promise.all([
      activateTab(worker, firstTabId),
      secondSpaceButton.dispatchEvent('click'),
    ]);
    await Promise.all([
      activateTab(worker, secondTabId),
      firstSpaceButton.dispatchEvent('click'),
    ]);
  }
  await selectSpace(page, 'Space 1');
  await expect.poll(() => restorationCounts(worker, fixture), { timeout: 20_000 }).toEqual({
    backings: {
      [fixture.firstSpaceId]: 1,
      [fixture.secondSpaceId]: 1,
    },
    tabs: { [firstUrl]: 1, [secondUrl]: 1 },
  });
}));

test('a stale group expansion event cannot reactivate the previous space', () => withProfile('stale-group-expansion', async (profile) => {
  const { page, worker } = await profile.launchHyper({ closeInitialPage: true });
  const { firstTabId, fixture } = await createTwoSpacesWithTabs(page, worker);
  await selectSpace(page, 'Space 1');

  const secondGroupId = await worker.evaluate(async ({ secondSpaceId, windowId }) => {
    const extension = globalThis as unknown as ExtensionGlobal;
    const key = `spaceGroupId:${windowId}:${secondSpaceId}`;
    const stored = await extension.chrome.storage.session.get(key);
    if (typeof stored[key] !== 'number') throw new Error('Second space group was not stored');
    return stored[key] as number;
  }, fixture);

  await worker.evaluate(async (groupId) => {
    const extension = globalThis as unknown as ExtensionGlobal;
    await extension.chrome.tabGroups.update(groupId, { collapsed: false });
    await extension.chrome.tabGroups.update(groupId, { collapsed: true });
  }, secondGroupId);

  await expect.poll(async () => {
    const [state, activeSpaceId] = await Promise.all([
      worker.evaluate(async ({ groupId, windowId }) => {
        const extension = globalThis as unknown as ExtensionGlobal;
        const [group, tabs] = await Promise.all([
          extension.chrome.tabGroups.get(groupId),
          extension.chrome.tabs.query({ active: true, windowId }),
        ]);
        return {
          activeTabId: tabs[0]?.id,
          collapsed: group.collapsed,
        };
      }, {
        groupId: secondGroupId,
        windowId: fixture.windowId,
      }),
      readActiveSpaceId(worker, fixture.windowId),
    ]);
    return {
      activeSpaceId,
      activeTabId: state.activeTabId,
      collapsed: state.collapsed,
    };
  }).toEqual({
    activeSpaceId: fixture.firstSpaceId,
    activeTabId: firstTabId,
    collapsed: true,
  });
}));

test('switching away from an audible space succeeds on the first attempt', () => withProfile('audible-space-switch', async (profile) => {
  const { context, page, worker } = await profile.launchHyper({ closeInitialPage: true, enableAudio: true });
  const audibleTabId = await createTab(worker, audibleUrl);
  await expect.poll(() => tabOwnershipSummary(worker, [audibleTabId]))
    .toEqual({ allOwned: true, spaceCount: 1 });
  const audiblePage = await pageAtUrl(context, audibleUrl);
  await audiblePage.locator('#start-audio').click();
  await expect.poll(async () => (await browserTab(worker, audibleTabId)).audible).toBe(true);

  const fixture = await createSecondSpace(worker);
  await selectSpace(page, 'Second space');
  const secondTabId = await createTab(worker, secondUrl);
  await expect.poll(() => tabOwnershipSummary(worker, [audibleTabId, secondTabId]))
    .toEqual({ allOwned: true, spaceCount: 2 });
  await selectSpace(page, 'Space 1');

  await worker.evaluate(({ windowId }) => {
    const runtime = globalThis as unknown as ExtensionGlobal & {
      hyperSpaceFocusEvents?: { tabIds: number[] };
    };
    const events = { tabIds: [] as number[] };
    runtime.hyperSpaceFocusEvents = events;
    runtime.chrome.tabs.onActivated.addListener((info) => {
      if (info.windowId === windowId) events.tabIds.push(info.tabId);
    });
  }, fixture);

  await selectSpace(page, 'Second space');
  const focusEvents = await worker.evaluate(() =>
    (globalThis as unknown as {
      hyperSpaceFocusEvents?: { tabIds: number[] };
    }).hyperSpaceFocusEvents,
  );
  await expect.poll(() => readActiveSpaceId(worker, fixture.windowId))
    .toBe(fixture.secondSpaceId);
  const destinationActivationIndex = focusEvents?.tabIds.indexOf(secondTabId) ?? -1;
  expect(destinationActivationIndex).toBeGreaterThanOrEqual(0);
  expect(focusEvents?.tabIds.slice(destinationActivationIndex + 1))
    .not.toContain(audibleTabId);
  await expect.poll(async () => {
    const [state, activeSpaceId] = await Promise.all([
      worker.evaluate(async ({ oldTabId, windowId }) => {
        const extension = globalThis as unknown as ExtensionGlobal;
        const [oldTab, activeTabs] = await Promise.all([
          extension.chrome.tabs.get(oldTabId),
          extension.chrome.tabs.query({ active: true, windowId }),
        ]);
        const oldGroup = await extension.chrome.tabGroups.get(oldTab.groupId);
        return {
          activeTabId: activeTabs[0]?.id,
          oldGroupCollapsed: oldGroup.collapsed,
          oldTabAudible: oldTab.audible,
        };
      }, {
        oldTabId: audibleTabId,
        windowId: fixture.windowId,
      }),
      readActiveSpaceId(worker, fixture.windowId),
    ]);
    return {
      activeSpaceId,
      activeTabId: state.activeTabId,
      oldGroupCollapsed: state.oldGroupCollapsed,
      oldTabAudible: state.oldTabAudible,
    };
  }).toEqual({
    activeSpaceId: fixture.secondSpaceId,
    activeTabId: secondTabId,
    oldGroupCollapsed: true,
    oldTabAudible: true,
  });
}));

test('a tab the browser replaces while its space is hidden is not reopened when the space returns', () => withProfile('replaced-tab-space-switch', async (profile) => {
  const { page, worker } = await profile.launchHyper({ closeInitialPage: true, headless: false });
  const { firstTabId, fixture } = await createTwoSpacesWithTabs(page, worker);
  // Playwright loses the service worker once a tab is discarded, so the sidebar page calls the browser from here on.
  const extension = page as unknown as Worker;
  // Discarding, as Edge's sleeping tabs do, swaps the tab for a new one under a new ID.
  const replacedTabId = (await callChrome<{ id: number }>(extension, 'tabs.discard', firstTabId)).id;
  expect(replacedTabId).not.toBe(firstTabId);
  // The page then moves on, as a music player does to its next song.
  const movedOnUrl = `${firstUrl}?song=2`;
  await callChrome(extension, 'tabs.update', replacedTabId, { url: movedOnUrl });
  await expect.poll(async () => ((await tabOwnership(extension, [replacedTabId]))[0] as { url?: string } | undefined)?.url)
    .toBe(movedOnUrl);

  await selectSpace(page, 'Space 1');
  await expect.poll(() => restorationCounts(
    extension,
    fixture,
    (state) => recoveryTargetCounts(state, [firstUrl, movedOnUrl, secondUrl]),
  ), { timeout: 20_000 }).toEqual({
    backings: { [fixture.firstSpaceId]: 1, [fixture.secondSpaceId]: 1 },
    tabs: { [firstUrl]: 0, [movedOnUrl]: 1, [secondUrl]: 1 },
  });
  expect((await tabOwnership(extension, [firstTabId]))[0]).toBeUndefined();
}));

test('extension activation never creates transient tabs around populated groups', () => withProfile('extension-reload', async (profile) => {
  test.setTimeout(75_000);
  const observerExtensionPath = resolve('tests/e2e/fixtures/tab-observer');
  const launched = await profile.launchHyper({ closeInitialPage: true, extraExtensionPaths: [observerExtensionPath] });
  let context = launched.context;
  let sidepanelPage = launched.page;
  let worker = launched.worker;
  const observerWorker = await tabObserverWorker(context);
  await expect(sidepanelPage.locator('.space-pagination-dot')).toHaveCount(1);

  const fixture = await createSecondSpaceAfterRecoveryTabs(worker);

  await selectSpace(sidepanelPage, 'Second space');
  for (const url of secondSpaceRecoveryUrls) await createTab(worker, url);
  const expectedCounts = Object.fromEntries(recoveryUrls.map((url) => [url, 1]));
  const expectedBackings = {
    [fixture.firstSpaceId]: firstSpaceRecoveryUrls.length,
    [fixture.secondSpaceId]: secondSpaceRecoveryUrls.length,
  };
  await expect.poll(async () => {
    const state = await restorationState(worker, fixture);
    return {
      backings: state.backingsBySpace,
      ownedSecondSpaceTabs: ownedTabCount(state, secondSpaceRecoveryUrls, fixture.secondSpaceId),
      tabs: recoveryTargetCounts(state),
    };
  }, { timeout: 30_000 }).toEqual({
    backings: expectedBackings,
    ownedSecondSpaceTabs: secondSpaceRecoveryUrls.length,
    tabs: expectedCounts,
  });
  const groupedTabIds = new Set((await restorationState(worker, fixture)).tabs.flatMap((tab) =>
    tab.id !== undefined && tab.groupId >= 0 && recoveryUrls.includes(
      (tab.pendingUrl ?? tab.url) as typeof recoveryUrls[number],
    ) ? [tab.id] : [],
  ));
  const expectRecovered = () => expect.poll(
    () => restorationCounts(worker, fixture, recoveryTargetCounts),
    { timeout: 20_000 },
  ).toEqual({ backings: expectedBackings, tabs: expectedCounts });
  const expectRecoveredWithoutTransientTabs = async () => {
    await expectRecovered();
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const lifecycle = await recordedTabLifecycle(observerWorker);
    expect(transientCreatedTabs(lifecycle)).toEqual([]);
    expect(lifecycle.updated.filter((event) =>
      event.groupId === -1 && groupedTabIds.has(event.id))).toEqual([]);
  };

  for (let iteration = 0; iteration < 3; iteration += 1) {
    await resetRecordedTabLifecycle(observerWorker);
    ({ page: sidepanelPage, worker } = await reloadHyperExtension(context, worker));
    await expect(sidepanelPage.locator('.space-pagination-dot')).toHaveCount(2);
    await expectRecoveredWithoutTransientTabs();
  }

  await clearHyperRuntimeOwnership(worker);
  await sidepanelPage.close();
  await resetRecordedTabLifecycle(observerWorker);
  ({ page: sidepanelPage, worker } = await reenableHyperExtension(context, worker));
  await expect(sidepanelPage.locator('.space-pagination-dot')).toHaveCount(2);
  await expectRecoveredWithoutTransientTabs();

  await context.close();
  const restarted = await profile.launchHyper({ restoreLastSession: true, extraExtensionPaths: [observerExtensionPath] });
  context = restarted.context;
  worker = restarted.worker;
  sidepanelPage = restarted.page;
  fixture.windowId = await currentWindowId(worker);
  const restartedObserverWorker = await tabObserverWorker(context);
  await expect(sidepanelPage.locator('.space-pagination-dot')).toHaveCount(2);
  await expectRecovered();
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  expect(transientCreatedTabs(await recordedTabLifecycle(restartedObserverWorker)))
    .toEqual([]);
}));

test('concurrent sidepanels converge without duplicating space tabs', () => withProfile('concurrent-panels', async (profile) => {
  test.setTimeout(45_000);
  const launched = await profile.launchHyper({ closeInitialPage: true });
  const { context } = launched;
  const firstPanel = launched.page;
  const worker = launched.worker;
  const firstTabId = await createTab(worker, firstUrl);
  const fixture = await createSecondSpace(worker);
  await expect.poll(() => tabOwnershipSummary(worker, [firstTabId]))
    .toEqual({ allOwned: true, spaceCount: 1 });
  await selectSpace(firstPanel, 'Second space');
  await expect.poll(() => readActiveSpaceId(worker, fixture.windowId))
    .toBe(fixture.secondSpaceId);
  const secondTabId = await createTab(worker, secondUrl);
  await expect.poll(() => tabOwnershipSummary(worker, [firstTabId, secondTabId]))
    .toEqual({ allOwned: true, spaceCount: 2 });

  const secondPanel = await context.newPage();
  await secondPanel.goto(firstPanel.url());
  await expect(secondPanel.locator('.space-pagination-dot')).toHaveCount(2);

  await Promise.all([
    spaceDot(firstPanel, 'Space 1')
      .evaluate((element: HTMLElement) => element.click()),
    spaceDot(secondPanel, 'Second space')
      .evaluate((element: HTMLElement) => element.click()),
  ]);

  await expect.poll(async () => {
    const [firstActive, secondActive, state] = await Promise.all([
      firstPanel.locator('.space-pagination-dot[aria-current="page"]')
        .getAttribute('aria-label'),
      secondPanel.locator('.space-pagination-dot[aria-current="page"]')
        .getAttribute('aria-label'),
      restorationState(worker, fixture),
    ]);
    return {
      backings: state.backingsBySpace,
      panelsAgree: Boolean(firstActive && firstActive === secondActive),
      tabs: targetCounts(state),
    };
  }, { timeout: 20_000 }).toEqual({
    backings: {
      [fixture.firstSpaceId]: 1,
      [fixture.secondSpaceId]: 1,
    },
    panelsAgree: true,
    tabs: { [firstUrl]: 1, [secondUrl]: 1 },
  });
}));

test('space, window, and folder-scope races do not create or close unrelated tabs', () => withProfile('mixed-space-races', async (profile) => {
  test.setTimeout(75_000);
  const { page, worker } = await profile.launchHyper({ closeInitialPage: true });
  const firstMovingTabId = await createTab(worker, firstUrl);
  const firstStableTabId = await createTab(worker, firstSpaceRecoveryUrls[1]);
  await expect.poll(() => tabOwnershipSummary(worker, [
    firstMovingTabId,
    firstStableTabId,
  ])).toEqual({ allOwned: true, spaceCount: 1 });
  const fixture = await createSecondSpace(worker);
  await selectSpace(page, 'Second space');
  const secondMovingTabId = await createTab(worker, secondUrl);
  const secondStableTabId = await createTab(worker, secondSpaceRecoveryUrls[1]);
  await expect.poll(() => tabOwnershipSummary(worker, [
    firstMovingTabId,
    firstStableTabId,
    secondMovingTabId,
    secondStableTabId,
  ])).toEqual({ allOwned: true, spaceCount: 2 });
  await selectSpace(page, 'Space 1');

  const firstSpaceBookmarksId = await localBookmarksRootId(worker, fixture.firstSpaceId);
  const secondSpaceBookmarksId = await localBookmarksRootId(worker, fixture.secondSpaceId);
  const scopeFolder = await worker.evaluate(async (parentId) => {
    const extension = globalThis as unknown as ExtensionGlobal;
    const folder = await extension.chrome.bookmarks.create({
      parentId,
      title: 'Scope race folder',
    });
    return { folderId: folder.id };
  }, firstSpaceBookmarksId);
  const folder = page.locator(`[data-bookmark-node-id="${scopeFolder.folderId}"]`);
  const folderItem = folder.locator('.folder-item');
  await expect(folder).toBeVisible();

  const secondWindow = await worker.evaluate(async () => {
    const extension = globalThis as unknown as ExtensionGlobal;
    const window = await extension.chrome.windows.create({
      focused: false,
      url: 'about:blank',
    });
    if (window?.id === undefined) throw new Error('Chrome did not create a second window.');
    const [blankTab] = await extension.chrome.tabs.query({ windowId: window.id });
    if (blankTab?.id === undefined) throw new Error('The second window has no tab.');
    await extension.chrome.tabs.update(blankTab.id, { pinned: true });
    return { id: window.id };
  });

  await expect.poll(async () => {
    const state = await restorationState(worker, fixture);
    return {
      backings: state.backingsBySpace,
      tabs: recoveryTargetCounts(state, [
        firstUrl,
        firstSpaceRecoveryUrls[1],
        secondUrl,
        secondSpaceRecoveryUrls[1],
      ]),
    };
  }).toEqual({
    backings: {
      [fixture.firstSpaceId]: 2,
      [fixture.secondSpaceId]: 2,
    },
    tabs: {
      [firstUrl]: 1,
      [firstSpaceRecoveryUrls[1]]: 1,
      [secondUrl]: 1,
      [secondSpaceRecoveryUrls[1]]: 1,
    },
  });

  await worker.evaluate(() => {
    const runtime = globalThis as unknown as ExtensionGlobal & {
      hyperMixedRaceEvents?: { created: number[]; removed: number[] };
    };
    runtime.hyperMixedRaceEvents = { created: [], removed: [] };
    runtime.chrome.tabs.onCreated.addListener((tab) => {
      if (tab.id !== undefined) runtime.hyperMixedRaceEvents?.created.push(tab.id);
    });
    runtime.chrome.tabs.onRemoved.addListener((tabId) => {
      runtime.hyperMixedRaceEvents?.removed.push(tabId);
    });
  });

  const moveTab = (windowId: number) => worker.evaluate(async ({ tabId, targetWindowId }) => {
    const extension = globalThis as unknown as ExtensionGlobal;
    await extension.chrome.tabs.move(tabId, { index: -1, windowId: targetWindowId });
  }, { tabId: firstMovingTabId, targetWindowId: windowId });
  const clickSpace = (title: string) => spaceDot(page, title)
    .evaluate((element: HTMLElement) => element.click());

  const spaceTarget = (spaceId: string) =>
    spaceDotById(page, spaceId);
  const folderParentId = () => bookmarkParentId(worker, scopeFolder.folderId);

  for (let iteration = 0; iteration < 3; iteration += 1) {
    await selectSpace(page, 'Space 1');
    await dragBookmarkToScopeTarget(
      page,
      folderItem,
      spaceTarget(fixture.secondSpaceId),
    );
    await Promise.all([
      clickSpace('Second space'),
      moveTab(secondWindow.id),
    ]);
    await Promise.all([
      clickSpace('Space 1'),
      moveTab(fixture.windowId),
    ]);
    await selectSpace(page, 'Space 1');
    await expect.poll(folderParentId).toBe(secondSpaceBookmarksId);

    await selectSpace(page, 'Second space');
    await dragBookmarkToScopeTarget(
      page,
      folderItem,
      spaceTarget(fixture.firstSpaceId),
    );
    // Each race starts from Space 1, like the first half; dnd-kit swallows clicks just after a drop.
    await expect.poll(folderParentId).toBe(firstSpaceBookmarksId);
    await page.waitForTimeout(100);
    await selectSpace(page, 'Space 1');
    await waitForActivationQuiescence(page);
    await Promise.all([
      clickSpace('Second space'),
      moveTab(secondWindow.id),
    ]);
    await Promise.all([
      clickSpace('Space 1'),
      moveTab(fixture.windowId),
    ]);
    // Browser events from the racing moves may land after the clicks resolve.
    await waitForActivationQuiescence(page);
    await selectSpace(page, 'Space 1');
    await expect.poll(folderParentId).toBe(firstSpaceBookmarksId);
  }

  // The moving tab joins whichever space its window shows when it lands, which these racing
  // clicks leave open; every other tab keeps its space, and nothing is created or closed.
  await expect.poll(async () => {
    const state = await restorationState(worker, fixture);
    const first = state.backingsBySpace[fixture.firstSpaceId] ?? 0;
    const second = state.backingsBySpace[fixture.secondSpaceId] ?? 0;
    return {
      movingTabInOneSpace: (first === 2 && second === 2) || (first === 1 && second === 3),
      events: await worker.evaluate(() =>
        (globalThis as unknown as {
          hyperMixedRaceEvents?: { created: number[]; removed: number[] };
        }).hyperMixedRaceEvents),
      stableTabsKeepTheirSpaces:
        (await tabOwnershipSummary(worker, [firstStableTabId, secondStableTabId])).spaceCount === 2 &&
        (await tabOwnershipSummary(worker, [secondStableTabId, secondMovingTabId])).spaceCount === 1,
      tabs: recoveryTargetCounts(state, [
        firstUrl,
        firstSpaceRecoveryUrls[1],
        secondUrl,
        secondSpaceRecoveryUrls[1],
      ]),
    };
  }, { timeout: 20_000 }).toEqual({
    events: { created: [], removed: [] },
    movingTabInOneSpace: true,
    stableTabsKeepTheirSpaces: true,
    tabs: {
      [firstUrl]: 1,
      [firstSpaceRecoveryUrls[1]]: 1,
      [secondUrl]: 1,
      [secondSpaceRecoveryUrls[1]]: 1,
    },
  });

  await closeWindow(worker, secondWindow.id);
}));

test('a superseded sidebar restore does not open tabs after another space is selected', () => withProfile('cancelled-space-restore', async (profile) => {
  test.setTimeout(45_000);
  const { page, worker } = await profile.launchHyper({ closeInitialPage: true });
  const { fixture } = await createTwoSpacesWithTabs(page, worker);
  await createBookmarkOnlyBacking(worker, firstUrl, bookmarkOnlyRecoveryUrl);
  await expect.poll(async () => recoveryTargetCounts(
    await restorationState(worker, fixture),
    [bookmarkOnlyRecoveryUrl],
  )).toEqual({ [bookmarkOnlyRecoveryUrl]: 0 });
  const firstSpaceButton = spaceDot(page, 'Space 1');
  const secondSpaceButton = spaceDot(page, 'Second space');
  await firstSpaceButton.dispatchEvent('click');
  await secondSpaceButton.dispatchEvent('click');
  await expect(secondSpaceButton).toHaveAttribute('aria-current', 'page');
  await waitForActivationQuiescence(page);

  await expect.poll(async () => recoveryTargetCounts(
    await restorationState(worker, fixture),
    [bookmarkOnlyRecoveryUrl],
  ), { timeout: 10_000 }).toEqual({ [bookmarkOnlyRecoveryUrl]: 0 });
}));
