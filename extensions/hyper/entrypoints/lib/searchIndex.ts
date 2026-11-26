import { Index, type Id } from 'flexsearch';
import { clamp } from './collections';
import {
  navigationTarget,
  shouldPrioritiseWebSearch,
  webSearchTarget,
  type CommandAction,
  type NavigationTarget,
} from './commandBar';
import { wordStartMatchQuality, type SearchItem } from './search';
import {
  MAX_SEARCH_SELECTION_RESULT_ID_LENGTH,
  recentSearchSelections,
  searchSelectionPreference,
  type SearchSelectionHistory,
  type SearchSelectionPreference,
} from './searchSelection';
import {
  fuzzyCharacters,
  lowerMatchQuality,
  lowerUrlMatch,
  lowerWordStartQuality,
  orderedFuzzyCharactersMatch,
  searchItemText,
  searchTerm,
  type SearchItemText,
  type SearchTerm,
} from './searchText';
import { isHttpProtocol, pageIdentity } from './urlIdentity';

export type SearchCommand = Omit<CommandAction, 'run'>;

export type SearchRecordResult =
  // A command the background contributed carries its own descriptor.
  | { kind: 'command'; commandId: string; command?: SearchCommand }
  | { kind: 'item'; item: SearchItem };

/** Marks a result shown before anything is typed because it was picked recently. */
export interface RecentSearchMarker {
  query: string;
  resultId: string;
}

export type SharedSearchResult = (SearchRecordResult | {
  kind: 'navigate';
  target: NavigationTarget;
}) & { recent?: RecentSearchMarker };

function boundedPreferenceId(value: string): string {
  if (value.length <= MAX_SEARCH_SELECTION_RESULT_ID_LENGTH) return value;
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < value.length; index += 1) {
    hash = BigInt.asUintN(
      64,
      (hash ^ BigInt(value.charCodeAt(index))) * 0x100000001b3n,
    );
  }
  const suffix = `:hash:${hash.toString(16).padStart(16, '0')}`;
  return `${value.slice(0, MAX_SEARCH_SELECTION_RESULT_ID_LENGTH - suffix.length)}${suffix}`;
}

const itemPreferenceIds = new WeakMap<SearchItem, string>();

function itemPreferenceId(item: SearchItem): string {
  let id = itemPreferenceIds.get(item);
  if (id === undefined) {
    id = boundedPreferenceId(`${item.kind}:${item.url ? pageIdentity(item.url) ?? item.url : item.id}`);
    itemPreferenceIds.set(item, id);
  }
  return id;
}

export function searchResultPreferenceId(result: SharedSearchResult): string {
  if (result.kind === 'command') return boundedPreferenceId(`command:${result.commandId}`);
  if (result.kind === 'navigate') {
    return boundedPreferenceId(result.target.kind === 'url'
      ? `navigate:url:${pageIdentity(result.target.url) ?? result.target.url}`
      : `navigate:search:${result.target.query.toLocaleLowerCase()}`);
  }
  return itemPreferenceId(result.item);
}

export interface SearchRequestRecords {
  commands: readonly SearchCommand[];
  items: readonly SearchItem[];
}

interface SearchRequestWithNavigation extends SearchRequestRecords {
  includeNavigation: true;
}

type SearchRecord =
  | {
      key: string;
      canonicalId: string;
      kind: 'command';
      command: SearchCommand;
    }
  | {
      key: string;
      canonicalId: string;
      kind: 'item';
      item: SearchItem;
    };

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** Visits within each age earn one less step of weight than the last; older ones earn none. */
const RECENCY_BANDS_MS = [HOUR_MS, DAY_MS, 7 * DAY_MS, 30 * DAY_MS];

export function visitRecency(lastVisitTime: number | undefined, now: number): number {
  if (lastVisitTime === undefined) return 0;
  const band = RECENCY_BANDS_MS.findIndex((limit) => now - lastVisitTime <= limit);
  return band < 0 ? 0 : RECENCY_BANDS_MS.length - band;
}

/**
 * What ranking needs to know about a request's items as a whole, worked out once
 * per items array: a request built from the same projection reuses it.
 */
