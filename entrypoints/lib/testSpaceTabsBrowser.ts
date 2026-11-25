import { vi } from 'vitest';
import { tabBackingBookmarkTitle, tabFolderBookmarkTitle, visibleBookmarkTitle, type BookmarkNode, type BrowserTab } from './bookmarks';
import { ensureSpaceTabsFolder } from './bookmarkStorage';
import { createBookmarkTree, type BookmarkSpec } from './testBookmarkTree';
import { testTab } from './testFixtures';
import { getTabOwnership, loadTabOwnerships, type TabOwnership } from './tabOwnership';
import type { TimedOffer } from './timedMessages';
import { getWindowActiveSpaceId } from './windowState';

// A test using this helper mocks `ensureSpaceTabsFolder` in './bookmarkStorage',
// `getTabOwnership` and `loadTabOwnerships` in './tabOwnership', and
// `getWindowActiveSpaceId` in './windowState'.

export const NEW_TAB = 'chrome-extension://hyper/newtab.html';
/** A bookmark backing whose id, title and URL all derive from `id`. */
const backing = (id: string): BookmarkSpec => ({
  id,
  title: tabBackingBookmarkTitle(`Page ${id}`),
  url: `https://example.test/${id}`,
});

/** A tab and the space it is in, with the backing it shows when it has one. */
export interface TabSpec {
  active?: boolean;
  backingId?: string;
  discarded?: boolean;
  frozen?: boolean;
  id: number;
  pinned?: boolean;
  spaceId?: string;
  status?: BrowserTab['status'];
  url?: string;
  windowId?: number;
}

/**
 * A browser of a few windows and the spaces their tabs are in, with Hyper's
 * own effects as the background makes them: closing a tab releases its backing,
 * and restoring a space opens a tab for each backing no live tab claims.
 */
