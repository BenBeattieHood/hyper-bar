import { expect, type Page, type Worker } from '@playwright/test';
import { spaceBookmarkTitleWithLastActiveTabToken, spaceLastActiveTabToken as lastActiveTabTokenIn } from '../../../entrypoints/lib/bookmarks';
import { spaceGroupKey } from '../../../entrypoints/lib/spaceGroupStore';
import { waitForActivationQuiescence } from '../fixtures/activation';
import {
  allBookmarks,
  bookmarkTitle,
  callChrome,
  seedBookmarks,
  visibleTitle,
  type BookmarkNode,
} from './chrome';
import type { ExtensionGlobal } from './extensionGlobal';
import { firstSpaceRecoveryUrls, firstUrl, ownedTabCount, restorationState, secondUrl } from './restoration';
import { selectSpace } from './sidebar';
import { browserTab, createTab, currentWindowId, queryTabs, tabOwnershipSummary } from './tabs';

const sessionValues = (worker: Worker, keys: string | string[]) =>
  callChrome<Record<string, unknown>>(worker, 'storage.session.get', keys);

export async function waitForTabSpaceGroup(
  worker: Worker,
  tabId: number,
  spaceId: string,
): Promise<void> {
  const { windowId } = await browserTab(worker, tabId);
  if (windowId === undefined) throw new Error('The routed tab has no window');
  const groupKey = spaceGroupKey(spaceId, windowId);

  await expect.poll(async () => {
    const [tab, stored] = await Promise.all([browserTab(worker, tabId), sessionValues(worker, groupKey)]);
    const claimed = typeof tab.groupId === 'number' && tab.groupId >= 0 &&
      stored[groupKey] === tab.groupId;
    return claimed
      ? 'claimed'
      : `tab=${String(tab.groupId)} stored=${String(stored[groupKey])}`;
  }, { timeout: 20_000 }).toBe('claimed');
  await waitForActivationQuiescence(worker);
}

export async function routeTabThroughGroupChange(
  worker: Worker,
  tabId: number,
  spaceId: string,
): Promise<void> {
  await worker.evaluate(async ({ spaceId, tabId }) => {
    const extension = globalThis as unknown as ExtensionGlobal;
    const ownership = { spaceId };
    await extension.chrome.sessions?.setTabValue?.(tabId, 'hyperSpaceId', ownership);
    await extension.chrome.storage.session.set({ [`tabSpaceId:${tabId}`]: ownership });
    await extension.chrome.tabs.group({ tabIds: tabId });
  }, { spaceId, tabId });
  await waitForTabSpaceGroup(worker, tabId, spaceId);
}

export interface HyperFixture {
  firstSpaceId: string;
  secondSpaceId: string;
  windowId: number;
}

async function spacesFolder(worker: Worker): Promise<BookmarkNode | undefined> {
  const hyper = (await allBookmarks(worker)).find((node) => visibleTitle(node.title) === 'hyper');
  return hyper?.children?.find((node) => visibleTitle(node.title) === 'spaces');
}

export async function createSecondSpace(worker: Worker): Promise<HyperFixture> {
  const spaces = await spacesFolder(worker);
  const firstSpaceId = spaces?.children?.find((node) => visibleTitle(node.title) !== 'tabs')?.id;
  const windowId = await currentWindowId(worker);
  if (!spaces || !firstSpaceId) {
    throw new Error('Hyper did not initialize its first space and current window');
  }
  const { secondSpaceId } = await seedBookmarks<'secondSpaceId'>(worker, [
    { key: 'secondSpaceId', title: 'Second space' },
  ], spaces.id);
  return { firstSpaceId, secondSpaceId, windowId };
}

export async function createExtraSpaces(worker: Worker, count: number): Promise<void> {
  const spaces = await spacesFolder(worker);
  if (!spaces) throw new Error('Hyper spaces were not initialized');
  await seedBookmarks(worker, Array.from({ length: count }, (_, index) => ({
    title: `Overflow space ${index + 1}`,
  })), spaces.id);
}

/** The stored native group of each space in the window, by space ID. */
async function spaceGroupIds(worker: Worker, windowId: number, spaceIds: readonly string[]): Promise<Map<string, unknown>> {
  const keys = spaceIds.map((spaceId) => spaceGroupKey(spaceId, windowId));
  const stored = await sessionValues(worker, keys);
  return new Map(spaceIds.map((spaceId, index) => [spaceId, stored[keys[index]!]]));
}

