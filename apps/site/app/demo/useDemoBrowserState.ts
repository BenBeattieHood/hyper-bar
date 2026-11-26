'use client';

import { useMemo, useState } from 'react';
import {
  bookmarkTitleWithFavouriteSlot,
  bookmarkTitleWithHyper,
  defaultHyperPreferences,
  noBrowserCommandCapabilities,
  tabBackingBookmarkTitle,
  type BookmarkNode,
  type BrowserStateApi,
  type BrowserTab,
} from 'hyper-sidebar/demo';

type SpaceSeed = {
  id: string;
  title: string;
  colour: 'blue' | 'green' | 'orange' | 'purple';
  bookmarks: Array<{ id: string; title: string; url: string }>;
  tabs: Array<{ id: number; title: string; url: string; active?: boolean; loading?: boolean }>;
};

const WINDOW_ID = 1;
const INSTALLATION_ID = 'website-demo';
const DEMO_COLOURS = {
  blue: 'blue',
  green: 'green',
  orange: 'orange',
  purple: 'purple',
} as const;

const seeds: SpaceSeed[] = [
  {
    id: 'space-research',
    title: 'Research',
    colour: DEMO_COLOURS.purple,
    tabs: [
      { id: 101, title: 'Hyper product notes', url: 'https://hyper.local/notes', active: true },
      { id: 102, title: 'Browser context patterns', url: 'https://patterns.local/context' },
      { id: 103, title: 'Spatial interface references', url: 'https://references.local/spatial' },
    ],
    bookmarks: [
      { id: 'bookmark-research-decisions', title: 'Architecture decisions', url: 'https://hyper.local/decisions' },
      { id: 'bookmark-research-wishlist', title: 'Interaction wishlist', url: 'https://hyper.local/wishlist' },
    ],
  },
  {
    id: 'space-build',
    title: 'Build',
    colour: DEMO_COLOURS.green,
    tabs: [
      { id: 201, title: 'Extension source', url: 'https://github.local/hyper-bar' },
      { id: 202, title: 'Pull request #184', url: 'https://github.local/hyper-bar/pull/184' },
      { id: 203, title: 'Live test run', url: 'https://ci.local/run/184', loading: true },
    ],
    bookmarks: [
      { id: 'bookmark-build-release', title: 'Release checklist', url: 'https://hyper.local/release' },
      { id: 'bookmark-build-api', title: 'Browser API reference', url: 'https://developer.chrome.local/api' },
    ],
  },
  {
    id: 'space-personal',
    title: 'Personal',
    colour: DEMO_COLOURS.orange,
    tabs: [
      { id: 301, title: 'Weekend reading list', url: 'https://reading.local/weekend' },
      { id: 302, title: 'Kitchen playlist', url: 'https://music.local/kitchen' },
    ],
    bookmarks: [
      { id: 'bookmark-personal-recipes', title: 'Saved recipes', url: 'https://recipes.local/favourites' },
      { id: 'bookmark-personal-trip', title: 'Trip research', url: 'https://travel.local/next-trip' },
    ],
  },
];