interface ItemsSummary {
  /** Item records by canonical ID, later duplicates replacing earlier ones in place. */
  eligible: readonly SearchRecord[];
  /** The same, without folders. */
  eligibleWithoutFolders: readonly SearchRecord[];
  /** Every eligible item record by its index key. */
  byKey: ReadonlyMap<string, SearchRecord>;
  /** Pages that are also a tab or bookmark here, whose history entries yield to them. */
  counterpartPages: ReadonlySet<string>;
  /** The latest visit to each page. */
  latestVisits: ReadonlyMap<string, number>;
}

const itemRecords = new WeakMap<SearchItem, SearchRecord>();

function itemRecord(item: SearchItem): SearchRecord {
  let record = itemRecords.get(item);
  if (!record) {
    record = { canonicalId: `item:${item.id}`, item, key: `request:item:${item.id}`, kind: 'item' };
    itemRecords.set(item, record);
  }
  return record;
}

const itemsSummaries = new WeakMap<readonly SearchItem[], ItemsSummary>();

function itemsSummary(items: readonly SearchItem[]): ItemsSummary {
  const cached = itemsSummaries.get(items);
  if (cached) return cached;
  const byCanonicalId = new Map<string, SearchRecord>();
  const counterpartPages = new Set<string>();
  const latestVisits = new Map<string, number>();
  for (const item of items) {
    const record = itemRecord(item);
    byCanonicalId.set(record.canonicalId, record);
    const { identity } = searchItemText(item);
    if (!identity) continue;
    if (item.kind === 'tab' || item.kind === 'bookmark') counterpartPages.add(identity);
    if (item.kind === 'history' && item.lastVisitTime !== undefined) {
      latestVisits.set(identity, Math.max(latestVisits.get(identity) ?? 0, item.lastVisitTime));
    }
  }
  const eligible = [...byCanonicalId.values()];
  const summary = {
    byKey: new Map(eligible.map((record) => [record.key, record])),
    counterpartPages,
    eligible,
    eligibleWithoutFolders: eligible.filter((record) =>
      record.kind !== 'item' || record.item.kind !== 'folder'),
    latestVisits,
  };
  itemsSummaries.set(items, summary);
  return summary;
}

/**
 * How recently a record's page was visited. A page that is also a tab or a
 * bookmark lends its visits to those, so they rise rather than its history entry.
 */
function recordRecency(record: SearchRecord, summary: ItemsSummary, now: number): number {
  if (record.kind !== 'item') return 0;
  const { identity } = searchItemText(record.item);
  if (!identity) return 0;
  return record.item.kind === 'history' && summary.counterpartPages.has(identity)
    ? 0
    : visitRecency(summary.latestVisits.get(identity), now);
}

const recordTexts = new WeakMap<SearchItem, string>();

function recordText(record: SearchRecord): string {
  if (record.kind === 'command') {
    return [
      record.command.label,
      record.command.detail,
      ...(record.command.keywords ?? []),
      record.command.shortcut ?? '',
    ].join(' ');
  }
  let text = recordTexts.get(record.item);
  if (text === undefined) {
    text = [
      record.item.title,
      record.item.detail,
      record.item.url ?? '',
      record.item.content ?? '',
    ].join(' ');
    recordTexts.set(record.item, text);
  }
  return text;
}

function recordAccuracy(record: SearchRecord, term: SearchTerm): number {
  if (record.kind === 'command') {
    const { command } = record;
    return Math.max(
      lowerMatchQuality(command.label.toLocaleLowerCase(), term),
      lowerMatchQuality(command.detail.toLocaleLowerCase(), term),
      lowerMatchQuality(command.keywords?.join(' ').toLocaleLowerCase() ?? '', term),
      lowerMatchQuality(command.shortcut?.toLocaleLowerCase() ?? '', term),
    );
  }
  const text = searchItemText(record.item);
  return Math.max(
    lowerMatchQuality(text.title, term),
    lowerMatchQuality(text.detail, term),
    lowerMatchQuality(text.url, term),
    lowerMatchQuality(text.content, term),
  );
}

