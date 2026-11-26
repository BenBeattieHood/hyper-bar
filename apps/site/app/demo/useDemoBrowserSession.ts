'use client';

import { useMemo, useRef, useState } from 'react';
import {
  bookmarkTitleWithFavouriteSlot,
  bookmarkTitleWithHyper,
  defaultHyperPreferences,
  noBrowserCommandCapabilities,
  tabBackingBookmarkTitle,
  tabFolderBookmarkTitle,
  visibleBookmarkTitle,
  type BookmarkNode,
  type BrowserStateApi,
  type BrowserTab,
  type SearchItem,
  type SharedSearchResult,
} from 'hyper-sidebar/demo';

type Colour = 'blue' | 'green' | 'orange' | 'purple';
type BrowserCapabilities = typeof noBrowserCommandCapabilities;
type DemoNoticeTone = 'error' | 'info' | 'warning';
type DemoResult = SharedSearchResult;
type DemoItem = Record<string, unknown>;

const WINDOW_ID = 1;
const INSTALLATION_ID = 'website-demo';
const COLOURS: Colour[] = ['purple', 'green', 'orange', 'blue'];
const START_URL = 'https://hyper.local/start';

const seedSpaces = [
  {
    id: 'space-research', title: 'Research', colour: 'purple' as Colour,
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
    id: 'space-build', title: 'Build', colour: 'green' as Colour,
    tabs: [
      { id: 201, title: 'Extension source', url: 'https://github.local/hyper-bar' },
      { id: 202, title: 'Pull request #184', url: 'https://github.local/hyper-bar/pull/184' },
      { id: 203, title: 'Live test run', url: 'https://ci.local/run/184' },
    ],
    bookmarks: [
      { id: 'bookmark-build-release', title: 'Release checklist', url: 'https://hyper.local/release' },
      { id: 'bookmark-build-api', title: 'Browser API reference', url: 'https://developer.chrome.local/api' },
    ],
  },
  {
    id: 'space-personal', title: 'Personal', colour: 'orange' as Colour,
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

const nextId = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;
const nextTabId = () => 1_000 + Math.floor(Math.random() * 900_000);
const titleFromUrl = (url: string) => {
  try {
    const parsed = new URL(url);
    return parsed.hostname.replace(/^www\./, '') + (parsed.pathname === '/' ? '' : ` · ${parsed.pathname.split('/').filter(Boolean).at(-1)}`);
  } catch {
    return 'New tab';
  }
};
const normaliseUrl = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed) return START_URL;
  if (/^[a-z][a-z\d+.-]*:/i.test(trimmed)) return trimmed;
  if (trimmed.includes('.') && !trimmed.includes(' ')) return `https://${trimmed}`;
  return `https://search.hyper.local/?q=${encodeURIComponent(trimmed)}`;
};
const faviconDataUri = (title: string, colour = '#7770d9') => {
  const initial = title.trim().slice(0, 1).toUpperCase() || 'H';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="${colour}"/><text x="16" y="20" text-anchor="middle" font-family="system-ui" font-size="14" font-weight="700" fill="white">${initial}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
};
const tab = (id: number, index: number, spaceId: string, groupId: number, title: string, url: string, active = false): BrowserTab => ({
  id, index, windowId: WINDOW_ID, groupId, active, highlighted: active, pinned: false, incognito: false,
  favIconUrl: faviconDataUri(title), status: 'complete', title, url,
} as BrowserTab);
const pageNode = (id: string, parentId: string, index: number, title: string, url?: string, children?: BookmarkNode[]): BookmarkNode => ({
  id, index, parentId, title, syncing: false, ...(url ? { url } : { children: children ?? [] }),
});

function createSpaceNode(id: string, title: string, index: number, tabs: Array<{ id: number; title: string; url: string }>, bookmarks: BookmarkNode[]): BookmarkNode {
  const tabsRootId = `${id}-tabs`;
  const bookmarksRootId = `${id}-bookmarks`;
  return pageNode(id, 'hyper-spaces', index, title, undefined, [
    pageNode(tabsRootId, id, 0, bookmarkTitleWithHyper('tabs', { spaceTabs: true }), undefined,
      tabs.map((entry, childIndex) => pageNode(
        `backing-${entry.id}`, tabsRootId, childIndex,
        tabBackingBookmarkTitle(entry.title, childIndex, `token-${entry.id}`, id, undefined, { installationId: INSTALLATION_ID, windowId: WINDOW_ID }),
        entry.url,
      ))),
    pageNode(bookmarksRootId, id, 1, bookmarkTitleWithHyper('bookmarks', { spaceBookmarks: true }), undefined, bookmarks),
  ]);
}

