import {
  expect,
  test,
  type Worker,
} from '@playwright/test';
import { isBlankTabPage } from '../../entrypoints/lib/tabs';
import { callChrome } from './helpers/chrome';
import { waitForActivationQuiescence } from './fixtures/activation';
import {
  extensionBaseUrl,
  reenableHyperExtension,
  reloadHyperExtension,
  withProfile,
} from './helpers/extension';
import {
  bookmarkOnlyRecoveryUrl,
  createBookmarkOnlyBacking,
  expectActiveTabInSpace,
  firstSpaceRecoveryUrls,
  firstUrl,
  nativeTabBackingState,
  ownedTabCount,
  recoveryTabSignature,
  recoveryTargetCounts,
  recoveryUrls,
  restorationState,
  secondSpaceRecoveryUrls,
} from './helpers/restoration';
import { selectSpace, spaceDot } from './helpers/sidebar';
import { createSecondSpace, createSecondSpaceAfterRecoveryTabs } from './helpers/spaces';
import {
  closeWindow,
  createTab,
  currentWindowId,
  pageAtUrl,
  pageTabWindows,
  tabBackingToken,
  tabUrl,
  waitForNewPage,
} from './helpers/tabs';
import type { ExtensionGlobal } from './helpers/extensionGlobal';

test('disposes new tabs when leaving a space and restarting the browser', () => withProfile('disposable-new-tabs', async (profile) => {
  test.setTimeout(45_000);
  const launched = await profile.launchHyper({ closeInitialPage: true });
  let context = launched.context;
  let { page, worker } = launched;
  await expect(page.locator('.space-pagination-dot')).toHaveCount(1);
  const firstTabId = await createTab(worker, firstUrl);
  await expect.poll(() => tabBackingToken(worker, firstTabId)).not.toBeUndefined();
  let fixture = await createSecondSpace(worker);
  const hyperNewTabUrl = `${extensionBaseUrl(worker)}/newtab.html`;

  await selectSpace(page, 'Second space');
  let firstNewTabId: number | undefined;
  await expect.poll(async () => {
    const state = await restorationState(worker, fixture);
    const newTab = state.tabs.find((tab) =>
      tab.ownership?.spaceId === fixture.secondSpaceId &&
      isBlankTabPage(tab.pendingUrl ?? tab.url, hyperNewTabUrl));
    firstNewTabId = newTab?.id;
    return {
      backingCount: state.backingsBySpace[fixture.secondSpaceId],
      found: firstNewTabId !== undefined,
    };
  }).toEqual({ backingCount: 0, found: true });

  await selectSpace(page, 'Space 1');
  await expect.poll(() => worker.evaluate(async (tabId) => {
    const extension = globalThis as unknown as ExtensionGlobal;
    return extension.chrome.tabs.get(tabId).then(() => true).catch(() => false);
  }, firstNewTabId as number)).toBe(false);

  await selectSpace(page, 'Second space');
  let replacementNewTabId: number | undefined;
  await expect.poll(async () => {
    const state = await restorationState(worker, fixture);
    replacementNewTabId = state.tabs.find((tab) =>
      tab.ownership?.spaceId === fixture.secondSpaceId &&
      isBlankTabPage(tab.pendingUrl ?? tab.url, hyperNewTabUrl))?.id;
    return replacementNewTabId;
  }).not.toBeUndefined();
  expect(replacementNewTabId).not.toBe(firstNewTabId);

  await worker.evaluate(async (tabId) => {
    const extension = globalThis as unknown as ExtensionGlobal;
    await extension.chrome.tabs.update(
      tabId,
      { url: `${extension.chrome.runtime.getURL('/newtab.html')}?test=old-new-tab` },
    );
  }, replacementNewTabId as number);

  await context.close();

  const restarted = await profile.launchHyper({ restoreLastSession: true });
  context = restarted.context;
  page = restarted.page;
  worker = restarted.worker;
  fixture = { ...fixture, windowId: await currentWindowId(worker) };
  await expect(page.locator('.space-pagination-dot')).toHaveCount(2);
  await expect.poll(() => worker.evaluate(async () => {
    const extension = globalThis as unknown as ExtensionGlobal;
    const tabs = await extension.chrome.tabs.query({});
    return tabs.filter((tab) =>
      (tab.pendingUrl ?? tab.url ?? '').includes('test=old-new-tab'));
  }), { timeout: 15_000 }).toEqual([]);
  await expect.poll(async () =>
    (await restorationState(worker, fixture)).backingsBySpace[fixture.secondSpaceId],
  ).toBe(0);
}));

