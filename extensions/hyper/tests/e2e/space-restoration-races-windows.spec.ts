import { expect, test } from '@playwright/test';
import { callChrome } from './helpers/chrome';
import { readActiveSpaceId } from './fixtures/activeSpace';
import { firstUrl, nativeTabBackingState } from './helpers/restoration';
import { selectSpace } from './helpers/sidebar';
import { createSecondSpace, spaceIdByTitle } from './helpers/spaces';
import {
  browserTab,
  closeWindow,
  createTab,
  holdTabDrag,
  tabOwnershipSummary,
  waitForNewPage,
} from './helpers/tabs';
import type { ExtensionGlobal } from './helpers/extensionGlobal';
import { withProfile } from './helpers/extension';

test('native cross-window tab lifecycle preserves and then removes one backing', () => withProfile('native-tab-lifecycle', async (profile) => {
  test.setTimeout(45_000);
  const launched = await profile.launchHyper({ closeInitialPage: true });
  const worker = launched.worker;
  const tabId = await createTab(worker, firstUrl);
  await expect.poll(() => nativeTabBackingState(worker, tabId, firstUrl))
    .toMatchObject({
      matchingTabIds: [tabId],
      ownership: { backingId: expect.any(String), backingToken: expect.any(String) },
    });
  const initial = await nativeTabBackingState(worker, tabId, firstUrl);
  const backingId = initial.ownership?.backingId;
  const backingToken = initial.ownership?.backingToken;
  if (!backingId || !backingToken) throw new Error('The native tab backing was not assigned.');

  const secondWindowId = await worker.evaluate(async () => {
    const extension = globalThis as unknown as ExtensionGlobal;
    const created = await extension.chrome.windows.create({
      focused: true,
      url: 'about:blank',
    });
    if (created?.id === undefined) throw new Error('Chrome did not create a second window.');
    return created.id;
  });
  await callChrome(worker, 'tabs.move', tabId, {
    index: -1,
    windowId: secondWindowId,
  });

  await expect.poll(() => nativeTabBackingState(worker, tabId, firstUrl, backingId), {
    timeout: 20_000,
  }).toMatchObject({
    backing: { id: backingId, token: backingToken, windowId: secondWindowId },
    matchingTabIds: [tabId],
    ownership: {
      backingId,
      backingToken,
      windowId: secondWindowId,
    },
    tab: { groupId: expect.any(Number), id: tabId, windowId: secondWindowId },
  });
  await expect.poll(async () =>
    (await nativeTabBackingState(worker, tabId, firstUrl, backingId)).tab?.groupId,
  ).toBeGreaterThanOrEqual(0);

  await worker.evaluate(async (targetTabId) => {
    const extension = globalThis as unknown as ExtensionGlobal;
    await extension.chrome.tabs.ungroup(targetTabId);
    await extension.chrome.tabs.move(targetTabId, { index: 0 });
  }, tabId);
  await expect.poll(async () => {
    const state = await nativeTabBackingState(worker, tabId, firstUrl, backingId);
    return {
      backingId: state.ownership?.backingId,
      groupId: state.tab?.groupId,
      matchingTabIds: state.matchingTabIds,
    };
  }).toEqual({
    backingId,
    groupId: expect.any(Number),
    matchingTabIds: [tabId],
  });
  await expect.poll(async () =>
    (await nativeTabBackingState(worker, tabId, firstUrl, backingId)).tab?.groupId,
  ).toBeGreaterThanOrEqual(0);

  await callChrome(worker, 'tabs.remove', tabId);
  await expect.poll(() => nativeTabBackingState(worker, tabId, firstUrl, backingId))
    .toMatchObject({ matchingTabIds: [] });
  await expect.poll(async () =>
    (await nativeTabBackingState(worker, tabId, firstUrl, backingId)).backing,
  ).toBeUndefined();

  await closeWindow(worker, secondWindowId);
}));

