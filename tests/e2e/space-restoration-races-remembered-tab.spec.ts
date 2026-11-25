import { expect, test } from '@playwright/test';
import { callChrome } from './helpers/chrome';
import { waitForActivationQuiescence } from './fixtures/activation';
import { clearActiveSpaceId, readActiveSpaceId } from './fixtures/activeSpace';
import {
  firstUrl,
  restorationState,
  secondUrl,
  targetCounts,
} from './helpers/restoration';
import { selectSpace, spaceDot } from './helpers/sidebar';
import {
  createSecondSpace,
  createTwoSpacesWithTabs,
  setSpaceLastActiveTabToken,
  spaceIdByTitle,
  spaceLastActiveTabToken,
} from './helpers/spaces';
import {
  activateTab,
  createTab,
  currentWindowId,
  navigationState,
  tabBackingToken,
  tabOwnershipSummary,
} from './helpers/tabs';
import type { ExtensionGlobal } from './helpers/extensionGlobal';
import { withProfile } from './helpers/extension';

test('reopens a space on its most recently activated tab', () => withProfile('active-space-tab', async (profile) => {
  const { page, worker } = await profile.launchHyper({ closeInitialPage: true });
  await expect(page.locator('.space-pagination-dot')).toHaveCount(1);

  const firstTabId = await createTab(worker, firstUrl);
  const secondTabId = await createTab(worker, secondUrl);
  const fixture = await createSecondSpace(worker);
  await expect(spaceDot(page, 'Second space')).toBeVisible();
  await expect.poll(() => tabBackingToken(worker, firstTabId)).not.toBeUndefined();
  await expect.poll(() => tabBackingToken(worker, secondTabId)).not.toBeUndefined();

  await activateTab(worker, secondTabId);
  const rememberedToken = await tabBackingToken(worker, secondTabId);
  const otherWindowToken = await tabBackingToken(worker, firstTabId);
  if (!rememberedToken || !otherWindowToken) {
    throw new Error('Tab backing tokens were not assigned.');
  }

  await selectSpace(page, 'Second space');
  await expect.poll(() =>
    spaceLastActiveTabToken(worker, fixture.firstSpaceId, fixture.windowId))
    .toBe(rememberedToken);
  await setSpaceLastActiveTabToken(
    worker,
    fixture.firstSpaceId,
    otherWindowToken,
    fixture.windowId + 1,
  );
  await expect(spaceLastActiveTabToken(worker, fixture.firstSpaceId))
    .resolves.toBe(otherWindowToken);
  await selectSpace(page, 'Space 1');
  await expect.poll(async () =>
    (await navigationState(worker, [firstTabId, secondTabId])).activeTabId,
  ).toBe(secondTabId);
  await expect.poll(() =>
    spaceLastActiveTabToken(worker, fixture.firstSpaceId, fixture.windowId))
    .toBe(rememberedToken);
}));