function recordFuzzyMatch(record: SearchRecord, term: SearchTerm): boolean {
  const values = record.kind === 'command'
    ? [
        record.command.label,
        record.command.detail,
        ...(record.command.keywords ?? []),
        record.command.shortcut,
      ].flatMap((value) => value === undefined ? [] : [fuzzyCharacters(value)])
    : searchItemText(record.item).fuzzy;
  return values.some((value) => orderedFuzzyCharactersMatch(value, term.fuzzy));
}

function recordTitle(record: SearchRecord): string {
  return record.kind === 'command' ? record.command.label : record.item.title;
}

function commandWordStartQuality(command: SearchCommand, term: string): number {
  return Math.max(
    wordStartMatchQuality(command.label, term),
    ...command.keywords?.map((keyword) => wordStartMatchQuality(keyword, term)) ?? [],
    wordStartMatchQuality(command.shortcut ?? '', term),
  );
}

function tabWorkspaceSource(
  item: SearchItem,
  activeSpaceId: string,
): 'current-space' | 'other-space' | undefined {
  if (item.spaceId) {
    return item.spaceId === activeSpaceId ? 'current-space' : 'other-space';
  }
  if (item.openSpaces?.some((space) => space.id === activeSpaceId)) {
    return 'current-space';
  }
  if (item.openSpaces?.length) return 'other-space';
  if (item.source === 'current-space' || item.source === 'other-space') {
    return item.source;
  }
  return undefined;
}

/**
 * Search ranks by tiers, in this order of importance. A result earns the weight
 * of every tier it matches and is ranked by the sum, so a result matching
 * several lower tiers can pass one matching a single higher tier.
 */
const TIER = {
  chosen: 1,
  command: 2,
  title: 3,
  history: 4,
  url: 5,
  folder: 6,
  other: 7,
} as const;
/** Each tier outweighs the next by this factor: gently exponential rather than linear. */
const TIER_GROWTH = 1.5;
/**
 * Quality moves a result within 70% to 100% of its tier's weight. The tier below
 * peaks at 1 / TIER_GROWTH, about 67%, so quality alone never crosses a tier.
 */
const TIER_QUALITY_FLOOR = 0.7;

function tierScore(tier: number, quality: number, floor = TIER_QUALITY_FLOOR): number {
  const bounded = clamp(quality, 0, 1);
  return TIER_GROWTH ** (TIER.other - tier) * (floor + (1 - floor) * bounded);
}

/**
 * A pick for a similar query earns the chosen tier. A recent pick for any other
 * query only nudges, at the lowest tier's weight with no floor, so it never
 * outranks a better or fresher match.
 */
function chosenTierScore({ similarQuery, strength }: SearchSelectionPreference): number {
  return similarQuery ? tierScore(TIER.chosen, strength) : tierScore(TIER.other, strength, 0);
}

/**
 * Where a page lives, from favourites down to archived spaces' bookmarks. Steps are
 * 0.1 or more apart so a better place always wins within a tier. History has no place.
 */
function itemPlace(item: SearchItem, activeSpaceId: string): number | undefined {
  if (item.source === 'favourite') return 0.8;
  if (item.kind === 'tab') {
    const source = tabWorkspaceSource(item, activeSpaceId);
    return source === 'current-space' ? 0.6 : source === 'other-space' ? 0.4 : 0.5;
  }
  if (item.kind === 'bookmark' || item.kind === 'folder') {
    return !item.spaceId || item.spaceId === activeSpaceId ? 0.2 : item.archived ? 0 : 0.1;
  }
  return undefined;
}

function historyFreshness(lastVisitTime: number | undefined, now: number): number {
  if (lastVisitTime === undefined) return 0;
  return 1 / (1 + Math.max(0, now - lastVisitTime) / (3 * DAY_MS));
}

interface ScoringContext {
  activeSpaceId: string;
  /** Pages that are also a tab or bookmark here, whose history entries yield to them. */
  counterpartPages: ReadonlySet<string>;
  now: number;
  preference: (resultId: string) => SearchSelectionPreference | undefined;
  term: SearchTerm;
}

