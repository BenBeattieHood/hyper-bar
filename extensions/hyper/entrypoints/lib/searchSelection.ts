import { isRecord } from './collections';
import { normaliseQuery } from './searchText';
export const SEARCH_SELECTION_HISTORY_KEY = 'hyperSearchSelectionHistory';

export const MAX_SEARCH_SELECTION_QUERY_LENGTH = 512;
export const MAX_SEARCH_SELECTION_RESULT_ID_LENGTH = 1_024;
const MAX_QUERIES = 100;
const MAX_RESULTS_PER_QUERY = 20;

interface SearchSelection {
  count: number;
  lastUsed: number;
}

export type SearchSelectionHistory = Record<string, Record<string, SearchSelection>>;

function recordFromEntries<Value>(
  entries: Iterable<readonly [string, Value]>,
): Record<string, Value> {
  return Object.fromEntries(entries) as Record<string, Value>;
}

function ownValue<Value>(
  record: Readonly<Record<string, Value>>,
  key: string,
): Value | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function isSelection(value: unknown): value is SearchSelection {
  if (!isRecord(value)) return false;
  const candidate = value as Record<string, unknown>;
  return Object.hasOwn(candidate, 'count') &&
    typeof candidate.count === 'number' &&
    Number.isSafeInteger(candidate.count) &&
    candidate.count > 0 &&
    Object.hasOwn(candidate, 'lastUsed') &&
    typeof candidate.lastUsed === 'number' &&
    Number.isFinite(candidate.lastUsed);
}

export function parseSearchSelectionHistory(value: unknown): SearchSelectionHistory {
  if (!isRecord(value)) return {};
  const history = new Map<string, Record<string, SearchSelection>>();
  for (const [query, selections] of Object.entries(value)) {
    const key = normaliseQuery(query);
    if (
      !key ||
      key.length > MAX_SEARCH_SELECTION_QUERY_LENGTH ||
      !selections ||
      typeof selections !== 'object' ||
      Array.isArray(selections)
    ) continue;
    const validSelections: Array<readonly [string, SearchSelection]> = [];
    for (const [resultId, selection] of Object.entries(selections)) {
      if (
        resultId.length <= MAX_SEARCH_SELECTION_RESULT_ID_LENGTH &&
        isSelection(selection)
      ) validSelections.push([resultId, selection]);
    }
    if (validSelections.length > 0) {
      history.set(key, latestSelections(validSelections));
    }
  }
  return latestQueries(history);
}

/** The most recently picked results for one query, newest first. */
function latestSelections(selections: Iterable<readonly [string, SearchSelection]>): Record<string, SearchSelection> {
  return recordFromEntries([...selections]
    .sort((left, right) => right[1].lastUsed - left[1].lastUsed)
    .slice(0, MAX_RESULTS_PER_QUERY));
}

/** The most recently used queries, newest first. */
function latestQueries(history: Map<string, Record<string, SearchSelection>>): SearchSelectionHistory {
  const latest = (selections: Record<string, SearchSelection>) =>
    Math.max(...Object.values(selections).map(({ lastUsed }) => lastUsed));
  return recordFromEntries([...history.entries()]
    .sort((left, right) => latest(right[1]) - latest(left[1]))
    .slice(0, MAX_QUERIES));
}

export function recordSearchSelection(
  history: SearchSelectionHistory,
  query: string,
  resultId: string,
  now = Date.now(),
): SearchSelectionHistory {
  const key = normaliseQuery(query);
  if (
    !key ||
    key.length > MAX_SEARCH_SELECTION_QUERY_LENGTH ||
    !resultId ||
    resultId.length > MAX_SEARCH_SELECTION_RESULT_ID_LENGTH
  ) return history;
  const previousSelections = ownValue(history, key);
  const selections = new Map(Object.entries(previousSelections ?? {}).flatMap(([id, selection]) =>
    isSelection(selection) ? [[id, selection] as const] : [],
  ));
  const current = selections.get(resultId);
  selections.set(resultId, {
    count: Math.min(Number.MAX_SAFE_INTEGER, (current?.count ?? 0) + 1),
    lastUsed: now,
  });
  const next = new Map(Object.entries(history));
  next.set(key, latestSelections(selections.entries()));
  return latestQueries(next);
}