function createBookmarkTree(): BookmarkNode[] {
  const spaces = seedSpaces.map((space, index) => createSpaceNode(
    space.id,
    space.title,
    index,
    space.tabs,
    space.bookmarks.map((bookmark, bookmarkIndex) => pageNode(bookmark.id, `${space.id}-bookmarks`, bookmarkIndex, bookmark.title, bookmark.url)),
  ));
  const favourites = [
    pageNode('favourite-docs', 'hyper-favourites', 0, 'Hyper docs', 'https://hyper.local/docs'),
    pageNode('favourite-github', 'hyper-favourites', 1, 'GitHub', 'https://github.local'),
    pageNode('favourite-linear', 'hyper-favourites', 2, 'Project board', 'https://linear.local/board'),
  ].map((node, index) => ({ ...node, title: bookmarkTitleWithFavouriteSlot(node, index) }));
  return [{
    id: '0', title: 'Bookmarks', syncing: false,
    children: [{
      id: '1', parentId: '0', index: 0, title: 'Bookmarks bar', syncing: false,
      children: [{
        id: 'hyper-root', parentId: '1', index: 0, title: 'hyper', syncing: false,
        children: [
          pageNode('hyper-favourites', 'hyper-root', 0, 'favourites', undefined, favourites),
          pageNode('hyper-bookmarks', 'hyper-root', 1, 'bookmarks', undefined, [
            pageNode('global-reference', 'hyper-bookmarks', 0, 'Quick reference', 'https://hyper.local/reference'),
          ]),
          pageNode('hyper-spaces', 'hyper-root', 2, 'spaces', undefined, spaces),
        ],
      }],
    }],
  }];
}

function createInitialTabs() {
  return seedSpaces.flatMap((space, spaceIndex) => space.tabs.map((entry, index) =>
    tab(entry.id, index, space.id, 10 + spaceIndex, entry.title, entry.url, Boolean(entry.active))));
}

function visit(nodes: BookmarkNode[], operation: (node: BookmarkNode) => void) {
  for (const node of nodes) {
    operation(node);
    visit(node.children ?? [], operation);
  }
}
function findNode(nodes: BookmarkNode[], id: string): BookmarkNode | undefined {
  for (const node of nodes) {
    if (node.id === id) return node;
    const child = findNode(node.children ?? [], id);
    if (child) return child;
  }
  return undefined;
}
function mapNode(nodes: BookmarkNode[], id: string, update: (node: BookmarkNode) => BookmarkNode): BookmarkNode[] {
  return nodes.map((node) => node.id === id ? update(node) : node.children
    ? { ...node, children: mapNode(node.children, id, update) }
    : node);
}
function removeNode(nodes: BookmarkNode[], id: string): BookmarkNode[] {
  return nodes.flatMap((node) => node.id === id ? [] : [
    node.children ? { ...node, children: removeNode(node.children, id) } : node,
  ]);
}
function insertNode(nodes: BookmarkNode[], parentId: string, node: BookmarkNode, index?: number): BookmarkNode[] {
  return mapNode(nodes, parentId, (parent) => {
    const children = [...(parent.children ?? [])];
    children.splice(index === undefined ? children.length : Math.min(index, children.length), 0, { ...node, parentId });
    return { ...parent, children: children.map((child, childIndex) => ({ ...child, index: childIndex })) };
  });
}
function detachNode(nodes: BookmarkNode[], id: string): { node?: BookmarkNode; tree: BookmarkNode[] } {
  return { node: findNode(nodes, id), tree: removeNode(nodes, id) };
}
function descendants(nodes: BookmarkNode[], id: string): BookmarkNode[] {
  const node = findNode(nodes, id);
  return node?.children ?? [];
}