function historyMatch(text: SearchItemText, term: SearchTerm, url: boolean): number {
  const title = lowerWordStartQuality(text.title, term.text);
  if (title > 0) return title === 4 ? 1 : title === 3 ? 0.85 : 0.7;
  if (url) return 0.55;
  return lowerMatchQuality(text.title, term) > 0 || lowerMatchQuality(text.url, term) > 0 ? 0.3 : 0;
}

const startsWordIn = (values: readonly string[], word: string) =>
  values.some((value) => lowerWordStartQuality(value, word) > 0);

/**
 * How well the folders holding a bookmark, folder or tab match, from 0 to 0.49,
 * or undefined when they do not. The whole query may begin a word of one
 * folder's name. A query of several words also matches when each word begins a
 * word of the title, a folder or the space, and at least one is in the title or
 * a folder: a space's name alone would match everything in it. The more words
 * the title holds, the better, so a title holding every word, in any order,
 * scores best and stays above any record that needs its folders to match.
 */
function folderMatch(text: SearchItemText, term: SearchTerm): number | undefined {
  const whole = Math.max(0, ...text.folders.map((folder) => lowerWordStartQuality(folder, term.text)));
  let quality = whole > 0 ? 0.49 * ((whole - 2) / 2) : undefined;
  const { words } = term;
  if (words.length === 0) return quality;
  let inTitle = 0;
  let inFolder = false;
  for (const word of words) {
    const title = lowerWordStartQuality(text.title, word) > 0;
    const folder = startsWordIn(text.folders, word);
    if (!title && !folder && !startsWordIn(text.spaces, word)) return quality;
    if (title) inTitle += 1;
    if (folder) inFolder = true;
  }
  if (inTitle === 0 && !inFolder) return quality;
  // A title already holding the whole query earns the title tier instead.
  if (inTitle === words.length && lowerWordStartQuality(text.title, term.text) > 0) return quality;
  return Math.max(quality ?? 0, 0.25 + 0.24 * (inTitle / words.length));
}

/** The sum of the tier weights a record earns, or 0 when it matches no tier. */
function recordScore(record: SearchRecord, context: ScoringContext): number {
  const { activeSpaceId, term } = context;
  if (record.kind === 'command') {
    const quality = commandWordStartQuality(record.command, term.text);
    return quality > 0 ? tierScore(TIER.command, (quality - 2) / 2) : 0;
  }
  const { item } = record;
  const text = searchItemText(item);
  let score = 0;
  const place = itemPlace(item, activeSpaceId);
  const title = lowerWordStartQuality(text.title, term.text);
  if (title > 0 && place !== undefined) {
    score += tierScore(TIER.title, place + 0.09 * ((title - 2) / 2));
  }
  const url = Boolean(item.url) && lowerUrlMatch(text.urlLetters, text.url, term);
  if (item.kind === 'history') {
    const match = text.identity && context.counterpartPages.has(text.identity)
      ? 0
      : historyMatch(text, term, url);
    if (match > 0) {
      score += tierScore(
        TIER.history,
        0.6 * match + 0.4 * historyFreshness(item.lastVisitTime, context.now),
      );
    }
  }
  if (url) score += tierScore(TIER.url, 0.9 * (place === undefined ? 0 : place + 0.2));
  const folder = folderMatch(text, term);
  if (folder !== undefined) {
    score += tierScore(TIER.folder, (place ?? 0) * 2.5 + folder);
  }
  return score;
}

function chosenScore(resultId: string, context: ScoringContext): number {
  const preference = context.preference(resultId);
  return preference === undefined ? 0 : chosenTierScore(preference);
}

function projectedItem(item: SearchItem, activeSpaceId: string): SearchItem {
  const workspaceSource = item.kind === 'tab'
    ? tabWorkspaceSource(item, activeSpaceId)
    : item.spaceId
      ? item.spaceId === activeSpaceId
        ? 'current-space' as const
        : 'other-space' as const
      : undefined;
  return workspaceSource
    ? {
        ...item,
        detail: item.detail.replace(
          / · (?:current|other) workspace$/,
          workspaceSource === 'current-space'
            ? ' · current workspace'
            : ' · other workspace',
        ),
        source: workspaceSource,
      }
    : item;
}