function faviconDataUri(label: string, colour: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="${colour}"/><text x="16" y="20" text-anchor="middle" font-family="system-ui" font-size="13" font-weight="700" fill="white">${label}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function pageNode(
  id: string,
  parentId: string,
  index: number,
  title: string,
  url: string,
): BookmarkNode {
  return { id, index, parentId, title, url, syncing: false };
}

function createBookmarkTree(): BookmarkNode[] {
  const favourites = [
    pageNode('favourite-docs', 'hyper-favourites', 0, 'Hyper docs', 'https://hyper.local/docs'),
    pageNode('favourite-github', 'hyper-favourites', 1, 'GitHub', 'https://github.local'),
    pageNode('favourite-linear', 'hyper-favourites', 2, 'Project board', 'https://linear.local/board'),
  ].map((node, index) => ({ ...node, title: bookmarkTitleWithFavouriteSlot(node, index) }));

  const spaces = seeds.map((space, spaceIndex): BookmarkNode => {
    const tabsRootId = `${space.id}-tabs`;
    const bookmarksRootId = `${space.id}-bookmarks`;
    const backings = space.tabs.map((tab, index) => ({
      ...pageNode(
        `backing-${tab.id}`,
        tabsRootId,
        index,
        tabBackingBookmarkTitle(
          tab.title,
          index,
          `token-${tab.id}`,
          space.id,
          undefined,
          { installationId: INSTALLATION_ID, windowId: WINDOW_ID },
        ),
        tab.url,
      ),
    }));
    return {
      id: space.id,
      index: spaceIndex,
      parentId: 'hyper-spaces',
      syncing: false,
      title: space.title,
      children: [
        {
          id: tabsRootId,
          index: 0,
          parentId: space.id,
          syncing: false,
          title: bookmarkTitleWithHyper('tabs', { spaceTabs: true }),
          children: backings,
        },
        {
          id: bookmarksRootId,
          index: 1,
          parentId: space.id,
          syncing: false,
          title: bookmarkTitleWithHyper('bookmarks', { spaceBookmarks: true }),
          children: space.bookmarks.map((bookmark, index) => pageNode(
            bookmark.id,
            bookmarksRootId,
            index,
            bookmark.title,
            bookmark.url,
          )),
        },
      ],
    };
  });

  const bookmarkBar: BookmarkNode = {
    id: '1',
    title: 'Bookmarks bar',
    syncing: false,
    children: [
      {
        id: 'hyper-root',
        index: 0,
        parentId: '1',
        syncing: false,
        title: 'hyper',
        children: [
          {
            id: 'hyper-favourites',
            index: 0,
            parentId: 'hyper-root',
            syncing: false,
            title: 'favourites',
            children: favourites,
          },
          {
            id: 'hyper-bookmarks',
            index: 1,
            parentId: 'hyper-root',
            syncing: false,
            title: 'bookmarks',
            children: [pageNode('global-reference', 'hyper-bookmarks', 0, 'Quick reference', 'https://hyper.local/reference')],
          },
          {
            id: 'hyper-spaces',
            index: 2,
            parentId: 'hyper-root',
            syncing: false,
            title: 'spaces',
            children: spaces,
          },
        ],
      },
    ],
  };
  return [{ id: '0', title: 'Bookmarks', syncing: false, children: [bookmarkBar] }];
}

function createTabs(): BrowserTab[] {
  return seeds.flatMap((space, spaceIndex) => space.tabs.map((tab, tabIndex) => ({
    id: tab.id,
    index: tabIndex,
    windowId: WINDOW_ID,
    groupId: 10 + spaceIndex,
    active: tab.active ?? false,
    highlighted: tab.active ?? false,
    pinned: false,
    incognito: false,
    audible: space.id === 'space-personal' && tab.id === 302,
    favIconUrl: faviconDataUri(tab.title.slice(0, 2), space.colour === 'green' ? '#1b8f78' : space.colour === 'purple' ? '#7c5ce7' : '#d06a42'),
    status: tab.loading ? 'loading' : 'complete',
    title: tab.title,
    url: tab.url,
  } as BrowserTab)));
}

function updateNode(
  nodes: BookmarkNode[],
  id: string,
  updater: (node: BookmarkNode) => BookmarkNode,
): BookmarkNode[] {
  return nodes.map((node) => node.id === id
    ? updater(node)
    : node.children
      ? { ...node, children: updateNode(node.children, id, updater) }
      : node);
}

function findNode(nodes: BookmarkNode[], id: string): BookmarkNode | undefined {
  for (const node of nodes) {
    if (node.id === id) return node;
    const child = findNode(node.children ?? [], id);
    if (child) return child;
  }
  return undefined;
}

function removeNode(nodes: BookmarkNode[], id: string): BookmarkNode[] {
  return nodes.flatMap((node) => node.id === id
    ? []
    : [{ ...node, ...(node.children ? { children: removeNode(node.children, id) } : {}) }]);
}

const unsupported = async (): Promise<void> => undefined;
const unavailable = async (): Promise<boolean> => false;

export function useDemoBrowserState(): BrowserStateApi {
  const [bookmarkTree, setBookmarkTree] = useState<BookmarkNode[]>(createBookmarkTree);
  const [tabs, setTabs] = useState<BrowserTab[]>(createTabs);
  const [activeSpaceId, setActiveSpaceIdValue] = useState(seeds[0].id);
  const [preferences, setPreferences] = useState({ ...defaultHyperPreferences });
  const [modelRevision, setModelRevision] = useState(1);
  const [notice, setNotice] = useState<BrowserStateApi['timedMessage']>();

  const tabSpaceIds = useMemo(() => Object.fromEntries(seeds.flatMap((space) => space.tabs.map((tab) => [tab.id, space.id]))), []);
  const tabBackingIds = useMemo(() => Object.fromEntries(seeds.flatMap((space) => space.tabs.map((tab) => [tab.id, `backing-${tab.id}`]))), []);
  const spaceGroupIds = useMemo(() => Object.fromEntries(seeds.map((space, index) => [space.id, 10 + index])), []);
  const spaceColours = useMemo(() => Object.fromEntries(seeds.map((space) => [space.id, space.colour])), []);

  const commit = () => setModelRevision((revision) => revision + 1);
  const runBackingOperation = async <Result>(operation: () => Promise<Result>) => operation();
  const setActiveSpaceId = async (spaceId: string) => {
    setActiveSpaceIdValue(spaceId);
    setTabs((current) => current.map((tab) => ({
      ...tab,
      active: tabSpaceIds[tab.id ?? -1] === spaceId && tab.index === 0,
      highlighted: tabSpaceIds[tab.id ?? -1] === spaceId && tab.index === 0,
    })));
    commit();
    return true;
  };
  const closeTabs = async (tabIds: readonly number[]) => {
    const closing = new Set(tabIds);
    setTabs((current) => current.filter((tab) => tab.id === undefined || !closing.has(tab.id)));
    commit();
  };
  const focusTab = async (tab: BrowserTab) => {
    if (tab.id === undefined) return;
    setTabs((current) => current.map((candidate) => ({
      ...candidate,
      active: candidate.id === tab.id,
      highlighted: candidate.id === tab.id,
    })));
    commit();
  };
  const updateBookmark = async (id: string, title: string) => {
    setBookmarkTree((current) => updateNode(current, id, (node) => ({ ...node, title })));
    commit();
  };
  const openBookmark = async (
    url: string,
    options: { activate?: boolean; destinationSpaceId?: string | null; forceNew?: boolean; reuse?: 'browser' | 'space' | 'window' } = {},
  ) => {
    const destinationSpaceId = options.destinationSpaceId ?? activeSpaceId;
    const nextId = 1000 + Math.floor(Math.random() * 100000);
    const node = (() => {
      const visit = (nodes: BookmarkNode[]): BookmarkNode | undefined => {
        for (const current of nodes) {
          if (current.url === url) return current;
          const child = visit(current.children ?? []);
          if (child) return child;
        }
        return undefined;
      };
      return visit(bookmarkTree);
    })();
    const title = node?.title ?? new URL(url).hostname;
    const tab = {
      id: nextId,
      index: tabs.length,
      windowId: WINDOW_ID,
      groupId: spaceGroupIds[destinationSpaceId] ?? 10,
      active: options.activate ?? true,
      highlighted: options.activate ?? true,
      pinned: false,
      incognito: false,
      favIconUrl: faviconDataUri(title.slice(0, 2), '#5c8497'),
      status: 'complete',
      title,
      url,
    } as BrowserTab;
    setTabs((current) => [...current.map((candidate) => ({ ...candidate, active: false, highlighted: false })), tab]);
    const tabsRootId = `${destinationSpaceId}-tabs`;
    setBookmarkTree((current) => updateNode(current, tabsRootId, (folder) => ({
      ...folder,
      children: [...(folder.children ?? []), pageNode(
        `backing-${nextId}`,
        tabsRootId,
        folder.children?.length ?? 0,
        tabBackingBookmarkTitle(title, tabs.length, `token-${nextId}`, destinationSpaceId, undefined, { installationId: INSTALLATION_ID, windowId: WINDOW_ID }),
        url,
      )],
    })));
    commit();
    return tab;
  };

  const state = {
    activeGroupId: spaceGroupIds[activeSpaceId] ?? null,
    activeSpaceId,
    backgroundMusicTabIds: [],
    bookmarkImportInProgress: false,
    bookmarkTree,
    commandCapabilities: noBrowserCommandCapabilities,
    currentWindowFocused: true,
    currentWindowId: WINDOW_ID,
    currentWindowIncognito: false,
    pendingBackingOperations: 0,
    favouriteIds: findNode(bookmarkTree, 'hyper-favourites')?.children?.map((node: BookmarkNode) => node.id) ?? [],
    favouritesFolderId: 'hyper-favourites',
    globalBookmarksFolderId: 'hyper-bookmarks',
    installationId: INSTALLATION_ID,
    isBackingOperationPending: false,
    isLoading: false,
    error: null,
    mediaControlAvailable: false,
    modelRevision,
    preferences,
    recentlyClosedTabs: [],
    remoteSpacePresence: { bookmarkSpaceIds: {}, otherWindowTabCounts: {}, tabSpaceIds: {} },
    sharedDrag: null,
    spaceColours,
    spaceGroupIds,
    spacesFolderId: 'hyper-spaces',
    tabBackingIds,
    tabBookmarkLinks: {},
    tabNames: {},
    tabTitles: {},
    tabSpaceIds,
    tabs,
    timedMessage: notice,
    runBackingOperation,
    setFavouriteSlot: unsupported,
    setActiveSpaceId,
    moveBookmark: unsupported,
    copyBookmark: unsupported,
    importBookmarkFolder: unsupported,
    moveBookmarkByOffset: unsupported,
    addCurrentPage: async (parentId: string) => {
      const node = pageNode(`created-${Date.now()}`, parentId, 0, 'Current page', 'https://hyper.local/demo');
      setBookmarkTree((current) => updateNode(current, parentId, (folder) => ({ ...folder, children: [...(folder.children ?? []), node] })));
      commit();
      return { created: true, node };
    },
    createFolder: async (parentId: string) => {
      const node: BookmarkNode = { id: `folder-${Date.now()}`, parentId, index: 0, title: 'New folder', syncing: false, children: [] };
      setBookmarkTree((current) => updateNode(current, parentId, (folder) => ({ ...folder, children: [...(folder.children ?? []), node] })));
      commit();
      return node;
    },
    createTabFolder: async (spaceId: string) => pageNode(`folder-${Date.now()}`, `${spaceId}-tabs`, 0, 'New folder', ''),
    renameTabFolder: unavailable,
    removeTabFolder: unavailable,
    submitSelection: async () => [],
    moveTabTreeNode: unavailable,
    setPreference: async <Key extends keyof typeof preferences>(key: Key, value: typeof preferences[Key]) => {
      setPreferences((current) => ({ ...current, [key]: value }));
      commit();
      return true;
    },
    closeSpaceTabs: async (spaceId: string) => closeTabs(tabs.filter((tab) => tab.id !== undefined && tabSpaceIds[tab.id] === spaceId).map((tab) => tab.id as number)),
    createSpace: async () => {
      const id = `space-${Date.now()}`;
      const node: BookmarkNode = { id, parentId: 'hyper-spaces', index: seeds.length, title: 'New space', syncing: false, children: [] };
      setBookmarkTree((current) => updateNode(current, 'hyper-spaces', (folder) => ({ ...folder, children: [...(folder.children ?? []), node] })));
      commit();
      return node;
    },
    duplicateSpace: async (spaceId: string) => findNode(bookmarkTree, spaceId)!,
    reloadSpaceTabs: unsupported,
    setSpaceArchived: unsupported,
    addTabBookmark: async (rootId: string, tabId: number) => {
      const tab = tabs.find((candidate) => candidate.id === tabId);
      if (!tab) throw new Error('This tab is no longer available.');
      const node = pageNode(`bookmark-${tabId}`, rootId, 0, tab.title ?? 'New bookmark', tab.url ?? '');
      setBookmarkTree((current) => updateNode(current, rootId, (folder) => ({ ...folder, children: [...(folder.children ?? []), node] })));
      commit();
      return { created: true, node };
    },
    groupTabsInSpace: unsupported,
    focusTab,
    closeTabsInSpace: unsupported,
    focusRemoteTab: unsupported,
    moveRemoteTabToWindow: unsupported,
    offerDrag: unsupported,
    takeSharedDragTabs: unsupported,
    moveTabsIntoTree: unsupported,
    withdrawDrag: unsupported,
    splitTab: unsupported,
    navigateTab: async (tabId: number, target: string | { kind: 'search'; query: string }) => {
      const url = typeof target === 'string' ? target : `https://search.example/?q=${encodeURIComponent(target.query)}`;
      setTabs((current) => current.map((tab) => tab.id === tabId ? { ...tab, url, pendingUrl: url, title: url, status: 'loading' } : tab));
      commit();
    },
    closeTab: async (tabId: number) => closeTabs([tabId]),
    closeTabs,
    reloadTabs: unsupported,
    createTab: async () => openBookmark('https://hyper.local/new-tab', { destinationSpaceId: activeSpaceId }),
    searchInNewTab: async (query: string) => {
      await openBookmark(`https://search.example/?q=${encodeURIComponent(query)}`, { destinationSpaceId: activeSpaceId });
    },
    setTabMuted: unsupported,
    deleteHistory: unsupported,
    moveTab: unsupported,
    moveTabs: unsupported,
    setTabMediaPlayback: unsupported,
    search: async () => ({ results: [], revision: modelRevision }),
    forgetSearchSelection: unavailable,
    recordSearchSelection: unavailable,
    updateBookmark,
    updateBookmarkUrl: async (id: string, url: string) => {
      setBookmarkTree((current) => updateNode(current, id, (node) => ({ ...node, url })));
      commit();
    },
    removeBookmark: async (node: Pick<BookmarkNode, 'id'>) => {
      setBookmarkTree((current) => removeNode(current, node.id));
      commit();
    },
    openBookmark,
    openFavourite: (url: string) => openBookmark(url),
    duplicateTab: async (tab: BrowserTab) => {
      if (tab.id === undefined) throw new Error('This tab is no longer available.');
      await openBookmark(
        tab.url ?? tab.pendingUrl ?? 'https://hyper.local/new-tab',
        { destinationSpaceId: tabSpaceIds[tab.id], forceNew: true },
      );
    },
    actOnTimedMessage: unavailable,
    dismissTimedMessage: unavailable,
    showMessage: async (text: string, tone: 'info' | 'warning' | 'error') => {
      setNotice({
        durationMs: 5000,
        expiresAt: Date.now() + 5000,
        id: 'demo-notice',
        kind: 'feedback',
        text,
        tone,
      });
      return true;
    },
    renameTab: async (tab: BrowserTab, title: string) => {
      if (tab.id === undefined) return;
      setTabs((current) => current.map((candidate) =>
        candidate.id === tab.id ? { ...candidate, title } : candidate));
      await updateBookmark(`backing-${tab.id}`, title);
    },
    submitBrowserCommand: unsupported,
  };

  return state as unknown as BrowserStateApi;
}
