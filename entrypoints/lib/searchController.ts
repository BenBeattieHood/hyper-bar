import { createSerialAsyncRunner } from './async';
import { shownSpaces } from './bookmarks';
import { windowMediaCommands } from './mediaCommands';
import { hyperModelAtom, type HyperModelSnapshot, type HyperModelStore } from './model';
import type { HyperModelPortClient, SearchOutcome } from './modelPort';
import type { SearchQueryMessage } from './modelProtocol';
import { buildSearchItems, type SearchItem } from './search';
import {
  recentSearchResults,
  SharedSearchIndex,
  type SearchCommand,
  type SharedSearchResult,
} from './searchIndex';
import {
  createSearchItemInterner,
  searchRecordsForWindow,
  type WindowSearchRecords,
} from './searchProjection';
import { isPlaceholderTabTitle } from './tabs';
import {
  forgetSearchSelection,
  recordSearchSelection,
  SEARCH_SELECTION_HISTORY_KEY,
  type SearchSelectionHistory,
} from './searchSelection';

interface HistoryApi {
  deleteUrl(details: { url: string }): Promise<unknown>;
  search(query: {
    maxResults: number;
    startTime: number;
    text: string;
  }): Promise<Browser.history.HistoryItem[]>;
}

interface LocalStorageArea {
  set(items: Record<string, unknown>): Promise<void>;
}

export interface SearchControllerDependencies {
  extensionOrigin?(): string;
  history?: HistoryApi;
  reconcile(): Promise<unknown>;
  /** Runs a task on a later turn; tests may run it at once. */
  later?(task: () => void): void;
  selectionStorage?: LocalStorageArea;
  store: HyperModelStore;
}

export interface SearchController {
  deleteHistory(url: string): Promise<void>;
  forgetSelection(resultId: string): Promise<void>;
  handleHistoryRemoved(removed: { allHistory: boolean; urls?: string[] }): Promise<void>;
  handleHistoryTitleChanged(changed: { title: string; url: string }): Promise<void>;
  handleHistoryVisited(entry: Browser.history.HistoryItem): Promise<void>;
  initialize(): Promise<void>;
  recordSelection(query: string, resultId: string): Promise<void>;
  runtimeSignals(): { historySearchItems: readonly SearchItem[] };
  search(
    request: SearchQueryMessage,
    client: Pick<HyperModelPortClient, 'windowId'> & Partial<Pick<HyperModelPortClient, 'role'>>,
  ): Promise<SearchOutcome | undefined>;
  updateHistoryTitleFromTab(tab: Browser.tabs.Tab): Promise<void>;
}

const RECENT_SEARCH_LIMIT = 10;
/** Records indexed per idle turn while Search is open and nothing is typed. */
const PREPARE_BATCH = 400;
const historySearchStartTime = () => Date.now() - 180 * 24 * 60 * 60 * 1000;

function upsertHistoryItems(
  current: readonly SearchItem[],
  additions: readonly SearchItem[],
): readonly SearchItem[] {
  const byId = new Map(current.map((item) => [item.id, item]));
  let changed = false;
  for (const item of additions) {
    if (JSON.stringify(byId.get(item.id)) === JSON.stringify(item)) continue;
    byId.set(item.id, item);
    changed = true;
  }
  return changed ? [...byId.values()] : current;
}

function removeHistoryUrls(
  current: readonly SearchItem[],
  urls: ReadonlySet<string>,
): readonly SearchItem[] {
  const retained = current.filter((item) => !item.url || !urls.has(item.url));
  return retained.length === current.length ? current : retained;
}

function retitleHistoryItems(
  current: readonly SearchItem[],
  url: string,
  title: string,
): readonly SearchItem[] {
  let changed = false;
  const next = current.map((item) => {
    if (item.url !== url) return item;
    const nextTitle = title || item.url || item.title;
    if (nextTitle === item.title) return item;
    changed = true;
    return { ...item, title: nextTitle };
  });
  return changed ? next : current;
}