const recentItemKinds = ['tab', 'bookmark', 'history'] as const;

function preferredRecentItem(current: SearchItem | undefined, candidate: SearchItem): SearchItem {
  if (!current) return candidate;
  const rank = (item: SearchItem) => item.kind === 'tab'
    ? 0
    : item.source === 'favourite' ? 1 : item.kind === 'bookmark' ? 2 : 3;
  return rank(candidate) < rank(current) ? candidate : current;
}

function pageNavigation(url: string): NavigationTarget | undefined {
  try {
    const parsed = new URL(url);
    if (!isHttpProtocol(parsed.protocol)) return undefined;
    return { kind: 'url', url: parsed.href, label: `Go to ${parsed.hostname}`, detail: parsed.href };
  } catch {
    return undefined;
  }
}

export interface RecentSearchRequest {
  /** Commands the asking view can run; a recent command it cannot run is skipped. */
  commandIds: ReadonlySet<string>;
  includeFolders?: boolean;
  items: readonly SearchItem[];
  limit?: number;
}

/**
 * What Search shows before anything is typed: the latest picks, each resolved
 * against the records of this request. A pick whose tab has since closed falls
 * back to the same page as a bookmark, history entry or plain address.
 */
export function recentSearchResults(
  request: RecentSearchRequest,
  selectionHistory: SearchSelectionHistory,
  activeSpaceId: string,
): SharedSearchResult[] {
  const limit = request.limit ?? 10;
  const byPreferenceId = new Map<string, SearchItem>();
  const byPage = new Map<string, SearchItem>();
  for (const item of request.items) {
    if (item.kind === 'folder' && request.includeFolders === false) continue;
    const preferenceId = itemPreferenceId(item);
    byPreferenceId.set(preferenceId, preferredRecentItem(byPreferenceId.get(preferenceId), item));
    const identity = item.kind === 'folder' ? undefined : pageIdentity(item.url);
    if (identity) byPage.set(identity, preferredRecentItem(byPage.get(identity), item));
  }
  const results: SharedSearchResult[] = [];
  const shown = new Set<string>();
  for (const { query, resultId } of recentSearchSelections(selectionHistory)) {
    if (results.length >= limit) break;
    const recent = { query, resultId };
    let result: SharedSearchResult | undefined;
    if (resultId.startsWith('command:')) {
      const commandId = resultId.slice('command:'.length);
      if (request.commandIds.has(commandId)) result = { kind: 'command', commandId, recent };
    } else if (resultId.startsWith('navigate:search:')) {
      const target = webSearchTarget(resultId.slice('navigate:search:'.length));
      if (target) result = { kind: 'navigate', target, recent };
    } else if (resultId.startsWith('navigate:url:')) {
      const url = resultId.slice('navigate:url:'.length);
      const target = pageNavigation(url);
      if (target) result = { kind: 'navigate', target, recent };
    } else {
      const exact = byPreferenceId.get(resultId);
      const kind = recentItemKinds.find((candidate) => resultId.startsWith(`${candidate}:`));
      const page = kind ? resultId.slice(kind.length + 1) : undefined;
      const item = exact ?? (page ? byPage.get(page) : undefined);
      if (item) result = { kind: 'item', item: projectedItem(item, activeSpaceId), recent };
      else if (page) {
        const target = pageNavigation(page);
        if (target) result = { kind: 'navigate', target, recent };
      }
    }
    if (!result) continue;
    const shownAs = result.kind === 'item'
      ? `item:${result.item.id}`
      : searchResultPreferenceId(result);
    if (shown.has(shownAs)) continue;
    shown.add(shownAs);
    results.push(result);
  }
  return results;
}

interface ScoredResult {
  result: SearchRecordResult;
  score: number;
}