test('a closed window hands its space tabs to another window of the space, else parks them', () => withProfile('closed-window-tabs', async (profile) => {
  test.setTimeout(60_000);
  const { page, worker } = await profile.launchHyper({ closeInitialPage: true });
  const fixture = await createSecondSpace(worker);
  await expect(page.locator('.space-pagination-dot')).toHaveCount(2);
  const tabsAt = (url: string) => worker.evaluate(async (targetUrl) => {
    const extension = globalThis as unknown as ExtensionGlobal;
    const tabs = (await extension.chrome.tabs.query({})).filter((tab) => tab.url === targetUrl);
    return Promise.all(tabs.map(async (tab) => {
      const key = `tabSpaceId:${tab.id}`;
      const ownership = (await extension.chrome.storage.session.get(key))[key] as
        { spaceId?: string } | undefined;
      return { spaceId: ownership?.spaceId, windowId: tab.windowId };
    }));
  }, url);
  const openWindow = async (url: string) => {
    const tabId = await createTab(worker, url);
    await expect.poll(async () => (await tabsAt(url))[0]?.spaceId).toBeTruthy();
    // Moving an owned tab into a new window gives the space a second window.
    return worker.evaluate(async (targetTabId) => {
      const extension = globalThis as unknown as ExtensionGlobal;
      const created = await extension.chrome.windows.create({ focused: true, url: 'about:blank' });
      await extension.chrome.tabs.move(targetTabId, { index: -1, windowId: created!.id });
      return created!.id as number;
    }, tabId);
  };
  const ownedSpaceAt = async (url: string, windowId: number) => {
    await expect.poll(async () => (await tabsAt(url))[0]?.windowId).toBe(windowId);
    // The backing follows its tab to the new window shortly after the move.
    await expect.poll(() => worker.evaluate(async (targetUrl) => {
      type Node = { children?: Node[]; title: string; url?: string };
      const walk = (nodes: Node[]): Node[] =>
        nodes.flatMap((node) => [node, ...walk(node.children ?? [])]);
      const extension = globalThis as unknown as ExtensionGlobal;
      const backing = walk(await extension.chrome.bookmarks.getTree())
        .find((node) => node.url === targetUrl);
      return backing ? JSON.parse(backing.title.slice(backing.title.indexOf('{'))).hyper.windowId : undefined;
    }, url), { timeout: 20_000 }).toBe(windowId);
    return (await tabsAt(url))[0]?.spaceId;
  };

  // Another window already showing the space takes the closed window's tab.
  const movedUrl = 'https://space-race.test/moved-on-close';
  const movedWindowId = await openWindow(movedUrl);
  const movedSpaceId = await ownedSpaceAt(movedUrl, movedWindowId);
  await closeWindow(worker, movedWindowId);
  await expect.poll(() => tabsAt(movedUrl), { timeout: 15_000 })
    .toEqual([{ spaceId: movedSpaceId, windowId: fixture.windowId }]);

  // With the space open nowhere, the tab waits for the space to open again.
  const parkedUrl = 'https://space-race.test/parked-on-close';
  await selectSpace(page, 'Second space');
  const parkedWindowId = await openWindow(parkedUrl);
  await expect.poll(() => ownedSpaceAt(parkedUrl, parkedWindowId), { timeout: 30_000 })
    .toBe(fixture.secondSpaceId);
  await callChrome(worker, 'windows.update', fixture.windowId, { focused: true });
  await selectSpace(page, 'Space 1');
  await closeWindow(worker, parkedWindowId);
  await page.waitForTimeout(2_500);
  await expect.poll(() => tabsAt(parkedUrl)).toEqual([]);
  await selectSpace(page, 'Second space');
  await expect.poll(() => tabsAt(parkedUrl), { timeout: 15_000 })
    .toEqual([{ spaceId: fixture.secondSpaceId, windowId: fixture.windowId }]);
}));

test('a window takes a space and groups its tab while no sidebar is open', () => withProfile('space-without-sidebar', async (profile) => {
  const { page, worker } = await profile.launchHyper({ closeInitialPage: true });
  const spaceId = await spaceIdByTitle(worker, 'Space 1');
  await page.close();

  const opened = await worker.evaluate(async (url) => {
    const extension = globalThis as unknown as ExtensionGlobal;
    const created = await extension.chrome.windows.create({ focused: true, url });
    const tabId = created?.tabs?.[0]?.id;
    if (created?.id === undefined || tabId === undefined) {
      throw new Error('Chrome did not create the window.');
    }
    return { tabId, windowId: created.id };
  }, firstUrl);

  await expect.poll(() => readActiveSpaceId(worker, opened.windowId), { timeout: 15_000 })
    .toBe(spaceId);
  await expect.poll(() => tabOwnershipSummary(worker, [opened.tabId]))
    .toEqual({ allOwned: true, spaceCount: 1 });
  await expect.poll(async () => (await browserTab(worker, opened.tabId)).groupId)
    .toBeGreaterThanOrEqual(0);
}));