export async function spaceAndGroupOrder(
  worker: Worker,
  fixture: HyperFixture,
): Promise<{ groupSpaceIds: string[]; spaceIds: string[] }> {
  const { firstSpaceId, secondSpaceId, windowId } = fixture;
  const spaceIds = (await spacesFolder(worker))?.children?.map((space) => space.id) ?? [];
  const spaceIdByGroupId = new Map([...await spaceGroupIds(worker, windowId, [firstSpaceId, secondSpaceId])]
    .flatMap(([spaceId, groupId]) => typeof groupId === 'number' ? [[groupId, spaceId] as const] : []));
  const firstIndexByGroupId = new Map<number, number>();
  for (const tab of await queryTabs(worker, { windowId })) {
    if (!spaceIdByGroupId.has(tab.groupId)) continue;
    const current = firstIndexByGroupId.get(tab.groupId);
    if (current === undefined || tab.index < current) {
      firstIndexByGroupId.set(tab.groupId, tab.index);
    }
  }
  return {
    groupSpaceIds: [...firstIndexByGroupId]
      .sort((left, right) => left[1] - right[1])
      .map(([groupId]) => spaceIdByGroupId.get(groupId) as string),
    spaceIds,
  };
}

export async function moveSpaceGroupBefore(
  worker: Worker,
  fixture: HyperFixture,
  sourceSpaceId: string,
  targetSpaceId: string,
): Promise<void> {
  const { windowId } = fixture;
  const groups = await spaceGroupIds(worker, windowId, [sourceSpaceId, targetSpaceId]);
  const sourceGroupId = groups.get(sourceSpaceId);
  const targetGroupId = groups.get(targetSpaceId);
  if (typeof sourceGroupId !== 'number' || typeof targetGroupId !== 'number') {
    throw new Error('The owned native groups were not ready.');
  }
  const tabs = await queryTabs(worker, { windowId });
  const targetIndex = Math.min(...tabs.flatMap((tab) =>
    tab.groupId === targetGroupId ? [tab.index] : []));
  if (!Number.isFinite(targetIndex)) throw new Error('The target group was empty.');
  await callChrome(worker, 'tabGroups.move', sourceGroupId, { index: targetIndex });
}

export async function spaceIdByTitle(worker: Worker, title: string): Promise<string | undefined> {
  return (await allBookmarks(worker)).find((node) => visibleTitle(node.title) === title)?.id;
}

export async function spaceLastActiveTabToken(
  worker: Worker,
  spaceId: string,
  windowId?: number,
): Promise<string | undefined> {
  const title = await bookmarkTitle(worker, spaceId);
  return title === undefined ? undefined : lastActiveTabTokenIn({ title }, windowId);
}

export async function setSpaceLastActiveTabToken(
  worker: Worker,
  spaceId: string,
  token: string,
  windowId?: number,
): Promise<void> {
  const title = await bookmarkTitle(worker, spaceId);
  if (title === undefined) throw new Error('The requested space was not found.');
  await callChrome(worker, 'bookmarks.update', spaceId, {
    title: spaceBookmarkTitleWithLastActiveTabToken({ title }, token, windowId),
  });
}

/** Opens a tab in Space 1, creates Second space and opens a tab there, leaving Second space shown. */
export async function createTwoSpacesWithTabs(page: Page, worker: Worker): Promise<{
  firstTabId: number;
  fixture: HyperFixture;
  secondTabId: number;
}> {
  const firstTabId = await createTab(worker, firstUrl);
  await expect.poll(() => tabOwnershipSummary(worker, [firstTabId]))
    .toEqual({ allOwned: true, spaceCount: 1 });
  const fixture = await createSecondSpace(worker);
  await selectSpace(page, 'Second space');
  const secondTabId = await createTab(worker, secondUrl);
  await expect.poll(() => tabOwnershipSummary(worker, [firstTabId, secondTabId]))
    .toEqual({ allOwned: true, spaceCount: 2 });
  return { firstTabId, fixture, secondTabId };
}


/** Opens the first space's recovery tabs, then creates Second space once Space 1 owns them all. */
export async function createSecondSpaceAfterRecoveryTabs(worker: Worker): Promise<HyperFixture> {
  for (const url of firstSpaceRecoveryUrls) await createTab(worker, url);
  const fixture = await createSecondSpace(worker);
  await expect.poll(async () => ownedTabCount(
    await restorationState(worker, fixture),
    firstSpaceRecoveryUrls,
    fixture.firstSpaceId,
  ), { timeout: 30_000 }).toBe(firstSpaceRecoveryUrls.length);
  return fixture;
}