test('space navigation and startup recovery never duplicate backed tabs', () => withProfile('space-restoration', async (profile) => {
  test.setTimeout(75_000);
  const launched = await profile.launchHyper({ closeInitialPage: true });
  let context = launched.context;
  let worker = launched.worker;
  let sidepanelPage = launched.page;
  await expect(sidepanelPage.locator('.space-pagination-dot')).toHaveCount(1);

  let fixture = await createSecondSpaceAfterRecoveryTabs(worker);
  await expect(spaceDot(sidepanelPage, 'Second space')).toBeVisible();

  await selectSpace(sidepanelPage, 'Second space');
  for (const url of secondSpaceRecoveryUrls) await createTab(worker, url);
  await expect.poll(async () => ownedTabCount(
    await restorationState(worker, fixture),
    secondSpaceRecoveryUrls,
    fixture.secondSpaceId,
  ), { timeout: 30_000 }).toBe(secondSpaceRecoveryUrls.length);
  let state = await restorationState(worker, fixture);
  expect(recoveryTargetCounts(state), JSON.stringify(state, null, 2)).toEqual(
    Object.fromEntries(recoveryUrls.map((url) => [url, 1])),
  );

  // Problems A and B share this assertion: every switch must preserve one live tab
  // and one backing per URL, including after groups collapse and the browser reopens.
  for (let iteration = 0; iteration < 3; iteration += 1) {
    await selectSpace(sidepanelPage, 'Space 1');
    state = await restorationState(worker, fixture);
    expectActiveTabInSpace(state, fixture.firstSpaceId);
    expect(recoveryTargetCounts(state), JSON.stringify(state, null, 2)).toEqual(
      Object.fromEntries(recoveryUrls.map((url) => [url, 1])),
    );
    expect(state.backingsBySpace).toEqual({
      [fixture.firstSpaceId]: firstSpaceRecoveryUrls.length,
      [fixture.secondSpaceId]: secondSpaceRecoveryUrls.length,
    });

    await selectSpace(sidepanelPage, 'Second space');
    state = await restorationState(worker, fixture);
    expectActiveTabInSpace(state, fixture.secondSpaceId);
    expect(recoveryTargetCounts(state), JSON.stringify(state, null, 2)).toEqual(
      Object.fromEntries(recoveryUrls.map((url) => [url, 1])),
    );
    expect(state.backingsBySpace).toEqual({
      [fixture.firstSpaceId]: firstSpaceRecoveryUrls.length,
      [fixture.secondSpaceId]: secondSpaceRecoveryUrls.length,
    });
  }

  await createBookmarkOnlyBacking(worker, firstUrl, bookmarkOnlyRecoveryUrl);
  await expect.poll(async () => (await restorationState(worker, fixture)).backingsBySpace)
    .toEqual({
      [fixture.firstSpaceId]: firstSpaceRecoveryUrls.length + 1,
      [fixture.secondSpaceId]: secondSpaceRecoveryUrls.length,
    });

  await context.close();

  const restarted = await profile.launchHyper({ restoreLastSession: true });
  context = restarted.context;
  worker = restarted.worker;
  sidepanelPage = restarted.page;
  fixture = { ...fixture, windowId: await currentWindowId(worker) };
  const expectedUrls = [...recoveryUrls, bookmarkOnlyRecoveryUrl];
  const expectedCounts = Object.fromEntries(expectedUrls.map((url) => [url, 1]));
  const expectedBackings = {
    [fixture.firstSpaceId]: firstSpaceRecoveryUrls.length + 1,
    [fixture.secondSpaceId]: secondSpaceRecoveryUrls.length,
  };
  await expect.poll(async () => {
    const restartedState = await restorationState(worker, fixture);
    return {
      backings: restartedState.backingsBySpace,
      tabs: recoveryTargetCounts(restartedState, expectedUrls),
    };
  }, { timeout: 15_000 }).toEqual({
    backings: expectedBackings,
    tabs: expectedCounts,
  });
  // Counts settle before restoration finishes grouping, so the baseline waits for that too.
  await waitForActivationQuiescence(sidepanelPage);
  const stableState = await restorationState(worker, fixture);
  const stableSignature = recoveryTabSignature(stableState, expectedUrls);
  await new Promise((resolve) => setTimeout(resolve, 3_000));
  state = await restorationState(worker, fixture);
  expect(recoveryTargetCounts(state, expectedUrls), JSON.stringify(state, null, 2))
    .toEqual(expectedCounts);
  expect(state.backingsBySpace).toEqual(expectedBackings);
  expect(recoveryTabSignature(state, expectedUrls), JSON.stringify(state, null, 2))
    .toBe(stableSignature);

  await selectSpace(sidepanelPage, 'Space 1');
  await selectSpace(sidepanelPage, 'Second space');
  state = await restorationState(worker, fixture);
  expect(recoveryTargetCounts(state, expectedUrls), JSON.stringify(state, null, 2))
    .toEqual(expectedCounts);
  expect(state.backingsBySpace).toEqual(expectedBackings);
}));