/** Drops a result from every query it was picked for, so it neither shows as recent nor ranks first. */
export function forgetSearchSelection(
  history: SearchSelectionHistory,
  resultId: string,
): SearchSelectionHistory {
  let changed = false;
  const next = new Map<string, Record<string, SearchSelection>>();
  for (const [query, selections] of Object.entries(history)) {
    if (!Object.hasOwn(selections, resultId)) {
      next.set(query, selections);
      continue;
    }
    changed = true;
    const retained = Object.entries(selections).filter(([id]) => id !== resultId);
    if (retained.length > 0) next.set(query, recordFromEntries(retained));
  }
  return changed ? recordFromEntries(next.entries()) : history;
}

export interface RecentSearchSelection {
  /** The query it was last picked for, so picking it again keeps that history. */
  query: string;
  resultId: string;
  lastUsed: number;
}

/** Every remembered pick, newest first, each result once with the query it was last picked for. */
export function recentSearchSelections(history: SearchSelectionHistory): RecentSearchSelection[] {
  const latest = new Map<string, RecentSearchSelection>();
  for (const [query, selections] of Object.entries(history)) {
    for (const [resultId, selection] of Object.entries(selections)) {
      if (!isSelection(selection)) continue;
      const current = latest.get(resultId);
      if (!current || selection.lastUsed > current.lastUsed) {
        latest.set(resultId, { lastUsed: selection.lastUsed, query, resultId });
      }
    }
  }
  return [...latest.values()].sort((left, right) => right.lastUsed - left.lastUsed);
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** A pick made for another query only counts as recent within this window. */
export const RECENT_SELECTION_WINDOW_MS = 30 * DAY_MS;

/** Queries are similar when, normalised, one is the other or begins it, as when typing on. */
function similarQueries(left: string, right: string): boolean {
  return left.startsWith(right) || right.startsWith(left);
}

export interface SearchSelectionPreference {
  /** From 0 to 1: fresher and, for similar queries, more often picked is stronger. */
  strength: number;
  /** Whether it was picked for a query similar to this one, which earns the whole tier. */
  similarQuery: boolean;
}

/**
 * How strongly a past pick should lift a result for this query, or undefined
 * when it was never picked or only long ago for some dissimilar query. Picks for
 * a similar query always count and grow with repeated use; any other recent pick
 * counts only by how fresh it is.
 */
export function searchSelectionPreference(
  history: SearchSelectionHistory,
  query: string,
  now = Date.now(),
): (resultId: string) => SearchSelectionPreference | undefined {
  const normalised = normaliseQuery(query);
  const similar = normalised
    ? Object.entries(history).filter(([picked]) => similarQueries(picked, normalised))
    : [];
  const latest = new Map(recentSearchSelections(history).map(
    ({ lastUsed, resultId }) => [resultId, lastUsed] as const,
  ));
  return (resultId) => {
    const lastUsed = latest.get(resultId);
    if (lastUsed === undefined) return undefined;
    const count = Math.max(0, ...similar.map(([, selections]) => {
      const selection = ownValue(selections, resultId);
      return isSelection(selection) ? selection.count : 0;
    }));
    const age = Math.max(0, now - lastUsed);
    if (count === 0 && age > RECENT_SELECTION_WINDOW_MS) return undefined;
    const freshness = 1 / (1 + age / DAY_MS);
    const repetition = Math.min(1, Math.log2(count + 1) / 3);
    return { strength: 0.5 * freshness + 0.5 * repetition, similarQuery: count > 0 };
  };
}