export function useDemoBrowserSession() {
  const [bookmarkTree, setBookmarkTree] = useState(createBookmarkTree);
  const [tabs, setTabs] = useState(createInitialTabs);
  const [activeSpaceId, setActiveSpaceIdValue] = useState('space-research');
  const [tabSpaceIds, setTabSpaceIds] = useState<Record<number, string>>(() => Object.fromEntries(seedSpaces.flatMap((space) => space.tabs.map((entry) => [entry.id, space.id]))));
  const [tabBackingIds, setTabBackingIds] = useState<Record<number, string>>(() => Object.fromEntries(seedSpaces.flatMap((space) => space.tabs.map((entry) => [entry.id, `backing-${entry.id}`]))));
  const [spaceGroupIds, setSpaceGroupIds] = useState<Record<string, number>>(() => Object.fromEntries(seedSpaces.map((space, index) => [space.id, 10 + index])));
  const [spaceColours, setSpaceColours] = useState<Record<string, Colour>>(() => Object.fromEntries(seedSpaces.map((space) => [space.id, space.colour])));
  const [preferences, setPreferences] = useState({ ...defaultHyperPreferences });
  const [modelRevision, setModelRevision] = useState(1);
  const [recentlyClosedTabs, setRecentlyClosedTabs] = useState<Array<{ favIconUrl?: string; sessionId: string; title: string; url: string }>>([]);
  const [notice, setNotice] = useState<BrowserStateApi['timedMessage']>();
  const [historyByTab, setHistoryByTab] = useState<Record<number, { entries: string[]; index: number }>>(() => Object.fromEntries(seedSpaces.flatMap((space) => space.tabs.map((entry) => [entry.id, { entries: [entry.url], index: 0 }]))));
  const currentTab = tabs.find((candidate) => candidate.active && candidate.windowId === WINDOW_ID);
  const tabsRef = useRef(tabs);
  const activeSpaceIdRef = useRef(activeSpaceId);
  const activeTabIdRef = useRef<number | undefined>(tabs.find((candidate) => candidate.active)?.id);
  tabsRef.current = tabs;
  activeSpaceIdRef.current = activeSpaceId;
  const renderedActiveTabId = tabs.find((candidate) => candidate.active && candidate.windowId === WINDOW_ID)?.id;

  const commit = () => setModelRevision((revision) => revision + 1);
  const addTab = async (rawUrl = START_URL, destinationSpaceId = activeSpaceId, activate = true) => {
    const url = normaliseUrl(rawUrl);
    const title = titleFromUrl(url);
    const id = nextTabId();
    const groupId = spaceGroupIds[destinationSpaceId] ?? 10 + Object.keys(spaceGroupIds).length;
    const spaceTabs = tabs.filter((candidate) => tabSpaceIds[candidate.id ?? -1] === destinationSpaceId);
    const created = tab(id, spaceTabs.length, destinationSpaceId, groupId, title, url, activate);
    if (activate) {
      activeTabIdRef.current = id;
      tabsRef.current = [...tabsRef.current.map((candidate) => ({ ...candidate, active: false, highlighted: false })), created];
    } else {
      tabsRef.current = [...tabsRef.current, created];
    }
    setTabs((current) => [...current.map((candidate) => activate ? { ...candidate, active: false, highlighted: false } : candidate), created]);
    setTabSpaceIds((current) => ({ ...current, [id]: destinationSpaceId }));
    setTabBackingIds((current) => ({ ...current, [id]: `backing-${id}` }));
    setHistoryByTab((current) => ({ ...current, [id]: { entries: [url], index: 0 } }));
    setBookmarkTree((current) => insertNode(current, `${destinationSpaceId}-tabs`, pageNode(
      `backing-${id}`, `${destinationSpaceId}-tabs`, spaceTabs.length,
      tabBackingBookmarkTitle(title, spaceTabs.length, `token-${id}`, destinationSpaceId, undefined, { installationId: INSTALLATION_ID, windowId: WINDOW_ID }),
      url,
    )));
    if (activate) setActiveSpaceIdValue(destinationSpaceId);
    commit();
    return created;
  };
  const setActiveSpaceId = async (spaceId: string) => {
    if (!findNode(bookmarkTree, spaceId)) return false;
    setActiveSpaceIdValue(spaceId);
    const target = tabs.filter((candidate) => tabSpaceIds[candidate.id ?? -1] === spaceId).sort((a, b) => a.index - b.index)[0];
    setTabs((current) => current.map((candidate) => ({
      ...candidate, active: Boolean(target && candidate.id === target.id), highlighted: Boolean(target && candidate.id === target.id),
    })));
    commit();
    return true;
  };
  const focusTab = async (target: BrowserTab) => {
    if (target.id === undefined) return;
    activeTabIdRef.current = target.id;
    tabsRef.current = tabsRef.current.map((candidate) => ({ ...candidate, active: candidate.id === target.id, highlighted: candidate.id === target.id }));
    const spaceId = tabSpaceIds[target.id];
    if (spaceId) setActiveSpaceIdValue(spaceId);
    setTabs((current) => current.map((candidate) => ({ ...candidate, active: candidate.id === target.id, highlighted: candidate.id === target.id })));
    commit();
  };
  const navigateTab = async (tabId: number, target: string | { kind: 'search'; query: string }) => {
    const url = normaliseUrl(typeof target === 'string' ? target : target.query);
    const title = titleFromUrl(url);
    tabsRef.current = tabsRef.current.map((candidate) => candidate.id === tabId ? { ...candidate, pendingUrl: undefined, status: 'complete', title, url, favIconUrl: faviconDataUri(title) } : candidate);
    setTabs((current) => current.map((candidate) => candidate.id === tabId ? { ...candidate, pendingUrl: undefined, status: 'complete', title, url, favIconUrl: faviconDataUri(title) } : candidate));
    setBookmarkTree((current) => mapNode(current, `backing-${tabId}`, (node) => ({ ...node, title: tabBackingBookmarkTitle(title, node.index, undefined, tabSpaceIds[tabId], node.title, { installationId: INSTALLATION_ID, windowId: WINDOW_ID }), url })));
    setHistoryByTab((current) => {
      const history = current[tabId] ?? { entries: [], index: -1 };
      const entries = [...history.entries.slice(0, history.index + 1), url];
      return { ...current, [tabId]: { entries, index: entries.length - 1 } };
    });
    commit();
  };
  const closeTabs = async (tabIds: readonly number[]) => {
    const closing = new Set(tabIds);
    const closed = tabs.filter((candidate) => candidate.id !== undefined && closing.has(candidate.id));
    setRecentlyClosedTabs((current) => [...closed.map((candidate) => ({
      sessionId: `closed-${candidate.id}`, title: candidate.title ?? titleFromUrl(candidate.url ?? START_URL),
      url: candidate.url ?? candidate.pendingUrl ?? START_URL, ...(candidate.favIconUrl ? { favIconUrl: candidate.favIconUrl } : {}),
    })), ...current].slice(0, 10));
    setTabs((current) => {
      const remaining = current.filter((candidate) => candidate.id === undefined || !closing.has(candidate.id));
      if (remaining.some((candidate) => candidate.active)) return remaining;
      const first = remaining.find((candidate) => tabSpaceIds[candidate.id ?? -1] === activeSpaceId) ?? remaining[0];
      return remaining.map((candidate) => ({ ...candidate, active: candidate.id === first?.id, highlighted: candidate.id === first?.id }));
    });
    commit();
  };
  const openBookmark = async (url: string, options: { activate?: boolean; destinationSpaceId?: string | null; forceNew?: boolean; reuse?: 'browser' | 'space' | 'window' } = {}) => {
    const destinationSpaceId = options.destinationSpaceId ?? activeSpaceId;
    if (!options.forceNew) {
      const existing = tabs.find((candidate) => candidate.url === url && (options.reuse === 'browser' || tabSpaceIds[candidate.id ?? -1] === destinationSpaceId));
      if (existing) { await focusTab(existing); return existing; }
    }
    return addTab(url, destinationSpaceId, options.activate ?? true);
  };
  const updateBookmark = async (id: string, title: string, url?: string) => {
    setBookmarkTree((current) => mapNode(current, id, (node) => ({ ...node, title: title || titleFromUrl(url ?? node.url ?? ''), ...(url ? { url } : {}) })));
    commit();
  };
  const createFolder = async (parentId: string) => {
    const node: BookmarkNode = pageNode(nextId('folder'), parentId, descendants(bookmarkTree, parentId).length, 'New folder');
    setBookmarkTree((current) => insertNode(current, parentId, node));
    commit();
    return node;
  };
  const createTabFolder = async (spaceId: string, parentId?: string) => {
    const destinationId = parentId ?? `${spaceId}-tabs`;
    const node = pageNode(nextId('tab-folder'), destinationId, descendants(bookmarkTree, destinationId).length, tabFolderBookmarkTitle('New folder'));
    setBookmarkTree((current) => insertNode(current, destinationId, node));
    commit();
    return node;
  };
  const moveBookmark = async (id: string, destination: { parentId?: string; index?: number }) => {
    setBookmarkTree((current) => {
      const detached = detachNode(current, id);
      if (!detached.node || !destination.parentId) return current;
      return insertNode(detached.tree, destination.parentId, detached.node, destination.index);
    });
    commit();
  };
  const copyBookmark = async (id: string, destination: { parentId: string; index?: number }, options: { favouriteSlot?: number; skipExisting?: boolean } = {}) => {
    const source = findNode(bookmarkTree, id);
    if (!source) return undefined;
    if (options.skipExisting && descendants(bookmarkTree, destination.parentId).some((node) => node.url && node.url === source.url)) return undefined;
    const copied = { ...source, id: nextId('copy'), parentId: destination.parentId, ...(source.children ? { children: source.children.map((child: BookmarkNode) => ({ ...child, parentId: nextId('parent') })) } : {}),
      title: options.favouriteSlot === undefined ? source.title : bookmarkTitleWithFavouriteSlot(source, options.favouriteSlot),
    };
    setBookmarkTree((current) => insertNode(current, destination.parentId, copied, destination.index));
    commit();
    return copied;
  };
  const removeBookmark = async (node: Pick<BookmarkNode, 'id' | 'parentId'>, options: { isSpace?: boolean } = {}) => {
    if (options.isSpace || node.parentId === 'hyper-spaces') {
      const remaining = descendants(bookmarkTree, 'hyper-spaces').filter((candidate) => candidate.id !== node.id);
      if (remaining.length === 0) throw new Error('At least one space is required.');
    }
    setBookmarkTree((current) => removeNode(current, node.id));
    if (options.isSpace || node.parentId === 'hyper-spaces') {
      const removedTabs = tabs.filter((candidate) => tabSpaceIds[candidate.id ?? -1] === node.id).map((candidate) => candidate.id).filter((id): id is number => id !== undefined);
      await closeTabs(removedTabs);
      const replacement = descendants(bookmarkTree, 'hyper-spaces').find((candidate) => candidate.id !== node.id)?.id;
      if (activeSpaceId === node.id && replacement) setActiveSpaceIdValue(replacement);
    }
    commit();
  };
  const addTabBookmark = async (rootId: string, tabId: number, index?: number, favouriteSlot?: number) => {
    const source = tabs.find((candidate) => candidate.id === tabId);
    if (!source) throw new Error('This tab is no longer available.');
    const node = pageNode(nextId('bookmark'), rootId, index ?? 0, source.title ?? titleFromUrl(source.url ?? START_URL), source.url ?? START_URL);
    if (favouriteSlot !== undefined) node.title = bookmarkTitleWithFavouriteSlot(node, favouriteSlot);
    setBookmarkTree((current) => {
      if (current && descendants(current, rootId).some((candidate) => candidate.url === node.url)) return current;
      return insertNode(current, rootId, node, index);
    });
    commit();
    return { created: true, node };
  };
  const addCurrentPage = async (parentId: string, favouriteSlot?: number) => {
    if (!currentTab?.id) throw new Error('There is no active page.');
    return addTabBookmark(parentId, currentTab.id, undefined, favouriteSlot);
  };
  const submitSelection = async (kind: string, items: readonly DemoItem[]) => {
    const results: unknown[] = [];
    for (const item of items) {
      if (kind === 'openBookmark') {
        results.push(await openBookmark(String(item.url), {
          activate: Boolean(item.active), destinationSpaceId: String(item.destinationSpaceId ?? activeSpaceId), forceNew: Boolean(item.forceNew), reuse: 'browser',
        }));
      } else if (kind === 'createBookmark') {
        const parentId = String(item.parentId);
        const sourceTabId = typeof item.tabId === 'number' ? item.tabId : undefined;
        if (sourceTabId !== undefined) results.push(await addTabBookmark(parentId, sourceTabId, typeof item.index === 'number' ? item.index : undefined, typeof item.favouriteSlot === 'number' ? item.favouriteSlot : undefined));
        else {
          const page = item.page as { title?: string; url?: string } | undefined;
          const node = pageNode(nextId('bookmark'), parentId, typeof item.index === 'number' ? item.index : 0, page?.title ?? 'Bookmark', page?.url ?? START_URL);
          setBookmarkTree((current) => insertNode(current, parentId, node, typeof item.index === 'number' ? item.index : undefined));
          results.push({ created: true, node });
        }
      } else if (kind === 'deleteBookmark') {
        await removeBookmark({ id: String(item.bookmarkId), parentId: undefined });
        results.push(true);
      } else if (kind === 'moveBookmark') {
        await moveBookmark(String(item.bookmarkId), { parentId: typeof item.parentId === 'string' ? item.parentId : undefined, index: typeof item.index === 'number' ? item.index : undefined });
        results.push(true);
      } else if (kind === 'copyBookmark') {
        results.push(await copyBookmark(String(item.bookmarkId), { parentId: String(item.parentId), ...(typeof item.index === 'number' ? { index: item.index } : {}) }, { skipExisting: Boolean(item.skipExisting) }));
      } else if (kind === 'setTabFolder') {
        const operation = String(item.operation);
        if (operation === 'create') results.push(await createTabFolder(String(item.spaceId), typeof item.parentId === 'string' ? item.parentId : undefined));
        else if (operation === 'rename') { await updateBookmark(String(item.folderId), String(item.title)); results.push(true); }
        else if (operation === 'remove') { await removeBookmark({ id: String(item.folderId), parentId: undefined }); results.push(true); }
        else results.push(true);
      } else if (kind === 'reloadTab') {
        const targetId = Number(item.tabId);
        setTabs((current) => current.map((candidate) => candidate.id === targetId ? { ...candidate, status: 'complete' } : candidate));
        results.push(true);
      }
    }
    commit();
    return results;
  };
  const createSpace = async () => {
    const id = nextId('space');
    const existingSpaces = descendants(bookmarkTree, 'hyper-spaces');
    const title = `Space ${existingSpaces.length + 1}`;
    const colour = COLOURS[existingSpaces.length % COLOURS.length] ?? 'purple';
    const node = createSpaceNode(id, title, existingSpaces.length, [], []);
    const groupId = 10 + existingSpaces.length;
    setBookmarkTree((current) => insertNode(current, 'hyper-spaces', node));
    setSpaceGroupIds((current) => ({ ...current, [id]: groupId }));
    setSpaceColours((current) => ({ ...current, [id]: colour }));
    await setActiveSpaceIdValue(id);
    setTabs((current) => current.map((candidate) => ({ ...candidate, active: false, highlighted: false })));
    commit();
    return node;
  };
  const duplicateSpace = async (spaceId: string, withTabs: boolean) => {
    const source = findNode(bookmarkTree, spaceId);
    if (!source) throw new Error('That space is unavailable.');
    const id = nextId('space');
    const copy = createSpaceNode(id, `${source.title} copy`, descendants(bookmarkTree, 'hyper-spaces').length,
      withTabs ? tabs.filter((candidate) => tabSpaceIds[candidate.id ?? -1] === spaceId).map((candidate) => ({ id: nextTabId(), title: candidate.title ?? 'Tab', url: candidate.url ?? START_URL })) : [],
      descendants(source.children ?? [], `${spaceId}-bookmarks`).map((node, index) => ({ ...node, id: nextId('bookmark'), parentId: `${id}-bookmarks`, index })),
    );
    setBookmarkTree((current) => insertNode(current, 'hyper-spaces', copy));
    setSpaceGroupIds((current) => ({ ...current, [id]: 10 + Object.keys(current).length }));
    setSpaceColours((current) => ({ ...current, [id]: COLOURS[Object.keys(current).length % COLOURS.length] ?? 'purple' }));
    setActiveSpaceIdValue(id);
    commit();
    return copy;
  };
  const setSpaceArchived = async (spaceId: string, archived: boolean) => {
    setBookmarkTree((current) => mapNode(current, spaceId, (node) => ({ ...node, title: bookmarkTitleWithHyper(node.title, { archived: archived || undefined }) })));
    if (archived && activeSpaceId === spaceId) {
      const nextSpace = descendants(bookmarkTree, 'hyper-spaces').find((node) => node.id !== spaceId);
      if (nextSpace) await setActiveSpaceId(nextSpace.id);
    }
    commit();
  };
  const groupTabsInSpace = async (tabIds: number[], destination: string) => {
    const groupId = spaceGroupIds[destination] ?? 10;
    setTabSpaceIds((current) => ({ ...current, ...Object.fromEntries(tabIds.map((id) => [id, destination])) }));
    setTabs((current) => current.map((candidate) => candidate.id !== undefined && tabIds.includes(candidate.id) ? { ...candidate, groupId } : candidate));
    for (const id of tabIds) setBookmarkTree((current) => mapNode(current, `backing-${id}`, (node) => ({ ...node, title: bookmarkTitleWithHyper(node.title, { spaceId: destination }) })));
    commit();
  };
  const moveTabEntries = async (tabIds: number[], destinationSpaceId: string, parentId: string, index: number) => {
    await groupTabsInSpace(tabIds, destinationSpaceId);
    for (const id of tabIds) {
      const source = findNode(bookmarkTree, `backing-${id}`);
      if (source) await moveBookmark(source.id, { parentId, index });
    }
  };
  const showMessage = async (text: string, tone: DemoNoticeTone) => {
    setNotice({ id: nextId('notice'), text, tone, kind: 'feedback', durationMs: 5000, expiresAt: Date.now() + 5000 });
    commit();
    return true;
  };
  const searchItems: SearchItem[] = useMemo(() => {
    const results: SearchItem[] = [];
    const spaceNames = new Map(descendants(bookmarkTree, 'hyper-spaces').map((space) => [space.id, visibleBookmarkTitle(space)]));
    for (const candidate of tabs) {
      if (candidate.id === undefined) continue;
      const spaceId = tabSpaceIds[candidate.id];
      results.push({ id: `tab:${candidate.id}`, kind: 'tab', source: spaceId === activeSpaceId ? 'current-space' : 'other-space', title: candidate.title ?? titleFromUrl(candidate.url ?? START_URL), detail: candidate.url ?? START_URL, url: candidate.url, tabId: candidate.id, windowId: WINDOW_ID, spaceId, faviconUrl: candidate.favIconUrl, openSpaces: spaceId ? [{ id: spaceId, title: spaceNames.get(spaceId) ?? 'Space', tabId: candidate.id, windowId: WINDOW_ID }] : [] });
    }
    visit(bookmarkTree, (node) => {
      if (node.id.startsWith('backing-') || node.id.startsWith('hyper-')) return;
      if (['0', '1', 'hyper-root'].includes(node.id) || node.id.endsWith('-tabs') || node.id.endsWith('-bookmarks')) return;
      const parentChain = (() => { const ids: string[] = []; let parentId = node.parentId; while (parentId) { const parent = findNode(bookmarkTree, parentId); if (!parent) break; ids.unshift(parent.title); parentId = parent.parentId; } return ids; })();
      const spaceId = parentChain.find((part) => spaceNames.has(part)) ?? Object.entries(spaceNames).find(([, title]) => parentChain.includes(title))?.[0];
      results.push({ id: `bookmark:${node.id}`, kind: node.url ? 'bookmark' : 'folder', source: node.id.includes('favourite') ? 'favourite' : 'bookmark', title: visibleBookmarkTitle(node), detail: node.url ?? parentChain.map((part) => part.split(' {"hyper"')[0] ?? part).join(' / '), url: node.url, nodeId: node.id, spaceId, folders: parentChain });
    });
    return results;
  }, [activeSpaceId, bookmarkTree, tabSpaceIds, tabs]);
  const search = async ({ query }: { query: string }) => {
    const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    const results: DemoResult[] = searchItems.flatMap((item) => {
      const haystack = `${item.title} ${item.detail} ${(item.folders ?? []).join(' ')}`.toLocaleLowerCase();
      return terms.length === 0 || terms.every((term) => haystack.includes(term)) ? [{ kind: 'item' as const, item }] : [];
    }).slice(0, 48);
    if (/^https?:\/\//i.test(query.trim())) results.push({ kind: 'navigate', target: { detail: 'Open address', kind: 'url', label: normaliseUrl(query), url: normaliseUrl(query) } });
    else if (query.trim()) results.push({ kind: 'navigate', target: { detail: 'Search the web', kind: 'search', label: `Search for “${query.trim()}”`, query: query.trim() } });
    return { results, revision: modelRevision };
  };
  const setPreference = async <Key extends keyof typeof preferences>(key: Key, value: typeof preferences[Key]) => {
    setPreferences((current) => ({ ...current, [key]: value })); commit(); return true;
  };
  const setTabMuted = async (tabId: number, muted: boolean) => {
    setTabs((current) => current.map((candidate) => candidate.id === tabId ? { ...candidate, mutedInfo: { muted } } : candidate)); commit();
  };
  const reloadTabs = async (tabIds: readonly number[]) => {
    const selected = new Set(tabIds);
    setTabs((current) => current.map((candidate) => candidate.id !== undefined && selected.has(candidate.id) ? { ...candidate, status: 'loading' } : candidate));
    commit();
    setTimeout(() => { setTabs((current) => current.map((candidate) => candidate.id !== undefined && selected.has(candidate.id) ? { ...candidate, status: 'complete' } : candidate)); commit(); }, 350);
  };
  const submitBrowserCommand = async (intent: { kind: string; payload: Record<string, unknown> }) => {
    if (intent.kind === 'createTab') await addTab();
    else if (intent.kind === 'activateTab') { const target = tabs.find((candidate) => candidate.id === Number(intent.payload.tabId)); if (target) await focusTab(target); }
    else if (intent.kind === 'duplicateTab') { const target = tabs.find((candidate) => candidate.id === Number(intent.payload.tabId)); if (target) await addTab(target.url, tabSpaceIds[target.id ?? -1] ?? activeSpaceId); }
    else if (intent.kind === 'closeTabs') { await closeTabs((intent.payload.tabIds as number[] | undefined) ?? []); }
    else if (intent.kind === 'reloadTab') await reloadTabs([Number(intent.payload.tabId)]);
    else if (intent.kind === 'setTabMuted') await setTabMuted(Number(intent.payload.tabId), Boolean(intent.payload.muted));
    else if (intent.kind === 'setTabPinned') { const tabId = Number(intent.payload.tabId); setTabs((current) => current.map((candidate) => candidate.id === tabId ? { ...candidate, pinned: Boolean(intent.payload.pinned) } : candidate)); }
    else if (intent.kind === 'navigateTabHistory') {
      const tabId = Number(intent.payload.tabId); const history = historyByTab[tabId];
      if (history) { const offset = intent.payload.direction === 'back' ? -1 : 1; const index = Math.max(0, Math.min(history.entries.length - 1, history.index + offset)); setHistoryByTab((current) => ({ ...current, [tabId]: { ...history, index } })); const url = history.entries[index]; if (url) await navigateTab(tabId, url); }
    } else if (intent.kind === 'restoreClosedTab') {
      const closed = recentlyClosedTabs[0]; if (closed) { await addTab(closed.url); setRecentlyClosedTabs((current) => current.slice(1)); }
    }
    commit();
  };
  const capabilities: BrowserCapabilities = { ...noBrowserCommandCapabilities, available: true, duplicateTab: true, navigateBack: true, navigateForward: true, restoreClosedTab: true, tabZoom: true };

  const browserState = {
    activeGroupId: spaceGroupIds[activeSpaceId] ?? null, activeSpaceId, backgroundMusicTabIds: tabs.filter((candidate) => candidate.audible).map((candidate) => candidate.id as number), bookmarkImportInProgress: false,
    bookmarkTree, commandCapabilities: capabilities, currentWindowFocused: true, currentWindowId: WINDOW_ID, currentWindowIncognito: false,
    pendingBackingOperations: 0, favouriteIds: descendants(bookmarkTree, 'hyper-favourites').map((node) => node.id), favouritesFolderId: 'hyper-favourites', globalBookmarksFolderId: 'hyper-bookmarks',
    installationId: INSTALLATION_ID, isBackingOperationPending: false, isLoading: false, error: null, mediaControlAvailable: tabs.some((candidate) => candidate.audible),
    mediaTarget: tabs.some((candidate) => candidate.id === 302) ? { tabId: 302, state: 'playing' as const } : undefined, modelRevision, preferences, recentlyClosedTabs,
    remoteSpacePresence: { bookmarkSpaceIds: {}, otherWindowTabCounts: {}, tabSpaceIds: {} }, sharedDrag: null, spaceColours, spaceGroupIds, spacesFolderId: 'hyper-spaces',
    tabBackingIds, tabBookmarkLinks: {}, tabNames: {}, tabTitles: {}, tabSpaceIds, tabs, timedMessage: notice,
    runBackingOperation: async <Result>(operation: () => Promise<Result>) => operation(),
    setFavouriteSlot: async (id: string, slotIndex: number) => {
      setBookmarkTree((current) => mapNode(current, id, (node) => ({ ...node, title: bookmarkTitleWithFavouriteSlot(node, slotIndex) }))); commit();
    },
    setActiveSpaceId, moveBookmark,
    copyBookmark, importBookmarkFolder: async (sourceId: string, parentId: string) => {
      const imported = await copyBookmark(sourceId, { parentId }); if (!imported) throw new Error('Folder unavailable.'); return imported;
    },
    moveBookmarkByOffset: async (id: string, offset: -1 | 1) => { const node = findNode(bookmarkTree, id); if (!node?.parentId) return; await moveBookmark(id, { parentId: node.parentId, index: (node.index ?? 0) + (offset > 0 ? 2 : 0) }); },
    addCurrentPage, createFolder, createTabFolder,
    renameTabFolder: async (folderId: string, title: string) => updateBookmark(folderId, tabFolderBookmarkTitle(title)),
    removeTabFolder: async (folderId: string) => removeBookmark({ id: folderId, parentId: undefined }),
    submitSelection, moveTabTreeNode: async (spaceId: string, nodeIds: readonly string[], destination: { parentId: string; index?: number }) => { await moveTabEntries(nodeIds.flatMap((id) => Number(id.replace('backing-', '')) || []), spaceId, destination.parentId, destination.index ?? 0); },
    setPreference, closeSpaceTabs: async (spaceId: string) => closeTabs(tabs.flatMap((candidate) => tabSpaceIds[candidate.id ?? -1] === spaceId && candidate.id !== undefined ? [candidate.id] : [])),
    createSpace, duplicateSpace, reloadSpaceTabs: async (spaceId: string) => reloadTabs(tabs.flatMap((candidate) => tabSpaceIds[candidate.id ?? -1] === spaceId && candidate.id !== undefined ? [candidate.id] : [])), setSpaceArchived,
    addTabBookmark, groupTabsInSpace, focusTab, closeTabsInSpace: async (source: { kind: string; tabId?: number; bookmarkId?: string }, spaceId: string) => closeTabs(tabs.flatMap((candidate) => candidate.id !== undefined && tabSpaceIds[candidate.id] === spaceId && (candidate.id === source.tabId || candidate.url === findNode(bookmarkTree, source.bookmarkId ?? '')?.url) ? [candidate.id] : [])),
    focusRemoteTab: async () => undefined, moveRemoteTabToWindow: async () => undefined, offerDrag: async () => undefined, takeSharedDragTabs: async () => undefined,
    moveTabsIntoTree: async (tabIds: number[], _windowId: number, index: number, tree: { spaceId?: string; parentId: string }) => moveTabEntries(tabIds, tree.spaceId ?? activeSpaceId, tree.parentId, index),
    withdrawDrag: async () => undefined, splitTab: async ({ tabId, withTabId }: { tabId: number; withTabId?: number }) => { if (withTabId) await groupTabsInSpace([tabId, withTabId], activeSpaceId); },
    navigateTab, closeTab: async (id: number) => closeTabs([id]), closeTabs, reloadTabs, createTab: () => addTab(), setActiveSpace: setActiveSpaceId,
    searchInNewTab: async (query: string) => addTab(`https://search.hyper.local/?q=${encodeURIComponent(query)}`),
    setTabMuted, deleteHistory: async () => undefined, moveTab: async (id: number, _windowId: number, index: number) => { setTabs((current) => current.map((candidate) => candidate.id === id ? { ...candidate, index } : candidate).sort((a,b) => a.index-b.index).map((candidate,index) => ({...candidate,index}))); },
    moveTabs: async (ids: number[], _windowId: number, index: number) => { setTabs((current) => { const moving = current.filter((candidate) => ids.includes(candidate.id ?? -1)); const rest = current.filter((candidate) => !ids.includes(candidate.id ?? -1)); rest.splice(index, 0, ...moving); return rest.map((candidate, candidateIndex) => ({ ...candidate, index: candidateIndex })); }); },
    setTabMediaPlayback: async (tabId: number, state: 'paused' | 'playing') => { setTabs((current) => current.map((candidate) => candidate.id === tabId ? { ...candidate, audible: state === 'playing', mutedInfo: { muted: state === 'paused' } } : candidate)); },
    search, forgetSearchSelection: async () => true, recordSearchSelection: async () => true, updateBookmark,
    updateBookmarkUrl: async (id: string, url: string) => updateBookmark(id, findNode(bookmarkTree, id)?.title ?? titleFromUrl(url), url),
    removeBookmark, openBookmark, openFavourite: (url: string, forceNew = false) => openBookmark(url, { forceNew }),
    duplicateTab: async (candidate: BrowserTab) => addTab(candidate.url ?? candidate.pendingUrl ?? START_URL, tabSpaceIds[candidate.id ?? -1] ?? activeSpaceId),
    actOnTimedMessage: async () => { setNotice(undefined); return true; }, dismissTimedMessage: async () => { setNotice(undefined); return true; }, showMessage,
    renameTab: async (candidate: BrowserTab, title: string) => { if (candidate.id === undefined) return; setTabs((current) => current.map((entry) => entry.id === candidate.id ? { ...entry, title } : entry)); await updateBookmark(`backing-${candidate.id}`, title); },
    submitBrowserCommand,
  } as unknown as BrowserStateApi;

  return {
    browserState,
    tabs,
    activeTab: currentTab,
    activeSpaceId,
    address: currentTab?.url ?? currentTab?.pendingUrl ?? START_URL,
    controls: {
      createTab: () => addTab(),
      setActiveSpace: setActiveSpaceId,
      closeTab: (id: number) => closeTabs([id]),
      activateTab: focusTab,
      navigate: async (value: string, tabId = activeTabIdRef.current) => {
        const latestId = activeTabIdRef.current ?? tabId;
        return latestId !== undefined ? navigateTab(latestId, value) : addTab(value);
      },
      back: () => {
        const latest = tabsRef.current.find((candidate) => candidate.active && candidate.windowId === WINDOW_ID);
        return latest?.id !== undefined ? submitBrowserCommand({ kind: 'navigateTabHistory', payload: { direction: 'back', tabId: latest.id } }) : undefined;
      },
      forward: () => {
        const latest = tabsRef.current.find((candidate) => candidate.active && candidate.windowId === WINDOW_ID);
        return latest?.id !== undefined ? submitBrowserCommand({ kind: 'navigateTabHistory', payload: { direction: 'forward', tabId: latest.id } }) : undefined;
      },
      reload: () => {
        const latest = tabsRef.current.find((candidate) => candidate.active && candidate.windowId === WINDOW_ID);
        return latest?.id !== undefined ? reloadTabs([latest.id]) : undefined;
      },
      search: (query: string) => {
        const latest = tabsRef.current.find((candidate) => candidate.active && candidate.windowId === WINDOW_ID);
        return latest?.id !== undefined ? navigateTab(latest.id, { kind: 'search', query }) : addTab(`https://search.hyper.local/?q=${encodeURIComponent(query)}`);
      },
      bookmarkCurrentPage: (tabId = activeTabIdRef.current) => {
        const latestId = activeTabIdRef.current ?? tabId;
        const latest = tabsRef.current.find((candidate) => candidate.id === latestId);
        return latestId !== undefined && latest?.id !== undefined ? addTabBookmark(`${activeSpaceIdRef.current}-bookmarks`, latestId) : undefined;
      },
    },
  };
}
