import type { BookmarkNode } from '../../entrypoints/lib/bookmarks';
import { tabBackingBookmarkTitle, tabFolderBookmarkTitle } from '../../entrypoints/lib/bookmarks';
import {
  commitHyperModelAtom,
  createHyperModelStore,
  emptyBrowserObservation,
  emptyRuntimeMetadata,
  type HyperModelSources,
  type HyperModelStore,
} from '../../entrypoints/lib/model';
import type { SearchItem } from '../../entrypoints/lib/search';
import type { SearchCommand } from '../../entrypoints/lib/searchIndex';
import type { TabOwnership } from '../../entrypoints/lib/tabOwnership';

/**
 * A large, deterministic profile for Search benchmarks: four spaces holding
 * about 6,000 bookmarks in nested folders, 160 live tabs (some in tab folders,
 * some with captured page text), 1,200 history entries and 60 commands.
 */
export const WINDOW_ID = 7;
export const BENCH_NOW = Date.UTC(2026, 10, 16, 2);
const DAY = 24 * 60 * 60 * 1000;

const words = [
  'alpha', 'budget', 'calendar', 'dashboard', 'design', 'engineering', 'finance', 'github',
  'handbook', 'incident', 'journal', 'kanban', 'launch', 'metrics', 'notes', 'onboarding',
  'planning', 'quarterly', 'roadmap', 'sprint', 'team', 'umbrella', 'vendor', 'wiki',
  'xylophone', 'yearly', 'zebra', 'review', 'report', 'release', 'pull', 'requests',
];
const hosts = [
  'github.com', 'docs.google.com', 'example.com', 'news.ycombinator.com', 'wikipedia.org',
  'atlassian.net', 'notion.so', 'figma.com', 'linear.app', 'stackoverflow.com',
];

/** A small deterministic generator so every run indexes the same text. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

export interface SearchBenchmarkProfile {
  commands: SearchCommand[];
  sources: HyperModelSources;
  store: HyperModelStore;
}

export function searchBenchmarkProfile(): SearchBenchmarkProfile {
  const next = random(42);
  const pick = <T>(values: readonly T[]): T => values[Math.floor(next() * values.length)]!;
  const phrase = (count: number) => Array.from({ length: count }, () => pick(words))
    .map((word, index) => index === 0 ? word[0]!.toUpperCase() + word.slice(1) : word)
    .join(' ');
  let nextId = 1000;
  const id = () => String(nextId++);
  const pageUrl = (suffix: string) =>
    `https://${pick(hosts)}/${pick(words)}/${pick(words)}-${suffix}?ref=${pick(words)}`;
  const pageText = () => Array.from({ length: 400 }, () => pick(words)).join(' ');
  const folder = (nodeId: string, title: string, children: BookmarkNode[]) =>
    ({ children, id: nodeId, title }) as BookmarkNode;
  const bookmarkFolder = (depth: number, breadth: number): BookmarkNode => {
    const children: BookmarkNode[] = [];
    for (let index = 0; index < breadth; index += 1) {
      children.push(depth > 0 && index % 6 === 0
        ? bookmarkFolder(depth - 1, breadth)
        : { id: id(), title: phrase(3), url: pageUrl(String(nextId)) } as BookmarkNode);
    }
    return folder(id(), phrase(2), children);
  };

  const tabs: Browser.tabs.Tab[] = [];
  const tabOwnerships: Record<number, TabOwnership> = {};
  const tabContents: Record<number, { navigationVersion: number; text: string; url: string }> = {};
  const spaces = ['Work', 'Personal', 'Research', 'Side projects'].map((title, spaceIndex) => {
    const spaceId = `space-${spaceIndex}`;
    const backings: BookmarkNode[] = [];
    const tabFolders: BookmarkNode[] = [];
    for (let index = 0; index < 40; index += 1) {
      const tabId = spaceIndex * 100 + index + 1;
      const url = pageUrl(`tab-${tabId}`);
      const backingId = `backing-${tabId}`;
      const token = `token-${tabId}`;
      const backing = {
        id: backingId,
        title: tabBackingBookmarkTitle(phrase(3), index, token, spaceId),
        url,
      } as BookmarkNode;
      if (index % 4 === 0) {
        tabFolders.push(folder(id(), tabFolderBookmarkTitle(phrase(1)), [backing]));
      } else {
        backings.push(backing);
      }
      tabs.push({
        active: false,
        id: tabId,
        incognito: false,
        index: tabs.length,
        title: phrase(4),
        url,
        windowId: WINDOW_ID,
      } as Browser.tabs.Tab);
      tabOwnerships[tabId] = { backingId, backingToken: token, spaceId, windowId: WINDOW_ID };
      if (index % 5 === 0) tabContents[tabId] = { navigationVersion: 0, text: pageText(), url };
    }
    return folder(spaceId, title, [
      folder(`${spaceId}-tabs`, `tabs ${JSON.stringify({ hyper: { spaceTabs: true, spaceId } })}`, [
        ...backings,
        ...tabFolders,
      ]),
      folder(
        `${spaceId}-bookmarks`,
        `bookmarks ${JSON.stringify({ hyper: { spaceBookmarks: true, spaceId } })}`,
        Array.from({ length: 6 }, () => bookmarkFolder(2, 18)),
      ),
    ]);
  });
  const favourites = Array.from({ length: 12 }, () =>
    ({ id: id(), title: phrase(2), url: pageUrl(String(nextId)) }) as BookmarkNode);
  const bookmarkTree = [folder('0', '', [folder('1', 'Bookmarks bar', [folder('hyper', 'hyper', [
    folder('favourites', 'favourites', favourites),
    folder('spaces', 'spaces', spaces),
    folder('global', 'bookmarks', [bookmarkFolder(2, 18)]),
  ])])])];
  const historyItems: SearchItem[] = Array.from({ length: 1200 }, (_, index) => ({
    detail: 'History',
    id: `history:${index}`,
    kind: 'history',
    lastVisitTime: BENCH_NOW - Math.floor(next() * 120 * DAY),
    source: 'history',
    title: phrase(5),
    url: pageUrl(`history-${index}`),
  }));
  const sources: HyperModelSources = {
    browser: {
      ...emptyBrowserObservation,
      bookmarkTree,
      extensionOrigin: 'chrome-extension://hyper/',
      tabs,
      windows: [{ id: WINDOW_ID, incognito: false, type: 'normal' } as Browser.windows.Window],
    },
    runtime: {
      ...emptyRuntimeMetadata,
      activeSpaceIds: { [WINDOW_ID]: 'space-0' },
      historySearchItems: historyItems,
      tabContents,
      tabContentVersions: Object.fromEntries(Object.keys(tabContents).map((key) => [key, 0])),
      tabOwnerships,
    },
  };
  const store = createHyperModelStore();
  store.set(commitHyperModelAtom, { sources });
  const commands: SearchCommand[] = Array.from({ length: 60 }, (_, index) => ({
    detail: 'Hyper',
    icon: 'settings',
    id: `command-${index}`,
    keywords: [pick(words), pick(words)],
    label: phrase(2),
  }));
  return { commands, sources, store };
}

/** Every prefix of `query` that has text, as a user typing it would send them. */
export function keystrokes(query: string): string[] {
  return Array.from({ length: query.length }, (_, index) => query.slice(0, index + 1))
    .filter((prefix) => prefix.trim());
}