/** Page text only ranks; a view never shows it, so it stays in the background. */
function withoutPageText(result: SharedSearchResult): SharedSearchResult {
  if (result.kind !== 'item' || result.item.content === undefined) return result;
  const { content: _content, ...item } = result.item;
  return { ...result, item };
}

/**
 * Owns the disposable history cache and serves query-local search records.
 * All browser and Hyper records are assembled from the model snapshot selected
 * at request time, so no client can retain or overwrite a second record set.
 * The text index stays warm between requests, but ranks only that request's records.
 */
export function createSearchController(
  dependencies: SearchControllerDependencies,
): SearchController {
  const history = dependencies.history ?? browser.history;
  const extensionOrigin = dependencies.extensionOrigin ?? (() => browser.runtime.getURL(''));
  const selectionStorage = dependencies.selectionStorage ?? browser.storage.local;
  const index = new SharedSearchIndex();
  const later = dependencies.later ?? ((task: () => void) => { setTimeout(task, 0); });
  let preparing: readonly SearchItem[] | undefined;
  // Opening Search asks with nothing typed. Building the index then, a batch a
  // turn, keeps the cost of the first build off the first keystroke.
  const prepareIndex = (items: readonly SearchItem[]) => {
    if (preparing === items) return;
    preparing = items;
    const step = () => {
      if (preparing !== items) return;
      if (index.prepare(items, PREPARE_BATCH)) later(step);
      else preparing = undefined;
    };
    later(step);
  };
  const queueHistoryMutation = createSerialAsyncRunner();
  const queueSelectionMutation = createSerialAsyncRunner();
  let historyItems: readonly SearchItem[] = [];
  let initialization: Promise<void> | undefined;
  // Keystrokes against one snapshot reuse its projected records, and a new
  // revision reuses each record that did not change.
  const recordsBySnapshot = new WeakMap<HyperModelSnapshot, Map<number, WindowSearchRecords | undefined>>();
  const internersByWindow = new Map<number, ReturnType<typeof createSearchItemInterner>>();
  const project = (snapshot: HyperModelSnapshot, windowId: number) => {
    const records = searchRecordsForWindow(snapshot, windowId);
    for (const id of internersByWindow.keys()) {
      if (!snapshot.browser.windows.some((window) => window.id === id)) internersByWindow.delete(id);
    }
    if (!records) return undefined;
    let intern = internersByWindow.get(windowId);
    if (!intern) internersByWindow.set(windowId, intern = createSearchItemInterner());
    return { ...records, items: intern(records.items) };
  };
  const recordsFor = (snapshot: HyperModelSnapshot, windowId: number) => {
    let byWindow = recordsBySnapshot.get(snapshot);
    if (!byWindow) recordsBySnapshot.set(snapshot, byWindow = new Map());
    if (!byWindow.has(windowId)) byWindow.set(windowId, project(snapshot, windowId));
    return byWindow.get(windowId);
  };
  const updateSelections = (update: (current: SearchSelectionHistory) => SearchSelectionHistory) =>
    queueSelectionMutation(async () => {
      const current = dependencies.store.get(hyperModelAtom).runtime.searchSelectionHistory;
      const selectionHistory = update(current);
      if (selectionHistory === current) return;
      await selectionStorage.set({ [SEARCH_SELECTION_HISTORY_KEY]: selectionHistory });
      await dependencies.reconcile();
    });

  const historyItemsFor = (entries: Browser.history.HistoryItem[]): SearchItem[] =>
    buildSearchItems({
      activeSpaceId: '',
      extensionOrigin: extensionOrigin(),
      favourites: [],
      history: entries,
      spaceTabs: [],
      spaces: [],
      tabContents: {},
      tabs: [],
    });

  const updateHistory = async (
    update: (current: readonly SearchItem[]) => readonly SearchItem[],
  ): Promise<void> => {
    await initialize();
    await queueHistoryMutation(async () => {
      const next = update(historyItems);
      if (next === historyItems) return;
      historyItems = next;
      await dependencies.reconcile();
    });
  };

  const initialize = (): Promise<void> => {
    if (!initialization) {
      const loading = history.search({
        maxResults: 1200,
        startTime: historySearchStartTime(),
        text: '',
      }).then(
        (entries) => { historyItems = historyItemsFor(entries); },
        () => { historyItems = []; },
      ).then(() => dependencies.reconcile())
        .then(() => undefined);
      initialization = loading;
    }
    return initialization ?? Promise.resolve();
  };

  return {
    async deleteHistory(url) {
      await history.deleteUrl({ url });
      await updateHistory((current) => removeHistoryUrls(current, new Set([url])));
    },
    async handleHistoryRemoved(removed) {
      await updateHistory((current) => removed.allHistory
        ? (current.length === 0 ? current : [])
        : removeHistoryUrls(current, new Set(removed.urls ?? [])));
    },
    async handleHistoryTitleChanged(changed) {
      await updateHistory((current) => retitleHistoryItems(current, changed.url, changed.title));
    },
    async handleHistoryVisited(entry) {
      await updateHistory((current) => upsertHistoryItems(current, historyItemsFor([entry])));
    },
    initialize,
    async forgetSelection(resultId) {
      await updateSelections((current) => forgetSearchSelection(current, resultId));
    },
    async recordSelection(query, resultId) {
      await updateSelections((current) => recordSearchSelection(current, query, resultId));
    },
    runtimeSignals: () => ({ historySearchItems: historyItems }),
    async search(request, client) {
      await initialize();
      const snapshot = dependencies.store.get(hyperModelAtom);
      const records = recordsFor(snapshot, client.windowId);
      if (!records) return undefined;
      // In-page Search holds no projection, so the background offers it the
      // space switches and music commands its window's sidebar would.
      const contributedCommands = new Map<string, SearchCommand>(client.role === 'page-search'
        ? [
            ...shownSpaces(snapshot.hyper.spaces).map((space): SearchCommand => ({
              detail: space.id === records.activeSpaceId ? 'Current space' : 'Hyper space',
              icon: 'space',
              id: `space:${space.id}`,
              keywords: [space.title],
              label: `Switch to ${space.title}`,
            })),
            ...windowMediaCommands(snapshot, client.windowId),
          ].map((command) => [command.id, command])
        : []);
      const commands = [...request.commands, ...contributedCommands.values()];
      if (!request.query.trim()) prepareIndex(records.items);
      const results = !request.query.trim() ? recentSearchResults(
        {
          commandIds: new Set(commands.map((command) => command.id)),
          includeFolders: request.includeFolders,
          items: records.items,
          limit: Math.min(RECENT_SEARCH_LIMIT, request.limit ?? RECENT_SEARCH_LIMIT),
        },
        snapshot.runtime.searchSelectionHistory,
        records.activeSpaceId,
      ) : index.searchRequest(
        {
          commands,
          includeNavigation: true,
          items: records.items,
        },
        request.query,
        records.activeSpaceId,
        request.limit,
        request.includeFolders,
        snapshot.runtime.searchSelectionHistory,
      );
      return {
        results: results.map((result) => {
          const command = result.kind === 'command' ? contributedCommands.get(result.commandId) : undefined;
          return command ? { ...result, command } : withoutPageText(result);
        }),
        revision: snapshot.revision,
      };
    },
    async updateHistoryTitleFromTab(tab) {
      const url = tab.url ?? tab.pendingUrl;
      const title = tab.title?.trim();
      if (!url || !title || url.startsWith(extensionOrigin()) || isPlaceholderTabTitle(title, url)) return;
      await initialize();
      const matches = await history.search({
        maxResults: 20,
        startTime: historySearchStartTime(),
        text: url,
      });
      const entry = matches.find((candidate) => candidate.url === url);
      if (!entry) return;
      await updateHistory((current) => upsertHistoryItems(
        current,
        historyItemsFor([{ ...entry, title }]),
      ));
    },
  };
}