test('a tab closed or sent elsewhere while Hyper is off stays closed and is not duplicated', () => withProfile('offline-tab-changes', async (profile) => {
  test.setTimeout(60_000);
  const launched = await profile.launchHyper({ closeInitialPage: true });
  const { context } = launched;
  const browserContext = context;
  let { page: sidepanelPage, worker } = launched;
  await expect(sidepanelPage.locator('.space-pagination-dot')).toHaveCount(1);
  // A tab navigated before Playwright attaches to it misses the context's request
  // routes and can stall, so each page is navigated once Playwright holds it.
  const openPage = async (url: string) => {
    const page = await waitForNewPage(browserContext, () => createTab(worker, 'about:blank'));
    await page.goto(url);
  };
  const [closedUrl, keptUrl] = firstSpaceRecoveryUrls;
  const [movedUrl, otherUrl] = secondSpaceRecoveryUrls;
  const movedToUrl = `${movedUrl}-elsewhere`;
  const urls = [closedUrl, keptUrl, movedUrl, otherUrl, movedToUrl];
  await openPage(closedUrl);
  await openPage(keptUrl);
  const fixture = await createSecondSpace(worker);
  const settled = async () => {
    const state = await restorationState(worker, fixture);
    return { backings: state.backingsBySpace, tabs: recoveryTargetCounts(state, urls) };
  };
  // The window takes its first space, and these tabs, before another space is chosen.
  await expect.poll(async () => (await settled()).backings[fixture.firstSpaceId], {
    timeout: 30_000,
  }).toBe(2);
  await selectSpace(sidepanelPage, 'Second space');
  await openPage(movedUrl);
  await openPage(otherUrl);
  await expect.poll(settled, { timeout: 30_000 }).toEqual({
    backings: { [fixture.firstSpaceId]: 2, [fixture.secondSpaceId]: 2 },
    tabs: { [closedUrl]: 1, [keptUrl]: 1, [movedUrl]: 1, [otherUrl]: 1, [movedToUrl]: 0 },
  });

  await sidepanelPage.close();
  ({ page: sidepanelPage, worker } = await reenableHyperExtension(browserContext, worker, async () => {
    await (await pageAtUrl(browserContext, closedUrl)).close();
    await (await pageAtUrl(browserContext, movedUrl)).goto(movedToUrl);
  }));
  const expected = {
    backings: { [fixture.firstSpaceId]: 1, [fixture.secondSpaceId]: 2 },
    tabs: { [closedUrl]: 0, [keptUrl]: 1, [movedUrl]: 0, [otherUrl]: 1, [movedToUrl]: 1 },
  };
  await expect.poll(settled, { timeout: 20_000 }).toEqual(expected);
  await new Promise((resolveWait) => setTimeout(resolveWait, 1_500));
  expect(await settled()).toEqual(expected);
}));