/**
 * Ranks only the records each request supplies. The text indexes stay warm
 * between requests so typing stays fast, but they are synced to the request's
 * records first and every hit is checked against them, so nothing outside the
 * request's revision and window can be returned.
 */
const titleCollator = new Intl.Collator();

interface Candidate {
  accuracy: number;
  record: SearchRecord;
  score: number;
}

export class SharedSearchIndex {
  private readonly prefixIndex = new Index({ tokenize: 'forward', resolution: 9 });
  private readonly tolerantIndex = new Index({ tokenize: 'tolerant', resolution: 9 });
  private readonly indexedText = new Map<string, string>();
  /** The items and command text the indexes last matched, so an unchanged request skips syncing. */
  private synced: { commands: string; items: readonly SearchItem[] } | undefined;

  constructor(private readonly now: () => number = Date.now) {}

  private indexRecord(key: string, text: string): void {
    const previous = this.indexedText.get(key);
    if (previous === text) return;
    if (previous === undefined) {
      this.prefixIndex.add(key, text);
      this.tolerantIndex.add(key, text);
    } else {
      this.prefixIndex.update(key, text);
      this.tolerantIndex.update(key, text);
    }
    this.indexedText.set(key, text);
  }

  /**
   * Indexes up to `count` of these items ahead of a query and says whether any
   * remain, so the first build can be spread over idle turns while the user is
   * still to type. The next query still syncs the index to its own records.
   */
  prepare(items: readonly SearchItem[], count: number): boolean {
    let indexed = 0;
    for (const item of items) {
      const record = itemRecord(item);
      const text = recordText(record);
      if (this.indexedText.get(record.key) === text) continue;
      if (indexed === count) return true;
      this.indexRecord(record.key, text);
      indexed += 1;
    }
    return false;
  }

  private syncIndex(
    items: readonly SearchItem[],
    commandRecords: readonly SearchRecord[],
  ): void {
    const commands = commandRecords.map((record) => `${record.key}\n${recordText(record)}`).join('\n');
    if (this.synced?.items === items && this.synced.commands === commands) return;
    const current = new Set<string>();
    for (const record of [...items.map(itemRecord), ...commandRecords]) {
      current.add(record.key);
      this.indexRecord(record.key, recordText(record));
    }
    for (const key of this.indexedText.keys()) {
      if (current.has(key)) continue;
      this.prefixIndex.remove(key);
      this.tolerantIndex.remove(key);
      this.indexedText.delete(key);
    }
    this.synced = { commands, items };
  }