test('a tab dragged out into a new window keeps its space, which the new window shows', () => withProfile('torn-off-tab', async (profile) => {
  const { context, page, worker } = await profile.launchHyper({ closeInitialPage: true });
  const fixture = await createSecondSpace(worker);
  await selectSpace(page, 'Second space');
  const tabId = await createTab(worker, firstUrl);
  await expect.poll(() => nativeTabBackingState(worker, tabId, firstUrl))
    .toMatchObject({ ownership: { spaceId: fixture.secondSpaceId, windowId: fixture.windowId } });

  // Dragging a tab out of the tab strip opens a new window holding it, as this does,
  // and until the drag ends no extension can edit a tab strip.
  await holdTabDrag(worker, true);
  const windowId = await worker.evaluate(async (targetTabId) => {
    const extension = globalThis as unknown as ExtensionGlobal;
    const created = await extension.chrome.windows.create({ focused: true, tabId: targetTabId });
    if (created?.id === undefined) throw new Error('Chrome did not create the window.');
    return created.id;
  }, tabId);
  await expect.poll(() => worker.evaluate(() =>
    (globalThis as unknown as { __hyperTabDrag: { refused: number } }).__hyperTabDrag.refused))
    .toBeGreaterThan(0);
  await holdTabDrag(worker, false);

  await expect.poll(() => readActiveSpaceId(worker, windowId), { timeout: 15_000 })
    .toBe(fixture.secondSpaceId);
  await expect.poll(() => nativeTabBackingState(worker, tabId, firstUrl)).toMatchObject({
    ownership: { spaceId: fixture.secondSpaceId, windowId },
    tab: { groupId: expect.any(Number), windowId },
  });
  const sidebar = await waitForNewPage(context, () =>
    createTab(worker, page.url(), { active: false, windowId }));
  await expect(sidebar.locator('.space-pagination-dot[aria-current="page"]'))
    .toHaveAttribute('aria-label', 'Open Second space');
  await expect(sidebar.locator(`.tab-row .tab-main[data-url="${firstUrl}"]`)).toBeVisible();
}));

test('closing the last tab of a window closes the window, even a new tab page in a space', () => withProfile('last-tab-close', async (profile) => {
  test.setTimeout(60_000);
  const { context, worker } = await profile.launchHyper({ closeInitialPage: true });
  const spaceId = await spaceIdByTitle(worker, 'Space 1');
  const opened = await worker.evaluate(async (url) => {
    const { chrome } = globalThis as unknown as ExtensionGlobal;
    const created = await chrome.windows.create({ focused: true, url });
    const tabId = created?.tabs?.[0]?.id;
    if (created?.id === undefined || tabId === undefined) throw new Error('Chrome did not create the window.');
    return { tabId, windowId: created.id };
  }, firstUrl);
  const groupOf = async (tabId: number) => (await browserTab(worker, tabId)).groupId;
  await expect.poll(() => readActiveSpaceId(worker, opened.windowId), { timeout: 15_000 }).toBe(spaceId);
  await expect.poll(() => groupOf(opened.tabId)).toBeGreaterThanOrEqual(0);

  // The user opens a new tab page in the space, then closes the space's other tab.
  const newTab = await waitForNewPage(context, () => worker.evaluate(async (windowId) => {
    const { chrome } = globalThis as unknown as ExtensionGlobal;
    await chrome.tabs.create({ active: true, windowId });
  }, opened.windowId));
  const newTabId = await worker.evaluate(async (windowId) => {
    const { chrome } = globalThis as unknown as ExtensionGlobal;
    const [tab] = await chrome.tabs.query({ active: true, windowId });
    return tab?.id as number;
  }, opened.windowId);
  await expect.poll(() => tabOwnershipSummary(worker, [newTabId])).toEqual({ allOwned: true, spaceCount: 1 });
  await expect.poll(() => groupOf(newTabId)).toBe(await groupOf(opened.tabId));
  await callChrome(worker, 'tabs.remove', opened.tabId);
  await newTab.waitForTimeout(1_000);

  await worker.evaluate((windowId) => {
    const { chrome } = globalThis as unknown as ExtensionGlobal;
    const recorded = globalThis as unknown as { lastTabCloseCreated: number[] };
    recorded.lastTabCloseCreated = [];
    chrome.tabs.onCreated.addListener((tab) => {
      if (tab.windowId === windowId && tab.id !== undefined) recorded.lastTabCloseCreated.push(tab.id);
    });
  }, opened.windowId);
  // Closing a page this way closes its tab as the tab strip's close button does.
  await newTab.close();

  await expect.poll(() => worker.evaluate(async (windowId) => {
    const { chrome } = globalThis as unknown as ExtensionGlobal;
    return (await chrome.windows.getAll()).some((window) => window.id === windowId);
  }, opened.windowId), { timeout: 10_000 }).toBe(false);
  expect(await worker.evaluate(() =>
    (globalThis as unknown as { lastTabCloseCreated: number[] }).lastTabCloseCreated)).toEqual([]);
}));