test('focuses the remembered tab before reconciling native groups', () => withProfile('tab-first-space-switch', async (profile) => {
  const { page, worker } = await profile.launchHyper({ closeInitialPage: true });
  const firstTabId = await createTab(worker, firstUrl);
  const rememberedTabId = await createTab(worker, secondUrl);
  await expect.poll(() => tabOwnershipSummary(worker, [firstTabId, rememberedTabId]))
    .toEqual({ allOwned: true, spaceCount: 1 });
  const fixture = await createSecondSpace(worker);
  await activateTab(worker, rememberedTabId);
  const rememberedToken = await tabBackingToken(worker, rememberedTabId);
  await expect.poll(() =>
    spaceLastActiveTabToken(worker, fixture.firstSpaceId, fixture.windowId))
    .toBe(rememberedToken);
  await selectSpace(page, 'Second space');
  const beforeSwitch = await restorationState(worker, fixture);
  const firstGroupId = beforeSwitch.tabs.find((tab) => tab.id === firstTabId)?.groupId;
  const secondGroupId = beforeSwitch.tabs.find((tab) =>
    tab.active && tab.ownership?.spaceId === fixture.secondSpaceId)?.groupId;
  if (firstGroupId === undefined || secondGroupId === undefined) {
    throw new Error('Both spaces must have native groups before switching.');
  }

  await worker.evaluate(() => {
    type Event =
      | { tabId: number; type: 'tab-activated' }
      | { collapsed?: boolean; groupId: number; type: 'group-update-requested' };
    const runtime = globalThis as unknown as ExtensionGlobal & {
      __hyperGroupUpdateGate?: { events: Event[]; release: () => void };
    };
    const originalUpdate = runtime.chrome.tabGroups.update.bind(runtime.chrome.tabGroups);
    let release = () => {};
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    const events: Event[] = [];
    runtime.__hyperGroupUpdateGate = { events, release };
    runtime.chrome.tabs.onActivated.addListener(({ tabId }) => {
      events.push({ tabId, type: 'tab-activated' });
    });
    runtime.chrome.tabGroups.update = async (groupId, changes) => {
      events.push({ collapsed: changes.collapsed, groupId, type: 'group-update-requested' });
      await gate;
      return originalUpdate(groupId, changes);
    };
  });

  const firstSpaceButton = spaceDot(page, 'Space 1');
  await firstSpaceButton.click();
  await expect(firstSpaceButton).toHaveAttribute('aria-current', 'page');
  await expect.poll(async () =>
    (await navigationState(worker, [firstTabId, rememberedTabId])).activeTabId,
  ).toBe(rememberedTabId);
  await expect.poll(() => worker.evaluate(() => {
    const runtime = globalThis as unknown as {
      __hyperGroupUpdateGate?: { events: Array<{ type: string }> };
    };
    return runtime.__hyperGroupUpdateGate?.events.some(
      (event) => event.type === 'group-update-requested',
    ) ?? false;
  })).toBe(true);
  const blockedState = await restorationState(worker, fixture);
  expect(blockedState.groups.find((group) => group.id === firstGroupId)?.collapsed).toBe(false);
  expect(blockedState.groups.find((group) => group.id === secondGroupId)?.collapsed).toBe(false);
  const blockedEvents = await worker.evaluate(() => {
    const runtime = globalThis as unknown as {
      __hyperGroupUpdateGate?: {
        events: Array<{
          collapsed?: boolean;
          groupId?: number;
          tabId?: number;
          type: string;
        }>;
      };
    };
    return runtime.__hyperGroupUpdateGate?.events ?? [];
  });
  expect(blockedEvents[0]).toEqual({
    tabId: rememberedTabId,
    type: 'tab-activated',
  });
  expect(blockedEvents).toContainEqual({
    collapsed: true,
    groupId: secondGroupId,
    type: 'group-update-requested',
  });

  await worker.evaluate(() => {
    const runtime = globalThis as unknown as {
      __hyperGroupUpdateGate?: { release: () => void };
    };
    runtime.__hyperGroupUpdateGate?.release();
  });
  await expect.poll(async () => {
    const state = await restorationState(worker, fixture);
    return {
      activeTabId: state.tabs.find((tab) => tab.active)?.id,
      firstCollapsed: state.groups.find((group) => group.id === firstGroupId)?.collapsed,
      secondInactive: state.groups.find((group) => group.id === secondGroupId)?.collapsed ?? true,
    };
  }).toEqual({
    activeTabId: rememberedTabId,
    firstCollapsed: false,
    secondInactive: true,
  });
  expect(targetCounts(await restorationState(worker, fixture))).toEqual({
    [firstUrl]: 1,
    [secondUrl]: 1,
  });
}));

test('group reconciliation cannot override the last-used tab', () => withProfile('last-used-tab-group-race', async (profile) => {
  const { page, worker } = await profile.launchHyper({ closeInitialPage: true });
  const firstTabId = await createTab(worker, firstUrl);
  const secondTabId = await createTab(worker, secondUrl);
  await expect.poll(() => tabOwnershipSummary(worker, [firstTabId, secondTabId]))
    .toEqual({ allOwned: true, spaceCount: 1 });
  const fixture = await createSecondSpace(worker);
  await activateTab(worker, firstTabId);
  await expect.poll(async () =>
    (await navigationState(worker, [firstTabId, secondTabId])).activeTabId,
  ).toBe(firstTabId);
  await activateTab(worker, secondTabId);
  await expect.poll(async () =>
    (await navigationState(worker, [firstTabId, secondTabId])).activeTabId,
  ).toBe(secondTabId);
  // Naming the remembered tab rather than its token keeps the assertion true
  // when a backing is rebuilt, and says which tab was remembered when it is not.
  const rememberedTab = async () => {
    const [firstToken, secondToken, remembered] = await Promise.all([
      tabBackingToken(worker, firstTabId),
      tabBackingToken(worker, secondTabId),
      spaceLastActiveTabToken(worker, fixture.firstSpaceId, fixture.windowId),
    ]);
    if (remembered === undefined) return 'no tab';
    if (remembered === firstToken) return 'first tab';
    return remembered === secondToken ? 'second tab' : 'an unknown tab';
  };
  await expect.poll(rememberedTab).toBe('second tab');
  await selectSpace(page, 'Second space');
  await page.evaluate((fallbackTabId) => {
    const runtime = globalThis as unknown as ExtensionGlobal;
    const originalGroupUpdate = runtime.chrome.tabGroups.update.bind(
      runtime.chrome.tabGroups,
    );
    const originalTabUpdate = runtime.chrome.tabs.update.bind(runtime.chrome.tabs);
    let redirected = false;
    runtime.chrome.tabGroups.update = async (groupId, changes) => {
      const result = await originalGroupUpdate(groupId, changes);
      if (!redirected && changes.collapsed === true) {
        redirected = true;
        await originalTabUpdate(fallbackTabId, { active: true });
      }
      return result;
    };
  }, firstTabId);

  await selectSpace(page, 'Space 1');
  await expect.poll(async () =>
    (await navigationState(worker, [firstTabId, secondTabId])).activeTabId,
  ).toBe(secondTabId);
}));

