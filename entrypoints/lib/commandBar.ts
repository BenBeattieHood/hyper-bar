import { urlMatch, type SearchItem } from './search';
import { normaliseQuery } from './searchText';
import { isHttpProtocol } from './urlIdentity';

export type CommandIcon =
  | 'back'
  | 'bookmark'
  | 'close'
  | 'copy'
  | 'duplicate'
  | 'forward'
  | 'fullscreen'
  | 'history'
  | 'move-window'
  | 'music'
  | 'mute'
  | 'new-tab'
  | 'new-window'
  | 'pause'
  | 'pin'
  | 'play'
  | 'private'
  | 'reload'
  | 'restore'
  | 'settings'
  | 'space'
  | 'sound'
  | 'tab'
  | 'zoom-in'
  | 'zoom-out'
  | 'zoom-reset';

export interface CommandAction {
  id: string;
  label: string;
  detail: string;
  icon: CommandIcon;
  keywords?: string[];
  shortcut?: string;
  /** The tab the command acts on, so a host given only its descriptor can still run it. */
  tabId?: number;
  run: () => void | Promise<void>;
}

export type NavigationTarget =
  | {
      kind: 'url';
      url: string;
      label: string;
      detail: string;
    }
  | {
      kind: 'search';
      query: string;
      label: string;
      detail: string;
    };

export type SearchRankingCandidate =
  | { kind: 'command' }
  | { kind: 'item'; item: SearchItem };

export function selectedResultIndex(
  results: readonly { id: string }[],
  selectedId?: string,
): number {
  if (!selectedId) return 0;
  const index = results.findIndex((result) => result.id === selectedId);
  return index >= 0 ? index : 0;
}

export function isDirectSearchShortcut(event: Pick<
  KeyboardEvent,
  'altKey' | 'ctrlKey' | 'key' | 'metaKey'
>): boolean {
  return event.key === 'Enter' && (event.altKey || event.ctrlKey || event.metaKey);
}

/** A modified or middle click opens a result beside the current tab, as it would a link. */
export function opensInNewTab(event: Pick<MouseEvent, 'button' | 'ctrlKey' | 'metaKey'>): boolean {
  return event.button === 1 || event.ctrlKey || event.metaKey;
}

/**
 * Counts local midnights since the visit, less one when it is now before 3am
 * or the visit was more than 20 hours ago.
 */
function historyVisitDaysAgo(visited: Date, now: Date): number {
  const visitedDay = new Date(visited.getFullYear(), visited.getMonth(), visited.getDate());
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  // Rounding absorbs the hour a daylight-saving change adds to or removes from a day.
  const midnights = Math.round((today.getTime() - visitedDay.getTime()) / 86_400_000);
  const elapsedMs = now.getTime() - visited.getTime();
  return now.getHours() < 3 || elapsedMs > 20 * 3_600_000 ? midnights - 1 : midnights;
}

export function formatHistoryVisitDate(
  timestamp: number | undefined,
  now = new Date(),
): string | undefined {
  if (timestamp === undefined || !Number.isFinite(timestamp)) return undefined;
  const visited = new Date(timestamp);
  if (Number.isNaN(visited.getTime())) return undefined;
  const daysAgo = Math.max(0, historyVisitDaysAgo(visited, now));
  const weekday = new Intl.DateTimeFormat('en-US', { weekday: 'short' }).format(visited);
  const time = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    hourCycle: 'h23',
    minute: '2-digit',
  }).format(visited);
  if (daysAgo === 0) return time;
  return `${weekday}, ${daysAgo}d ago, ${time}`;
}

function textMatchQuality(value: string, query: string): number {
  const normalised = normaliseQuery(value);
  if (normalised === query) return 4;
  if (normalised.startsWith(query)) return 3;
  if (normalised.split(/[^\p{L}\p{N}]+/u).some((word) => word.startsWith(query))) return 2;
  if (normalised.includes(query)) return 1;
  return 0;
}

function pageMatchQuality(item: SearchItem, query: string): number {
  const directQuality = Math.max(
    textMatchQuality(item.title, query),
    textMatchQuality(item.detail, query),
    textMatchQuality(item.url ?? '', query),
    textMatchQuality(item.content ?? '', query),
  );
  return item.url && urlMatch(item.url, query)
    ? Math.max(directQuality, 2)
    : directQuality;
}

export function shouldPrioritiseWebSearch(
  results: readonly SearchRankingCandidate[],
  query: string,
): boolean {
  const normalisedQuery = normaliseQuery(query);
  if (!normalisedQuery || results.some((result) => result.kind === 'command')) return false;
  const pages = results.filter(
    (result): result is Extract<SearchRankingCandidate, { kind: 'item' }> =>
      result.kind === 'item' && ['bookmark', 'tab'].includes(result.item.kind),
  );
  return pages.every(({ item }) => pageMatchQuality(item, normalisedQuery) <= 1);
}

function commandScore(command: CommandAction, query: string): number {
  const label = normaliseQuery(command.label);
  const detail = normaliseQuery(command.detail);
  const keywords = command.keywords?.map(normaliseQuery) ?? [];
  if (label === query) return 0;
  if (label.startsWith(query)) return 1;
  if (keywords.some((keyword) => keyword === query)) return 2;
  if (label.includes(query)) return 3;
  if (keywords.some((keyword) => keyword.includes(query))) return 4;
  if (detail.includes(query)) return 5;
  return Number.POSITIVE_INFINITY;
}

export function matchingCommands(
  commands: CommandAction[],
  query: string,
  limit = 12,
): CommandAction[] {
  const normalisedQuery = normaliseQuery(query);
  if (!normalisedQuery) return commands.slice(0, limit);
  return commands
    .map((command, index) => ({
      command,
      index,
      score: commandScore(command, normalisedQuery),
    }))
    .filter(({ score }) => Number.isFinite(score))
    .sort((left, right) => left.score - right.score || left.index - right.index)
    .slice(0, limit)
    .map(({ command }) => command);
}

function explicitUrl(value: string): URL | undefined {
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      return isHttpProtocol(url.protocol) ? url : undefined;
    } catch {
      return undefined;
    }
  }
  if (
    /^(localhost|\d{1,3}(?:\.\d{1,3}){3})(:\d+)?(?:[/?#]|$)/i.test(value) ||
    /^[^\s./]+(?:\.[^\s./]+)+(?:[/:?#]|$)/.test(value)
  ) {
    try {
      return new URL(`https://${value}`);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function navigationTarget(query: string): NavigationTarget | undefined {
  const value = query.trim();
  if (!value) return undefined;
  const url = explicitUrl(value);
  if (url) {
    return {
      kind: 'url',
      url: url.href,
      label: `Go to ${url.hostname}`,
      detail: url.href,
    };
  }
  return webSearchTarget(value);
}

export function webSearchTarget(query: string): NavigationTarget | undefined {
  const value = query.trim();
  if (!value) return undefined;
  return {
    kind: 'search',
    query: value,
    label: `Search the web for “${value}”`,
    detail: 'Search',
  };
}