  private searchRecords(
    request: SearchRequestRecords,
    query: string,
    activeSpaceId: string,
    limit: number,
    includeFolders: boolean,
    preference: (resultId: string) => SearchSelectionPreference | undefined,
  ): ScoredResult[] {
    const term = searchTerm(query);
    if (!term.text) return [];
    const summary = itemsSummary(request.items);
    const commandsById = new Map<string, SearchRecord>();
    for (const command of request.commands) {
      commandsById.set(command.id, {
        canonicalId: `command:${command.id}`,
        command,
        key: `request:command:${command.id}`,
        kind: 'command',
      });
    }
    const commandRecords = [...commandsById.values()];
    const eligible = [
      ...includeFolders ? summary.eligible : summary.eligibleWithoutFolders,
      ...commandRecords,
    ];
    const now = this.now();
    const context: ScoringContext = {
      activeSpaceId,
      counterpartPages: summary.counterpartPages,
      now,
      preference,
      term,
    };
    const candidates = new Map<string, Candidate>();
    for (const record of eligible) {
      const score = recordScore(record, context);
      const accuracy = recordAccuracy(record, term);
      if (score > 0 || accuracy > 0) candidates.set(record.key, { accuracy, record, score });
    }

    this.syncIndex(request.items, commandRecords);
    const commandsByKey = new Map(commandRecords.map((record) => [record.key, record]));
    const eligibleRecord = (key: string) => {
      const record = summary.byKey.get(key) ?? commandsByKey.get(key);
      return !includeFolders && record?.kind === 'item' && record.item.kind === 'folder'
        ? undefined
        : record;
    };
    const searchLimit = Math.max(limit, request.items.length + commandRecords.length);
    const fuzzyRank = new Map<string, number>();
    let fuzzyIndex = 0;
    // Without `suggest`, a hit holds every word of the query, never only some.
    for (const id of [
      ...this.prefixIndex.search(query.trim(), { limit: searchLimit }),
      ...this.tolerantIndex.search(query.trim(), { limit: searchLimit }),
    ] as Id[]) {
      const key = String(id);
      const record = eligibleRecord(key);
      if (!record || !recordFuzzyMatch(record, term)) continue;
      if (!fuzzyRank.has(key)) fuzzyRank.set(key, fuzzyIndex);
      fuzzyIndex += 1;
      if (!candidates.has(key)) candidates.set(key, { accuracy: 0, record, score: 0 });
    }
    const fuzzyCount = Math.max(1, fuzzyRank.size);

    const ranked = [...candidates.values()].map((candidate) => {
      const { accuracy, record } = candidate;
      let { score } = candidate;
      // Matches no tier names, such as page text or a tolerant misspelling, still count a little.
      if (score === 0) {
        const fuzzy = fuzzyRank.get(record.key);
        score = tierScore(
          TIER.other,
          0.5 * (accuracy / 4) + 0.5 * (fuzzy === undefined ? 0 : 1 - fuzzy / fuzzyCount),
        );
      }
      const preferenceId = record.kind === 'command'
        ? boundedPreferenceId(`command:${record.command.id}`)
        : itemPreferenceId(record.item);
      score += chosenScore(preferenceId, context);
      return { accuracy, recency: recordRecency(record, summary, now), record, score };
    });
    return ranked
      .sort((left, right) =>
        right.score - left.score ||
        right.accuracy - left.accuracy ||
        // Slight: recency only orders matches that are otherwise equally good.
        right.recency - left.recency ||
        titleCollator.compare(recordTitle(left.record), recordTitle(right.record)))
      .slice(0, limit)
      .map(({ record, score }) => ({
        result: record.kind === 'command'
          ? { kind: 'command', commandId: record.command.id }
          : { kind: 'item', item: projectedItem(record.item, activeSpaceId) },
        score,
      }));
  }

  searchRequest(
    request: SearchRequestWithNavigation,
    query: string,
    activeSpaceId: string,
    limit?: number,
    includeFolders?: boolean,
    selectionHistory?: SearchSelectionHistory,
  ): SharedSearchResult[];
  searchRequest(
    request: SearchRequestRecords,
    query: string,
    activeSpaceId: string,
    limit?: number,
    includeFolders?: boolean,
    selectionHistory?: SearchSelectionHistory,
  ): SearchRecordResult[];
  searchRequest(
    request: SearchRequestRecords | SearchRequestWithNavigation,
    query: string,
    activeSpaceId: string,
    limit = 24,
    includeFolders = true,
    selectionHistory: SearchSelectionHistory = {},
  ): SharedSearchResult[] {
    const preference = searchSelectionPreference(selectionHistory, query, this.now());
    const scored = this.searchRecords(
      request,
      query,
      activeSpaceId,
      limit,
      includeFolders,
      preference,
    );
    const results = scored.map(({ result }) => result);
    const target = 'includeNavigation' in request && request.includeNavigation
      ? navigationTarget(query)
      : undefined;
    if (!target) return results;
    const navigation = { kind: 'navigate' as const, target };
    // An address typed out is where the user means to go.
    if (target.kind === 'url') return [navigation, ...results];
    const chosen = preference(searchResultPreferenceId(navigation));
    if (chosen !== undefined) {
      const score = chosenTierScore(chosen);
      const index = scored.findIndex((candidate) => candidate.score < score);
      return index < 0
        ? [...results, navigation]
        : [...results.slice(0, index), navigation, ...results.slice(index)];
    }
    return shouldPrioritiseWebSearch(results, query)
      ? [navigation, ...results]
      : [...results, navigation];
  }
}

export function serialiseSearchCommands(commands: CommandAction[]): SearchCommand[] {
  return commands.map(({ run: _run, ...command }) => command);
}