test('opens the first ordered tab when a space has no current-window focus history', () => withProfile('space-first-tab-focus', async (profile) => {
  const { page, worker } = await profile.launchHyper({ closeInitialPage: true });
  const firstTabId = await createTab(worker, firstUrl);
  // Grouped one at a time, so the first tab is also first in the space's order.
  await expect.poll(() => tabOwnershipSummary(worker, [firstTabId]))
    .toEqual({ allOwned: true, spaceCount: 1 });
  const secondTabId = await createTab(worker, secondUrl);
  await expect.poll(() => tabOwnershipSummary(worker, [firstTabId, secondTabId]))
    .toEqual({ allOwned: true, spaceCount: 1 });
  const fixture = await createSecondSpace(worker);
  await selectSpace(page, 'Second space');
  // Leaving Space 1 records its focused tab, which would overwrite the token set below.
  await waitForActivationQuiescence(page);
  await setSpaceLastActiveTabToken(
    worker,
    fixture.firstSpaceId,
    'missing-current-window-token',
    fixture.windowId,
  );

  await selectSpace(page, 'Space 1');

  await expect.poll(async () =>
    (await navigationState(worker, [firstTabId, secondTabId])).activeTabId,
  ).toBe(firstTabId);
}));

test('restoring a window space keeps the browser active tab over stale space metadata', () => withProfile('startup-active-tab', async (profile) => {
  const { page, worker } = await profile.launchHyper({ closeInitialPage: true });
  await expect(page.locator('.space-pagination-dot')).toHaveCount(1);

  const firstTabId = await createTab(worker, firstUrl);
  const secondTabId = await createTab(worker, secondUrl);
  const spaceId = await spaceIdByTitle(worker, 'Space 1');
  if (!spaceId) throw new Error('The initial space was not found.');
  await expect.poll(() => tabBackingToken(worker, firstTabId)).not.toBeUndefined();
  await expect.poll(() => tabBackingToken(worker, secondTabId)).not.toBeUndefined();
  const firstToken = await tabBackingToken(worker, firstTabId);
  const secondToken = await tabBackingToken(worker, secondTabId);
  if (!firstToken || !secondToken) throw new Error('Tab backing tokens were not assigned.');
  await activateTab(worker, secondTabId);
  await expect.poll(async () =>
    (await navigationState(worker, [firstTabId, secondTabId])).activeTabId,
  ).toBe(secondTabId);
  await waitForActivationQuiescence(page);

  await setSpaceLastActiveTabToken(worker, spaceId, firstToken);
  await expect(spaceLastActiveTabToken(worker, spaceId)).resolves.toBe(firstToken);
  // The window loses its space, as a restart leaves it, and the background gives it back.
  const windowId = await currentWindowId(worker);
  await clearActiveSpaceId(worker, windowId);

  await expect.poll(() => readActiveSpaceId(worker, windowId)).toBe(spaceId);
  await expect.poll(() => spaceLastActiveTabToken(worker, spaceId)).toBe(secondToken);
  expect((await navigationState(worker, [firstTabId, secondTabId])).activeTabId)
    .toBe(secondTabId);
}));

test('browser fallback activation expands its space after the active group closes', () => withProfile('browser-fallback-space', async (profile) => {
  const { page, worker } = await profile.launchHyper({ closeInitialPage: true });
  const { firstTabId, fixture, secondTabId } = await createTwoSpacesWithTabs(page, worker);
  await selectSpace(page, 'Space 1');

  await expect.poll(async () => {
    const state = await restorationState(worker, fixture);
    const firstTab = state.tabs.find((tab) => tab.id === firstTabId);
    const secondTab = state.tabs.find((tab) => tab.id === secondTabId);
    return {
      activeTabId: state.tabs.find((tab) => tab.active)?.id,
      firstGroupCollapsed: state.groups.find((group) => group.id === firstTab?.groupId)
        ?.collapsed,
      secondGroupCollapsed: state.groups.find((group) => group.id === secondTab?.groupId)
        ?.collapsed,
    };
  }).toEqual({
    activeTabId: firstTabId,
    firstGroupCollapsed: false,
    secondGroupCollapsed: true,
  });
  await page.close();

  await callChrome(worker, 'tabs.remove', firstTabId);

  await expect.poll(async () => {
    const state = await restorationState(worker, fixture);
    const activeTab = state.tabs.find((tab) => tab.active);
    const activeGroup = state.groups.find((group) => group.id === activeTab?.groupId);
    const storedActiveSpaceId = await readActiveSpaceId(worker, fixture.windowId);
    return {
      activeGroupCollapsed: activeGroup?.collapsed,
      activeSpaceId: activeTab?.ownership?.spaceId,
      activeTabId: activeTab?.id,
      otherGroupsCollapsed: state.groups
        .filter((group) => group.id !== activeGroup?.id)
        .every((group) => group.collapsed),
      storedActiveSpaceId,
    };
  }).toEqual({
    activeGroupCollapsed: false,
    activeSpaceId: fixture.secondSpaceId,
    activeTabId: secondTabId,
    otherGroupsCollapsed: true,
    storedActiveSpaceId: fixture.secondSpaceId,
  });
}));
