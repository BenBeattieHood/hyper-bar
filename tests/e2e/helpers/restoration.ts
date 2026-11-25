import { expect, type Worker } from '@playwright/test';
import { parseBookmarkTitle, serializeBookmarkTitle } from '../../../entrypoints/lib/bookmarks';
import { allBookmarks, callChrome, type BookmarkNode } from './chrome';
import type { HyperFixture } from './spaces';
import { tabUrl as pendingOrCommittedUrl } from '../../../entrypoints/lib/urlIdentity';
import { queryTabs, tabOwnership, type TabOwnership } from './tabs';

const hyperMetadata = (title: string) =>
  parseBookmarkTitle(title).metadata.hyper as Record<string, unknown> | undefined;

export interface RestorationState {
  backingsBySpace: Record<string, number>;
  groups: Array<{ collapsed: boolean; id: number; title?: string }>;
  tabs: Array<{
    active: boolean;
    discarded: boolean;
    groupId: number;
    id?: number;
    ownership?: TabOwnership;
    pendingUrl?: string;
    url?: string;
  }>;
}

export interface NativeTabBackingState {
  backing?: {
    id: string;
    spaceId?: string;
    token?: string;
    windowId?: number;
  };
  matchingTabIds: number[];
  ownership?: TabOwnership;
  tab?: { groupId: number; id: number; index: number; windowId: number };
}

export const firstUrl = 'https://space-race.test/first';

export const secondUrl = 'https://space-race.test/second';

export const audibleUrl = 'https://space-race.test/audible';

export const firstSpaceRecoveryUrls = [
  firstUrl,
  'https://space-race.test/first-two',
  'https://space-race.test/first-three',
  'https://space-race.test/first-four',
] as const;

export const secondSpaceRecoveryUrls = [
  secondUrl,
  'https://space-race.test/second-two',
  'https://space-race.test/second-three',
  'https://space-race.test/second-four',
] as const;

export const recoveryUrls = [...firstSpaceRecoveryUrls, ...secondSpaceRecoveryUrls];

export const bookmarkOnlyRecoveryUrl = 'https://space-race.test/bookmark-only-recovery';

export const safeLinksUrl = [
  'https://teams.public.onecdn.static.microsoft',
  '/evergreen-assets/safelinks/2/atp-safelinks.html',
].join('');

export async function createBookmarkOnlyBacking(
  worker: Worker,
  templateUrl: string,
  url: string,
): Promise<void> {
  const template = (await allBookmarks(worker)).find((node) => node.url === templateUrl);
  if (!template?.parentId) throw new Error('The backing template was not found.');
  const parsed = parseBookmarkTitle(template.title);
  const hyper = parsed.metadata.hyper as Record<string, unknown>;
  const title = serializeBookmarkTitle('Bookmark-only recovery', {
    ...parsed.metadata,
    hyper: {
      ...hyper,
      tabIndex: 99,
      tabToken: 'bookmark-only-recovery-token',
    },
  });
  await callChrome(worker, 'bookmarks.create', { parentId: template.parentId, title, url });
}

export async function restorationState(worker: Worker, fixture: HyperFixture): Promise<RestorationState> {
  const { firstSpaceId, secondSpaceId, windowId } = fixture;
  const treeNodes = await allBookmarks(worker);
  const backingsBySpace = Object.fromEntries([firstSpaceId, secondSpaceId].map((spaceId) => [
    spaceId,
    treeNodes.filter((node) => {
      const hyper = hyperMetadata(node.title);
      return node.url && hyper?.tab === true && hyper.spaceId === spaceId &&
        hyper.windowId === windowId;
    }).length,
  ]));
  const tabs = await queryTabs(worker, { windowId });
  const ownership = await tabOwnership(worker, tabs.flatMap((tab) => tab.id === undefined ? [] : [tab.id]));
  let ownedIndex = 0;
  return {
    backingsBySpace,
    groups: await callChrome(worker, 'tabGroups.query', { windowId }),
    tabs: tabs.map((tab) => tab.id === undefined
      ? { ...tab, url: pendingOrCommittedUrl(tab) }
      : {
          active: tab.active,
          discarded: tab.discarded,
          groupId: tab.groupId,
          id: tab.id,
          ownership: ownership[ownedIndex++],
          pendingUrl: tab.pendingUrl,
          url: tab.url,
        }),
  };
}