for (const keptTab of [true, false]) test(`a reinstalled Hyper still reopens the tabs it parked, ${keptTab
  ? 'staying the installation its open windows show'
  : 'taking them from the installation it replaced'}`, () => withProfile('reinstalled-parked-tabs', async (profile) => {
  test.setTimeout(90_000);
  const launched = await profile.launchHyper({ closeInitialPage: true });
  const { context } = launched;
  let { page, worker } = launched;
  const installation = (target: Worker) => target.evaluate(async () => {
    const extension = globalThis as unknown as ExtensionGlobal;
    return (await extension.chrome.storage.local.get('hyperInstallationId')).hyperInstallationId;
  });
  const fixture = await createSecondSpace(worker);
  await expect(page.locator('.space-pagination-dot')).toHaveCount(2);
  if (keptTab) {
    const keptTabId = await createTab(worker, firstUrl);
    await expect.poll(() => nativeTabBackingState(worker, keptTabId, firstUrl))
      .toMatchObject({ ownership: { spaceId: fixture.firstSpaceId } });
  }

  // A window of its own shows the second space, then closes, parking its tab.
  await selectSpace(page, 'Second space');
  const parkedUrl = 'https://space-race.test/parked-before-reinstall';
  const parkedTabId = await createTab(worker, parkedUrl);
  await expect.poll(() => nativeTabBackingState(worker, parkedTabId, parkedUrl))
    .toMatchObject({ ownership: { spaceId: fixture.secondSpaceId } });
  const parkedWindowId = await worker.evaluate(async (tabId) => {
    const extension = globalThis as unknown as ExtensionGlobal;
    const created = await extension.chrome.windows.create({ focused: true, url: 'about:blank' });
    await extension.chrome.tabs.move(tabId, { index: -1, windowId: created!.id });
    return created!.id as number;
  }, parkedTabId);
  await expect.poll(() => nativeTabBackingState(worker, parkedTabId, parkedUrl), { timeout: 20_000 })
    .toMatchObject({ backing: { windowId: parkedWindowId } });
  const backingId = (await nativeTabBackingState(worker, parkedTabId, parkedUrl)).backing?.id;
  // Another window still showing the space as it closes would take the tab back.
  await selectSpace(page, 'Space 1');
  await worker.evaluate(async ({ open, closing }) => {
    const extension = globalThis as unknown as ExtensionGlobal;
    await extension.chrome.windows.update(open, { focused: true });
    await extension.chrome.windows.remove(closing);
  }, { closing: parkedWindowId, open: fixture.windowId });
  await expect.poll(async () =>
    (await nativeTabBackingState(worker, parkedTabId, parkedUrl, backingId)).matchingTabIds,
  ).toEqual([]);
  // The next start finds the window gone and leaves its tab parked for the space.
  ({ page, worker } = await reloadHyperExtension(context, worker));
  await expect.poll(async () =>
    (await nativeTabBackingState(worker, parkedTabId, parkedUrl, backingId)).backing,
  { timeout: 20_000 }).toEqual({ id: backingId, spaceId: fixture.secondSpaceId, token: expect.any(String) });
  const installed = await installation(worker);

  // Removing and re-adding the extension clears its storage, but not the tabs it parked.
  await callChrome(worker, 'storage.local.clear');
  ({ page, worker } = await reloadHyperExtension(context, worker));
  await expect(page.locator('.space-pagination-dot')).toHaveCount(2);
  if (keptTab) await expect.poll(() => installation(worker)).toBe(installed);
  else await expect.poll(() => installation(worker)).not.toBe(installed);
  await selectSpace(page, 'Second space');
  await expect.poll(async () =>
    (await nativeTabBackingState(worker, parkedTabId, parkedUrl, backingId)).matchingTabIds,
  { timeout: 15_000 }).toHaveLength(1);
}));