export function installSpaceTabsBrowser(specs: TabSpec[], shownSpaceId = 'work') {
  // Every backing a window shows has its tab; one without would be reopened by any restore.
  const open = new Set(specs.flatMap((spec) => spec.backingId ? [spec.backingId] : []));
  const backings = (...ids: string[]) => ids.filter((id) => open.has(id)).map(backing);
  const tree = createBookmarkTree({
    children: [
      {
        children: [
          ...backings('a'),
          { children: backings('b'), id: 'research', title: tabFolderBookmarkTitle('Research') },
          ...backings('c'),
        ],
        id: 'work-tabs',
        title: 'tabs',
      },
      { children: backings('h'), id: 'home-tabs', title: 'tabs' },
    ],
    id: 'root',
    title: '',
  });
  const tabs = specs.map((spec, index) => testTab({
    active: spec.active ?? false,
    discarded: spec.discarded ?? false,
    frozen: spec.frozen ?? false,
    id: spec.id,
    index,
    pinned: spec.pinned ?? false,
    status: spec.status ?? 'complete',
    title: spec.backingId ? `Page ${spec.backingId}` : 'New tab',
    url: spec.url ?? (spec.backingId ? `https://example.test/${spec.backingId}` : NEW_TAB),
    windowId: spec.windowId ?? 3,
  }));
  const ownerships: Record<number, TabOwnership> = Object.fromEntries(specs.flatMap((spec) => spec.spaceId
    ? [[spec.id, { spaceId: spec.spaceId, ...(spec.backingId ? { backingId: spec.backingId } : {}) }]]
    : []));
  let nextTabId = 100;
  const live = (tabId: number) => {
    const tab = tabs.find((candidate) => candidate.id === tabId);
    if (!tab) throw new Error(`No tab with id: ${tabId}.`);
    return tab;
  };
  const activate = (tab: Browser.tabs.Tab) => {
    for (const other of tabs) if (other.windowId === tab.windowId) other.active = other === tab;
  };
  const openTab = (details: { active?: boolean; title?: string; url?: string; windowId: number }) => {
    const tab = testTab({
      id: nextTabId++,
      index: tabs.length,
      title: details.title ?? 'New tab',
      url: details.url ?? NEW_TAB,
      windowId: details.windowId,
    });
    tabs.push(tab);
    if (details.active) activate(tab);
    return tab;
  };
  const close = (tabId: number) => {
    tabs.splice(tabs.indexOf(live(tabId)), 1);
    const backingId = ownerships[tabId]?.backingId;
    delete ownerships[tabId];
    if (backingId && tree.has(backingId)) void tree.api.remove(backingId);
  };
  vi.stubGlobal('browser', {
    bookmarks: tree.api,
    runtime: { getURL: (path: string) => `chrome-extension://hyper${path}` },
    tabs: {
      create: vi.fn(async (details: { active?: boolean; windowId: number }) => ({ ...openTab(details) })),
      get: vi.fn(async (tabId: number) => ({ ...live(tabId) })),
      query: vi.fn(async ({ windowId }: { windowId: number }) =>
        tabs.filter((tab) => tab.windowId === windowId).map((tab) => ({ ...tab }))),
      reload: vi.fn(async () => undefined),
      remove: vi.fn(async (tabId: number) => close(tabId)),
      update: vi.fn(async (tabId: number, { active, url }: { active?: boolean; url?: string }) => {
        const tab = live(tabId);
        if (url) tab.url = url;
        if (active) activate(tab);
        return { ...tab };
      }),
    },
  });
  vi.mocked(ensureSpaceTabsFolder).mockImplementation(async (spaceId) => tree.node(`${spaceId}-tabs`));
  vi.mocked(getWindowActiveSpaceId).mockResolvedValue(shownSpaceId);
  vi.mocked(getTabOwnership).mockImplementation(async (tabId) => ownerships[tabId]);
  vi.mocked(loadTabOwnerships).mockImplementation(async (windowTabs) => Object.fromEntries(
    windowTabs.flatMap((tab) => tab.id !== undefined && ownerships[tab.id] ? [[tab.id, ownerships[tab.id]!]] : []),
  ));

  const messages = { offer: vi.fn((_windowId: number, _offer: TimedOffer) => 'message') };
  const dependencies = {
    closeTabs: vi.fn(async (tabIds: number[]) => {
      for (const tabId of new Set(tabIds)) close(tabId);
    }),
    markIntentionalTab: vi.fn(),
    messages,
    queueMutation: <Result,>(operation: () => Promise<Result>) => operation(),
    restoreSpaceTabs: vi.fn(async (spaceId: string, windowId: number) => {
      const claimed = new Set(Object.values(ownerships).map((ownership) => ownership.backingId));
      return backingsUnder(tree.subTree(`${spaceId}-tabs`))
        .filter((node) => !claimed.has(node.id))
        .map((node) => {
          const tab = openTab({ title: visibleBookmarkTitle(node), url: node.url, windowId });
          ownerships[tab.id!] = { backingId: node.id, spaceId };
          return tab.id!;
        });
    }),
    routeTab: vi.fn(async (tabId: number, spaceId: string) => {
      ownerships[tabId] = { ...ownerships[tabId], spaceId };
    }),
  };
  /** The window's tabs as their pages, the active one marked. */
  const windowPages = (windowId = 3) => tabs.filter((tab) => tab.windowId === windowId)
    .map((tab) => `${tab.active ? '*' : ''}${tab.url === NEW_TAB ? 'new tab' : tab.url?.replace('https://example.test/', '')}`);
  /** Undoes the close offered last. */
  const undo = async () => {
    const [, offer] = messages.offer.mock.calls.at(-1) ?? [];
    if (!offer) throw new Error('Nothing was offered to undo.');
    await offer.act(new Map());
  };
  return { dependencies, messages, ownerships, tabs, tree, undo, windowPages };
}

/** Every backing under a tab folder, depth first. */
const backingsUnder = (node: BookmarkNode): BookmarkNode[] =>
  (node.children ?? []).flatMap((child) => child.url ? [child] : backingsUnder(child));