export async function nativeTabBackingState(
  worker: Worker,
  tabId: number,
  url: string,
  backingId?: string,
): Promise<NativeTabBackingState> {
  const [ownership] = await tabOwnership(worker, [tabId]);
  const resolvedBackingId = backingId ?? ownership?.backingId;
  const [backing] = resolvedBackingId
    ? await callChrome<BookmarkNode[]>(worker, 'bookmarks.get', resolvedBackingId).catch(() => [])
    : [];
  const tabs = await queryTabs(worker);
  const tab = tabs.find((candidate) => candidate.id === tabId);
  const hyper = backing ? hyperMetadata(backing.title) : undefined;
  return {
    ...(backing
      ? {
          backing: {
            id: backing.id,
            ...(typeof hyper?.spaceId === 'string' ? { spaceId: hyper.spaceId } : {}),
            ...(typeof hyper?.tabToken === 'string' ? { token: hyper.tabToken } : {}),
            ...(typeof hyper?.windowId === 'number' ? { windowId: hyper.windowId } : {}),
          },
        }
      : {}),
    matchingTabIds: tabs.flatMap((candidate) =>
      pendingOrCommittedUrl(candidate) === url && candidate.id !== undefined ? [candidate.id] : []),
    ...(ownership ? { ownership } : {}),
    ...(tab?.id !== undefined
      ? {
          tab: {
            groupId: tab.groupId,
            id: tab.id,
            index: tab.index,
            windowId: tab.windowId,
          },
        }
      : {}),
  };
}

export function recoveryTargetCounts(
  state: RestorationState,
  urls: readonly string[] = recoveryUrls,
): Record<string, number> {
  return Object.fromEntries(urls.map((url) => [
    url,
    state.tabs.filter((tab) => pendingOrCommittedUrl(tab) === url).length,
  ]));
}

export function targetCounts(state: RestorationState): Record<string, number> {
  return recoveryTargetCounts(state, [firstUrl, secondUrl]);
}

/** Backings per space and open tabs per URL, which every restoration race must keep at one each. */
export async function restorationCounts(
  worker: Worker,
  fixture: HyperFixture,
  counts: (state: RestorationState) => Record<string, number> = targetCounts,
): Promise<{ backings: Record<string, number>; tabs: Record<string, number> }> {
  const state = await restorationState(worker, fixture);
  return { backings: state.backingsBySpace, tabs: counts(state) };
}

/** Tabs at one of `urls` that are owned by `spaceId`. */
export function ownedTabCount(
  state: RestorationState,
  urls: readonly string[],
  spaceId: string,
): number {
  return state.tabs.filter((tab) =>
    urls.includes(pendingOrCommittedUrl(tab) as string) &&
    tab.ownership?.spaceId === spaceId).length;
}

export function recoveryTabSignature(
  state: RestorationState,
  urls: readonly string[] = recoveryUrls,
): string {
  return JSON.stringify(state.tabs.flatMap((tab) => {
    const url = pendingOrCommittedUrl(tab);
    return url && urls.includes(url)
      ? [{
          groupId: tab.groupId,
          id: tab.id,
          spaceId: tab.ownership?.spaceId,
          url,
        }]
      : [];
  }).sort((left, right) => left.url.localeCompare(right.url)));
}

export function expectActiveTabInSpace(state: RestorationState, spaceId: string): void {
  const activeTab = state.tabs.find((tab) => tab.active);
  expect(activeTab?.ownership?.spaceId).toBe(spaceId);
  expect(activeTab?.groupId).toBeGreaterThanOrEqual(0);
}