test('a reopened space restores only the tabs the browser did not restore itself', () => withProfile('reopened-window', async (profile) => {
  test.setTimeout(60_000);
  const { page, worker } = await profile.launchHyper({ closeInitialPage: true });
  const fixture = await createSecondSpace(worker);
  await expect(page.locator('.space-pagination-dot')).toHaveCount(2);
  // Space 1 keeps a page of its own to come back to.
  await createTab(worker, firstUrl);
  await expect.poll(() => pageTabWindows(worker, [firstUrl]))
    .toEqual({ [firstUrl]: [fixture.windowId] });
  await selectSpace(page, 'Second space');
  const urls = ['a', 'b', 'c'].map((name) => `https://space-race.test/reopened-${name}`);
  const tabIds: number[] = [];
  for (const url of urls) tabIds.push(await createTab(worker, url));
  await expect.poll(() => worker.evaluate(async (targetTabIds) => {
    const extension = globalThis as unknown as ExtensionGlobal;
    return Promise.all(targetTabIds.map(async (tabId) => {
      const key = `tabSpaceId:${tabId}`;
      return ((await extension.chrome.storage.session.get(key))[key] as { spaceId?: string } | undefined)
        ?.spaceId;
    }));
  }, tabIds)).toEqual(urls.map(() => fixture.secondSpaceId));
  // The space's tabs live in a second window, which then closes and parks them.
  const secondWindowId = await worker.evaluate(async (targetTabIds) => {
    const extension = globalThis as unknown as ExtensionGlobal;
    const created = await extension.chrome.windows.create({ focused: true, url: 'about:blank' });
    await extension.chrome.tabs.move(targetTabIds, { index: -1, windowId: created!.id });
    return created!.id as number;
  }, tabIds);
  await expect.poll(() => worker.evaluate(async ({ targetUrls, windowId }) => {
    type Node = { children?: Node[]; title: string; url?: string };
    const walk = (nodes: Node[]): Node[] =>
      nodes.flatMap((node) => [node, ...walk(node.children ?? [])]);
    const extension = globalThis as unknown as ExtensionGlobal;
    return walk(await extension.chrome.bookmarks.getTree()).filter((node) =>
      node.url && targetUrls.includes(node.url) &&
      JSON.parse(node.title.slice(node.title.indexOf('{'))).hyper.windowId === windowId).length;
  }, { targetUrls: urls, windowId: secondWindowId }), { timeout: 20_000 }).toBe(urls.length);
  // The browser only saves a page into the closed window once the page has loaded.
  await expect.poll(() => worker.evaluate(async (targetTabIds) => {
    const extension = globalThis as unknown as ExtensionGlobal;
    return Promise.all(targetTabIds.map(async (tabId) => {
      const tab = await extension.chrome.tabs.get(tabId);
      return tab.status === 'complete' ? tab.url : undefined;
    }));
  }, tabIds), { timeout: 15_000 }).toEqual(urls);
  await callChrome(worker, 'windows.update', fixture.windowId, { focused: true });
  await selectSpace(page, 'Space 1');
  // Regrouping Space 1 here must not pull its tab into the window that was focused last.
  expect(await pageTabWindows(worker, [firstUrl])).toEqual({ [firstUrl]: [fixture.windowId] });
  await closeWindow(worker, secondWindowId);
  await page.waitForTimeout(2_500);
  expect(await pageTabWindows(worker, urls)).toEqual(Object.fromEntries(urls.map((url) => [url, []])));
  expect(await worker.evaluate(async () => {
    const extension = globalThis as unknown as ExtensionGlobal;
    const [latest] = await extension.chrome.sessions.getRecentlyClosed({ maxResults: 1 });
    return latest?.window?.tabs?.map((tab) => tab.url).sort();
  })).toEqual(['about:blank', ...urls].sort());

  // The browser reopens the closed window while the space opens again.
  await callChrome(worker, 'sessions.restore');
  await selectSpace(page, 'Second space');
  const reopened = async () => {
    const windows = await pageTabWindows(worker, [...urls, firstUrl]);
    const reopenedWindowIds = new Set(urls.flatMap((url) => windows[url] ?? []));
    return {
      first: windows[firstUrl],
      // Each page once, all together in a window other than the one that opened the space.
      reopened: urls.map((url) => windows[url]?.length),
      together: reopenedWindowIds.size === 1 && !reopenedWindowIds.has(fixture.windowId),
    };
  };
  const expected = { first: [fixture.windowId], reopened: urls.map(() => 1), together: true };
  await expect.poll(reopened, { timeout: 15_000 }).toEqual(expected);
  await page.waitForTimeout(3_000);
  expect(await reopened()).toEqual(expected);
}));

/** Tabs and tab backings on the fixture host, by page path. */
async function settlingPages(worker: Worker): Promise<{ backings: string[]; tabs: string[] }> {
  return worker.evaluate(async () => {
    interface BookmarkNode { children?: BookmarkNode[]; title: string; url?: string }
    const extension = globalThis as unknown as ExtensionGlobal;
    const origin = 'https://space-race.test';
    const path = (url?: string) => url?.startsWith(origin) ? url.slice(origin.length) : undefined;
    const walk = (nodes: BookmarkNode[]): BookmarkNode[] =>
      nodes.flatMap((node) => [node, ...walk(node.children ?? [])]);
    const backings = walk(await extension.chrome.bookmarks.getTree()).flatMap((node) => {
      const page = path(node.url);
      return page && node.title.includes('"tabToken"') ? [page] : [];
    });
    const tabs = (await extension.chrome.tabs.query({})).flatMap((tab) => {
      const page = path(tab.pendingUrl ?? tab.url);
      return page ? [page] : [];
    });
    return { backings: backings.sort(), tabs: tabs.sort() };
  });
}

test('a tab the browser restores before its redirect settled keeps its backing across restarts', () => withProfile('settling-restore', async (profile) => {
  test.setTimeout(120_000);
  let launched = await profile.launchHyper({ closeInitialPage: true });
  let context = launched.context;
  let { worker } = launched;
  // Each tab settles while it is in front, since a hidden page's timers may not run.
  for (const [path, settledPath] of [
    ['/first', '/first'],
    ['/settles-elsewhere', '/settled'],
    ['/settles-elsewhere', '/settled'],
    ['/second', '/second'],
  ]) {
    const tabId = await createTab(worker, `https://space-race.test${path}`);
    await expect.poll(() => tabUrl(worker, tabId), { timeout: 15_000 })
      .toBe(`https://space-race.test${settledPath}`);
  }
  // The backings follow each redirect, so they record a later address than the browser may restore.
  const settled = { backings: ['/first', '/second', '/settled', '/settled'], tabs: ['/first', '/second', '/settled', '/settled'] };
  await expect.poll(() => settlingPages(worker), { timeout: 15_000 }).toEqual(settled);

  for (let restart = 0; restart < 3; restart += 1) {
    await context.close();
    launched = await profile.launchHyper({ restoreLastSession: true });
    context = launched.context;
    ({ worker } = launched);
    await waitForActivationQuiescence(launched.page);
    await expect.poll(async () => {
      const { backings, tabs } = await settlingPages(worker);
      return { backings: backings.length, tabs: tabs.length };
    }, { timeout: 15_000 }).toEqual({ backings: 4, tabs: 4 });
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    const pages = await settlingPages(worker);
    expect(pages, `restart ${restart + 1}`).toEqual({
      backings: expect.arrayContaining(['/first', '/second']),
      tabs: expect.arrayContaining(['/first', '/second']),
    });
    expect({ backings: pages.backings.length, tabs: pages.tabs.length }, `restart ${restart + 1}: ${JSON.stringify(pages)}`)
      .toEqual({ backings: 4, tabs: 4 });
  }
}));
