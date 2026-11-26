import {
  ArrowLeft,
  ArrowRight,
  Bookmark,
  Copy,
  ExternalLink,
  FolderClosed,
  Globe2,
  History,
  Maximize2,
  Music2,
  PanelTop,
  PanelsTopLeft,
  Pause,
  Pin,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Settings,
  Shield,
  SquareStack,
  Trash2,
  Volume2,
  VolumeX,
  X,
  ZoomIn,
  ZoomOut,
  type LucideIcon,
} from 'lucide-react';
import {
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from 'react';
import {
  formatHistoryVisitDate,
  isDirectSearchShortcut,
  opensInNewTab,
  selectedResultIndex,
  webSearchTarget,
  type CommandAction,
  type CommandIcon,
  type NavigationTarget,
} from '../../lib/commandBar';
import {
  highlightedTextSegments,
  urlSearchPresentation,
  type SearchItem,
} from '../../lib/search';
import {
  searchResultPreferenceId,
  serialiseSearchCommands,
  type SearchCommand,
  type SharedSearchResult,
} from '../../lib/searchIndex';
import type { SearchQueryMessage } from '../../lib/modelProtocol';
import { itemTooltip } from '../lib/itemTooltip';
import { listen } from '../lib/listen';
import {
  contextMenuAnchor,
  isMenuKey,
  keyboardMenuAnchor,
  menuGroups,
  useContextMenu,
  type ContextMenuAnchor,
  type ContextMenuEntry,
} from './ContextMenu';
import { accessibleFaviconSource, Favicon } from '@hyper/ui';
import './CommandBar.css';

interface CommandBarProps {
  activeSpaceId: string;
  commands: CommandAction[];
  inputRef?: RefObject<HTMLInputElement | null>;
  historyLoading?: boolean;
  modelRevision: number;
  search: (
    request: Omit<SearchQueryMessage, 'requestId' | 'type'>,
  ) => Promise<SearchResponse | undefined>;
  showFolders?: boolean;
  spaceColours?: Record<string, string>;
  /** The search or address this page is loading, shown in place of the field until it leaves. */
  underway?: string;
  variant?: 'sidebar' | 'newtab';
  onActivateItem: (
    item: SearchItem,
    destinationSpaceId?: string,
    options?: { newTab?: boolean },
  ) => void | Promise<void>;
  onClose?: (reason: 'activate' | 'dismiss') => void;
  /** Closes a tab result's page wherever that space has it open, without switching to it. */
  onCloseInSpace?: (tabId: number, spaceId: string) => void;
  onDeleteHistory: (url: string) => void | Promise<void>;
  /** What this host can do with a result, beyond opening it, for the result's context menu. */
  itemMenu?: (item: SearchItem) => ContextMenuEntry[];
  onNavigate: (target: NavigationTarget, options?: { newTab?: boolean }) => void | Promise<void>;
  /** Removes a pick from the recent results and from what ranks later searches. */
  onForgetSearchSelection: (resultId: string) => void | Promise<unknown>;
  onRecordSearchSelection: (query: string, resultId: string) => void | Promise<unknown>;
  /** Makes a command the background contributed runnable here, if this host can run it. */
  resolveCommand?: (command: SearchCommand) => CommandAction | undefined;
}

export interface SearchResponse {
  results: SharedSearchResult[];
  revision: number;
}

export interface SharedSearchState {
  key: string;
  results: SharedSearchResult[];
  sequence: number;
}

/**
 * An answer lands while its query is still the one typed, unless a later
 * request's answer already has, and a failed one keeps what the query had. A
 * model change only asks again, so a busy model cannot starve the results.
 */
export function nextSharedSearch(
  current: SharedSearchState,
  answer: { key: string; results?: SharedSearchResult[]; sequence: number },
  liveKey: string,
): SharedSearchState {
  if (answer.key !== liveKey) return current;
  if (current.key === answer.key && (current.sequence > answer.sequence || !answer.results)) {
    return current;
  }
  return { key: answer.key, results: answer.results ?? [], sequence: answer.sequence };
}

/**
 * A remembered empty-query answer paints at once, but it describes an older
 * model, so Enter waits for the background's answer rather than acting on it.
 */
export function searchAnswerState(
  typed: string,
  deferred: string,
  answered: boolean,
): { enterWaits: boolean; pending: boolean } {
  const pending = typed !== deferred || (Boolean(deferred) && !answered);
  return { enterWaits: pending || !answered, pending };
}

type CommandBarResult = { recent?: boolean; selectionId?: string; selectionQuery?: string } & (
  | { id: string; kind: 'command'; command: CommandAction }
  | { id: string; kind: 'item'; item: SearchItem }
  | { id: string; kind: 'navigate'; target: NavigationTarget }
);
type ItemResult = Extract<CommandBarResult, { kind: 'item' }>;

const COMMAND_ICONS: Record<CommandIcon, LucideIcon> = {
  back: ArrowLeft,
  bookmark: Bookmark,
  close: X,
  copy: Copy,
  duplicate: SquareStack,
  forward: ArrowRight,
  fullscreen: Maximize2,
  history: History,
  'move-window': ExternalLink,
  music: Music2,
  mute: VolumeX,
  'new-tab': Plus,
  'new-window': PanelsTopLeft,
  pause: Pause,
  pin: Pin,
  play: Play,
  private: Shield,
  reload: RefreshCw,
  restore: History,
  settings: Settings,
  space: PanelsTopLeft,
  sound: Volume2,
  tab: PanelTop,
  'zoom-in': ZoomIn,
  'zoom-out': ZoomOut,
  'zoom-reset': RotateCcw,
};

function HighlightedText({ value, query }: { value: string; query: string }) {
  return highlightedTextSegments(value, query).map((segment, index) =>
    segment.matched
      ? <mark key={index}>{segment.text}</mark>
      : segment.text,
  );
}

function HighlightedUrl({ url, query }: { url: string; query: string }) {
  const presentation = urlSearchPresentation(url, query);
  if (!presentation.recentered) {
    return <HighlightedText value={presentation.text} query={query} />;
  }
  return (
    <>
      <span className="command-result-url-prefix">{presentation.prefix}</span>
      <mark>{presentation.match}</mark>
      <span className="command-result-url-suffix">
        <HighlightedText value={presentation.suffix} query={query} />
      </span>
    </>
  );
}

function historyIconSources(item: SearchItem): string[] {
  if (!item.url) return [];
  const extensionRoot = (globalThis as typeof globalThis & {
    browser?: { runtime?: { getURL?: (path: string) => string } };
  }).browser?.runtime?.getURL?.('/') ?? `${location.origin}/`;
  const tabSource = accessibleFaviconSource(item.faviconUrl, extensionRoot);
  const cachedSource = new URL(
    `_favicon/?pageUrl=${encodeURIComponent(item.url)}&size=16`,
    extensionRoot,
  ).href;
  return tabSource && tabSource !== cachedSource ? [tabSource, cachedSource] : [cachedSource];
}

/**
 * Shows the history glyph until the page's own icon loads, then fades the
 * page icon in over it. A source that fails falls through to the next one.
 */
function HistoryResultIcon({ item }: { item: SearchItem }) {
  const sources = historyIconSources(item);
  const sourcesKey = sources.join('\n');
  const [failedCount, setFailedCount] = useState(0);
  const src = sources[failedCount];
  const [loadedSrc, setLoadedSrc] = useState<string>();

  useEffect(() => {
    setFailedCount(0);
    setLoadedSrc(undefined);
  }, [sourcesKey]);

  const loaded = src !== undefined && loadedSrc === src;
  return (
    <span
      className={`history-result-icon${loaded ? ' is-loaded' : ''}`}
      data-history-icon-state={loaded ? 'loaded' : 'placeholder'}
      aria-hidden="true"
    >
      <History className="history-result-placeholder" size={16} aria-hidden="true" />
      {src && (
        <img
          key={src}
          src={src}
          alt=""
          draggable={false}
          onLoad={() => {
            setLoadedSrc(src);
          }}
          onError={() => {
            setFailedCount((count) => count + 1);
          }}
        />
      )}
    </span>
  );
}

function SearchResultIcon({ item }: { item: SearchItem }) {
  if (item.kind === 'history') return <HistoryResultIcon item={item} />;
  if (item.url) return <Favicon url={item.url} title={item.title} />;
  if (item.kind === 'folder') return <FolderClosed size={16} aria-hidden="true" />;
  return <Bookmark size={16} aria-hidden="true" />;
}

/**
 * The last answer for an empty query, so reopening Search shows its recent
 * picks at once while the background confirms them.
 */
let lastRecentAnswer: { key: string; results: SharedSearchResult[] } | undefined;

function commandBarResult(
  result: SharedSearchResult,
  query: string,
  commandById: ReadonlyMap<string, CommandAction>,
  resolveCommand: CommandBarProps['resolveCommand'],
): CommandBarResult | undefined {
  const selection = {
    recent: result.recent ? true : undefined,
    selectionId: result.recent?.resultId ?? searchResultPreferenceId(result),
    selectionQuery: result.recent?.query ?? query,
  };
  if (result.kind === 'item') {
    return { ...selection, id: `item:${result.item.id}`, kind: 'item', item: result.item };
  }
  if (result.kind === 'navigate') {
    return {
      ...selection,
      id: result.target.kind === 'url'
        ? `navigate:${result.target.url}`
        : `navigate:search:${result.target.query}`,
      kind: 'navigate',
      target: result.target,
    };
  }
  const command = commandById.get(result.commandId) ??
    (result.command ? resolveCommand?.(result.command) : undefined);
  return command ? { ...selection, id: `command:${command.id}`, kind: 'command', command } : undefined;
}

/** Where a list key moves the selection in a list that wraps around, if it moves it. */
function movedIndex(key: string, index: number, length: number): number | undefined {
  if (key === 'ArrowDown' || key === 'ArrowUp') return (index + (key === 'ArrowDown' ? 1 : length - 1)) % length;
  return key === 'Home' ? 0 : key === 'End' ? length - 1 : undefined;
}

function resultId(result: CommandBarResult): string {
  return `command-result-${result.id.replace(/[^a-z\d_-]/gi, '-')}`;
}

export function CommandBar({
  activeSpaceId,
  commands,
  inputRef: providedInputRef,
  historyLoading = false,
  modelRevision,
  search,
  showFolders = true,
  spaceColours = {},
  underway,
  variant = 'sidebar',
  onActivateItem,
  onClose,
  onCloseInSpace,
  onDeleteHistory,
  itemMenu,
  onNavigate,
  onForgetSearchSelection,
  onRecordSearchSelection,
  resolveCommand,
}: CommandBarProps) {
  const internalInputRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const inputRef = providedInputRef ?? internalInputRef;
  const [query, setQuery] = useState('');
  const [selectedResultKey, setSelectedResultKey] = useState<string>();
  // Home and End move the caret until the arrows have moved into the results.
  const [navigating, setNavigating] = useState(false);
  const { close: closeMenu, menu, open: openMenu } = useContextMenu();
  const [deletingHistoryId, setDeletingHistoryId] = useState<string>();
  // Forgotten picks leave at once rather than when the background next answers.
  const [forgottenIds, setForgottenIds] = useState<ReadonlySet<string>>(() => new Set());
  // Away from the sidebar, the results show only while the page and Search have focus and hold a query.
  const [open, setOpen] = useState(variant === 'sidebar');
  const [sharedSearch, setSharedSearch] = useState<SharedSearchState>({
    key: '',
    results: [],
    sequence: 0,
  });
  const searchSequenceRef = useRef(0);
  const liveSearchKeyRef = useRef('');
  // The query Enter was pressed for while its results were still on their way.
  const [enterPendingFor, setEnterPendingFor] = useState<{ query: string; newTab: boolean }>();
  const [settledResults, setSettledResults] = useState<CommandBarResult[]>([]);
  const trimmedQuery = query.trim();
  const deferredQuery = useDeferredValue(trimmedQuery);
  const [searchCommands, commandDescriptorKey] = useMemo(() => {
    const serialised = serialiseSearchCommands(commands);
    return [serialised, JSON.stringify(serialised)] as const;
  }, [commands]);
  const sharedSearchKey = `${activeSpaceId}\n${commandDescriptorKey}\n${showFolders}\n${deferredQuery}`;
  const sharedResults = sharedSearch.key === sharedSearchKey
    ? sharedSearch.results
    : !deferredQuery && lastRecentAnswer?.key === sharedSearchKey ? lastRecentAnswer.results : [];
  const availableResults = useMemo<CommandBarResult[]>(() => {
    const commandById = new Map(commands.map((command) => [command.id, command]));
    const shared = sharedResults.flatMap((result) => {
      if (result.kind === 'item' && !showFolders && result.item.kind === 'folder') return [];
      const mapped = commandBarResult(result, deferredQuery, commandById, resolveCommand);
      return mapped && !(mapped.selectionId && forgottenIds.has(mapped.selectionId)) ? [mapped] : [];
    });
    if (deferredQuery) return shared;
    // With nothing typed, the recent picks lead and the commands follow.
    const shown = new Set(shared.map((result) => result.id));
    return [
      ...shared,
      ...commands.slice(0, 12).flatMap((command) => shown.has(`command:${command.id}`) ? [] : [{
        id: `command:${command.id}`,
        kind: 'command' as const,
        command,
      }]),
    ];
  }, [commands, deferredQuery, forgottenIds, resolveCommand, sharedResults, showFolders]);
  const resultsVisible = underway === undefined &&
    (variant === 'sidebar' || (open && Boolean(trimmedQuery)) || Boolean(menu));
  const { enterWaits, pending } = searchAnswerState(
    trimmedQuery,
    deferredQuery,
    sharedSearch.key === sharedSearchKey,
  );
  const results = resultsVisible
    ? pending ? settledResults : availableResults
    : [];
  const boundedIndex = selectedResultIndex(results, selectedResultKey);
  const selectedResultDomId = results[boundedIndex]
    ? resultId(results[boundedIndex])
    : undefined;

  useEffect(() => {
    if (!trimmedQuery) {
      setSettledResults([]);
    } else if (!pending) {
      setSettledResults(availableResults);
    }
  }, [availableResults, pending, trimmedQuery]);

  useEffect(() => {
    let userInteracted = false;
    const markInteraction = () => {
      userInteracted = true;
    };
    const focusInput = () => {
      if (!userInteracted) inputRef.current?.focus({ preventScroll: true });
    };
    const frame = requestAnimationFrame(focusInput);
    if (variant !== 'newtab') return () => cancelAnimationFrame(frame);

    let postLoadTimer: number | undefined;
    const focusAfterLoad = () => {
      postLoadTimer = window.setTimeout(focusInput, 0);
    };
    const once = { capture: true, once: true };
    const unlisten = listen(
      [window, 'pointerdown', markInteraction, once],
      [window, 'keydown', markInteraction, once],
      [window, 'load', focusAfterLoad, { once: true }],
    );
    if (document.readyState === 'complete') focusAfterLoad();

    return () => {
      cancelAnimationFrame(frame);
      unlisten();
      if (postLoadTimer !== undefined) window.clearTimeout(postLoadTimer);
    };
  }, [inputRef, variant]);

  useEffect(() => {
    if (variant === 'sidebar') return;
    // Moving to another window or the address bar leaves the field focused but the page not.
    return listen([window, 'blur', () => {
      setOpen(false);
      closeMenu();
    }]);
  }, [closeMenu, variant]);

  // The field comes back, focused, when a page it was loading stops short of leaving.
  const isUnderway = underway !== undefined;
  const wasUnderwayRef = useRef(isUnderway);
  useEffect(() => {
    if (wasUnderwayRef.current && !isUnderway) inputRef.current?.focus({ preventScroll: true });
    wasUnderwayRef.current = isUnderway;
  }, [inputRef, isUnderway]);

  useEffect(() => {
    liveSearchKeyRef.current = sharedSearchKey;
    const requestKey = sharedSearchKey;
    searchSequenceRef.current += 1;
    const sequence = searchSequenceRef.current;
    const land = (results?: SharedSearchResult[]) => {
      if (!deferredQuery && results) lastRecentAnswer = { key: requestKey, results };
      setSharedSearch((current) =>
        nextSharedSearch(current, { key: requestKey, results, sequence }, liveSearchKeyRef.current));
    };
    void search({
      commands: searchCommands,
      includeFolders: showFolders,
      limit: 18,
      query: deferredQuery,
    }).then((response) => land(response?.results), () => land());
  }, [
    activeSpaceId,
    commandDescriptorKey,
    deferredQuery,
    modelRevision,
    search,
    sharedSearchKey,
    showFolders,
  ]);

  useEffect(() => setSelectedResultKey(undefined), [deferredQuery]);

  useEffect(() => {
    if (!selectedResultDomId) return;
    const frame = requestAnimationFrame(() => {
      resultsRef.current
        ?.querySelector<HTMLElement>(`#${CSS.escape(selectedResultDomId)}`)
        ?.scrollIntoView({ block: 'nearest' });
    });
    return () => cancelAnimationFrame(frame);
  }, [selectedResultDomId]);

  const activate = async (
    result?: CommandBarResult,
    destinationSpaceId?: string,
    newTab = false,
  ) => {
    if (!result) return;
    onClose?.('activate');
    if (forgottenIds.size > 0) setForgottenIds(new Set());
    if (result.selectionQuery && result.selectionId) {
      // Remembering the pick only ranks later searches, so the pick never waits on it.
      void Promise.resolve(onRecordSearchSelection(result.selectionQuery, result.selectionId))
        .catch(() => undefined);
    }
    if (result.kind === 'command') await result.command.run();
    else if (result.kind === 'item') await onActivateItem(
      result.item,
      // A new tab opens here unless the user picked another space for it.
      newTab ? destinationSpaceId : destinationSpaceId ?? result.item.openSpaces?.[0]?.id,
      { newTab },
    );
    else await onNavigate(result.target, { newTab });
  };

  // Enter acts on the results for what was typed, so it waits for them rather than doing nothing.
  useEffect(() => {
    if (enterPendingFor === undefined || enterWaits) return;
    setEnterPendingFor(undefined);
    if (enterPendingFor.query === trimmedQuery) {
      void activate(results[boundedIndex], undefined, enterPendingFor.newTab);
    }
  });

  const refocusInput = () => requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }));
  const deleteHistoryItem = (item: SearchItem) => {
    if (!item.url || deletingHistoryId) return;
    setDeletingHistoryId(item.id);
    void Promise.resolve(onDeleteHistory(item.url))
      .catch(() => undefined)
      .finally(() => {
        setDeletingHistoryId(undefined);
        refocusInput();
      });
  };

  const forgetRecent = (result: CommandBarResult) => {
    const { selectionId } = result;
    if (!result.recent || !selectionId) return;
    const index = results.indexOf(result);
    setSelectedResultKey(results[index + 1]?.id ?? results[index - 1]?.id);
    setForgottenIds((current) => new Set(current).add(selectionId));
    if (lastRecentAnswer) {
      lastRecentAnswer = {
        ...lastRecentAnswer,
        results: lastRecentAnswer.results.filter((entry) => entry.recent?.resultId !== selectionId),
      };
    }
    void Promise.resolve(onForgetSearchSelection(selectionId)).catch(() => undefined);
    refocusInput();
  };
  const forgetButton = (result: CommandBarResult, title: string) => (
    <button
      type="button"
      className="command-recent-forget"
      onClick={(event) => {
        event.stopPropagation();
        forgetRecent(result);
      }}
      aria-label={`Remove ${title} from recent searches`}
      title="Remove from recent searches"
    >
      <X size={14} aria-hidden="true" />
    </button>
  );
  const groupStart = (index: number) => index > 0 && !results[index]?.recent && Boolean(results[index - 1]?.recent);

  const resultMenu = (result: ItemResult): ContextMenuEntry[] => menuGroups([
    result.item.url ? [{
      icon: ExternalLink,
      id: 'open-new-tab',
      label: 'Open in new tab',
      onSelect: () => void activate(result, undefined, true),
    }] : [],
    itemMenu?.(result.item) ?? [],
    result.item.kind === 'history' && result.item.url ? [{
      danger: true,
      icon: Trash2,
      id: 'delete-history',
      label: 'Delete from history',
      onSelect: () => deleteHistoryItem(result.item),
    }] : [],
  ]);
  const showResultMenu = (result: ItemResult, anchor: ContextMenuAnchor): boolean => {
    const entries = resultMenu(result);
    if (entries.length === 0) return false;
    setSelectedResultKey(result.id);
    openMenu({
      entries,
      label: `Actions for ${result.item.title}`,
      returnFocus: inputRef.current,
      ...anchor,
    });
    return true;
  };
  const selectedElement = () => selectedResultDomId
    ? resultsRef.current?.querySelector<HTMLElement>(`#${CSS.escape(selectedResultDomId)}`)
    : undefined;

  return (
    <section
      className={`command-bar command-bar-${variant}`}
      data-results-visible={resultsVisible || undefined}
      aria-label="Command bar"
      onFocus={() => {
        if (document.hasFocus()) setOpen(true);
      }}
      onBlur={(event) => {
        if (variant !== 'sidebar' && !event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <div className={`command-bar-input${underway === undefined ? '' : ' is-underway'}`}>
        {variant !== 'sidebar' && <Search size={18} aria-hidden="true" />}
        {underway !== undefined ? <>
          <div className="command-bar-underway">{underway}</div>
          <span className="command-bar-underway-line" role="progressbar" aria-label={`Loading ${underway}`}>
            <span className="hyper-mark-gradient" />
          </span>
        </> : <input
          ref={inputRef}
          type="search"
          value={query}
          onChange={(event) => {
            setQuery(event.currentTarget.value);
            setNavigating(false);
            setOpen(true);
          }}
          onKeyDown={(event) => {
            const directTarget = isDirectSearchShortcut(event)
              ? webSearchTarget(trimmedQuery)
              : undefined;
            const selectedResult = results[boundedIndex];
            const moved = movedIndex(event.key, boundedIndex, results.length);
            const clipboardKey = (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey
              ? ({ c: 'copy', x: 'cut' } as Readonly<Record<string, string>>)[event.key.toLocaleLowerCase()]
              : undefined;
            if (directTarget?.kind === 'search') {
              event.preventDefault();
              activate({
                id: `navigate:search:${directTarget.query}`,
                kind: 'navigate',
                selectionId: searchResultPreferenceId({
                  kind: 'navigate',
                  target: directTarget,
                }),
                selectionQuery: directTarget.query,
                target: directTarget,
              });
            } else if (moved !== undefined && (event.key.startsWith('Arrow') || (
              navigating && results.length > 0 && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey
            ))) {
              event.preventDefault();
              setNavigating(true);
              setSelectedResultKey(results[moved]?.id);
            } else if (
              isMenuKey(event) &&
              selectedResult?.kind === 'item'
            ) {
              const element = selectedElement();
              if (element && showResultMenu(selectedResult, keyboardMenuAnchor(element))) event.preventDefault();
            } else if (
              clipboardKey && navigating && selectedResult?.kind === 'item' &&
              event.currentTarget.selectionStart === event.currentTarget.selectionEnd
            ) {
              // With no text selected to copy, the keys act on the result the arrows chose.
              const entry = resultMenu(selectedResult).find((candidate) => candidate.id === clipboardKey);
              if (entry) {
                event.preventDefault();
                entry.onSelect();
              }
            } else if (
              event.key === 'Delete' && event.shiftKey && navigating && selectedResult?.recent
            ) {
              event.preventDefault();
              forgetRecent(selectedResult);
            } else if (event.key === 'Enter') {
              event.preventDefault();
              if (enterWaits) {
                setEnterPendingFor({ query: trimmedQuery, newTab: opensInNewTab(event) });
              } else {
                activate(results[boundedIndex], undefined, opensInNewTab(event));
              }
            } else if (event.key === 'Escape' && onClose) {
              event.preventDefault();
              onClose('dismiss');
            } else if (event.key === 'Escape' && variant !== 'sidebar' && resultsVisible) {
              event.preventDefault();
              setOpen(false);
            }
          }}
          onClick={() => setOpen(true)}
          placeholder="Search your tabs and history, or type a command"
          aria-label="Search tabs, bookmarks, history, or commands"
          role="combobox"
          aria-controls={resultsVisible ? 'command-bar-results' : undefined}
          aria-expanded={resultsVisible}
          aria-activedescendant={selectedResultDomId}
          autoFocus={variant === 'newtab'}
          autoComplete="off"
          spellCheck={false}
        />}
        {onClose && variant !== 'sidebar' && (
          <button
            type="button"
            onClick={() => onClose('dismiss')}
            aria-label="Close command bar"
            title="Close"
          >
            <X size={15} aria-hidden="true" />
          </button>
        )}
      </div>
      {resultsVisible && <div
          ref={resultsRef}
          id="command-bar-results"
          className="command-bar-results"
          role="listbox"
          aria-label="Command bar results"
          aria-busy={pending || historyLoading}
          onMouseDown={(event) => {
            // A press on the list's own padding or headings would blur the field and hide the list.
            if (!(event.target as Element).closest('a, button, input, [tabindex]')) event.preventDefault();
          }}
          onKeyDown={(event) => {
            // Keys on a result the Tab key reached: the arrows move between results, typing searches.
            const target = event.target as Element;
            const options = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="option"]'));
            const option = target.closest('[role="option"]') ??
              target.closest('.command-result-row')?.querySelector('[role="option"]');
            const index = option ? options.indexOf(option as HTMLElement) : -1;
            if (index < 0) return;
            if (event.key === 'Enter' && opensInNewTab(event) && !event.altKey && !event.shiftKey) {
              event.preventDefault();
              void activate(results[index], undefined, true);
              return;
            }
            if (event.metaKey || event.ctrlKey || event.altKey) return;
            const next = movedIndex(event.key, index, options.length);
            if (next !== undefined) {
              event.preventDefault();
              setNavigating(true);
              setSelectedResultKey(results[next]?.id);
              options[next]?.focus();
            } else if (event.key === 'Escape' && onClose) {
              event.preventDefault();
              onClose('dismiss');
            } else if (event.key.length === 1 && event.key !== ' ') {
              inputRef.current?.focus({ preventScroll: true });
            }
          }}
        >
        {results.length > 0 ? results.map((result, index) => {
          const selected = index === boundedIndex;
          const groupClass = groupStart(index) ? ' is-group-start' : '';
          if (result.kind === 'command' || result.kind === 'navigate') {
            const Icon = result.kind === 'command'
              ? COMMAND_ICONS[result.command.icon]
              : result.target.kind === 'url' ? Globe2 : Search;
            const label = result.kind === 'command' ? result.command.label : result.target.label;
            const detail = result.kind === 'command' ? result.command.detail : result.target.detail;
            const trailing = result.kind === 'command'
              ? result.command.shortcut && <kbd>{result.command.shortcut}</kbd>
              : result.recent ? undefined
                : result.target.kind === 'search'
                  ? <kbd>Alt+Enter</kbd>
                  : <ArrowRight size={15} aria-hidden="true" />;
            const option = (
              <button
                type="button"
                id={resultId(result)}
                key={result.id}
                className={result.recent
                  ? 'command-result-main'
                  : `${selected ? 'is-selected' : ''}${groupClass}`.trim() || undefined}
                role="option"
                aria-selected={selected}
                onPointerMove={() => setSelectedResultKey(result.id)}
                onClick={(event) => activate(result, undefined, result.kind === 'navigate' && opensInNewTab(event))}
                onAuxClick={(event) => {
                  if (event.button === 1 && result.kind === 'navigate') void activate(result, undefined, true);
                }}
              >
                <span className="command-result-icon"><Icon size={16} aria-hidden="true" /></span>
                <span className="command-result-copy">
                  <strong>{label}</strong>
                  <small>{detail}</small>
                </span>
                {trailing}
              </button>
            );
            return result.recent ? (
              <div
                key={result.id}
                className={`command-result-row${selected ? ' is-selected' : ''}`}
                role="presentation"
                onPointerMove={() => setSelectedResultKey(result.id)}
              >
                {option}
                {forgetButton(result, label)}
              </div>
            ) : option;
          }
          if (result.kind === 'item') {
            const presentation = result.item.url
              ? urlSearchPresentation(result.item.url, deferredQuery)
              : undefined;
            const currentSpace = result.item.openSpaces?.find(
              (space) => space.id === activeSpaceId,
            );
            const otherSpaces = result.item.openSpaces?.filter(
              (space) => space.id !== activeSpaceId,
            ) ?? [];
            const historyVisitDate = result.item.kind === 'history'
              ? formatHistoryVisitDate(result.item.lastVisitTime)
              : undefined;
            return (
              <div
                key={result.id}
                className={`command-result-row${selected ? ' is-selected' : ''}${groupClass}`}
                role="presentation"
                onPointerMove={() => setSelectedResultKey(result.id)}
                onContextMenu={(event) => {
                  if (showResultMenu(result, contextMenuAnchor(event))) event.preventDefault();
                }}
              >
                <button
                  type="button"
                  id={resultId(result)}
                  className="command-result-main"
                  role="option"
                  aria-selected={selected}
                  aria-label={`${result.item.title} ${result.item.url ?? result.item.detail}`}
                  title={itemTooltip(result.item.title, result.item.url ?? result.item.detail)}
                  onClick={(event) => activate(result, undefined, opensInNewTab(event))}
                  onAuxClick={(event) => {
                    if (event.button === 1) void activate(result, undefined, true);
                  }}
                >
                  <span className="command-result-icon"><SearchResultIcon item={result.item} /></span>
                  <span className="command-result-copy">
                    <strong><HighlightedText value={result.item.title} query={deferredQuery} /></strong>
                    <span className="command-result-meta">
                      {historyVisitDate && (
                        <span className="command-history-date">{historyVisitDate}</span>
                      )}
                      <small
                        className={presentation?.recentered ? 'command-result-url is-recentered' : ''}
                      >
                        {result.item.url ? (
                          <HighlightedUrl url={result.item.url} query={deferredQuery} />
                        ) : (
                          <HighlightedText value={result.item.detail} query={deferredQuery} />
                        )}
                      </small>
                    </span>
                  </span>
                  {currentSpace && (
                    <span
                      className="command-current-space-indicator"
                      style={{
                        '--command-space-colour': spaceColours[currentSpace.id],
                      } as CSSProperties}
                      aria-hidden="true"
                    />
                  )}
                </button>
                {otherSpaces.length > 0 && (
                  <div className="command-space-links" role="group" aria-label="Open in other spaces">
                    {otherSpaces.map((space) => (
                      <button
                        key={space.id}
                        type="button"
                        className="command-space-link"
                        style={{
                          '--command-space-colour': spaceColours[space.id],
                        } as CSSProperties}
                        onClick={(event) => activate(result, space.id, opensInNewTab(event))}
                        onAuxClick={(event) => {
                          const tabId = space.tabId ?? result.item.tabId;
                          if (event.button !== 1 || !onCloseInSpace || tabId === undefined) return;
                          event.preventDefault();
                          event.stopPropagation();
                          // This closes rather than picks a result, so Search stays open and the space does not change.
                          onCloseInSpace(tabId, space.id);
                          refocusInput();
                        }}
                        aria-label={`Open ${result.item.title} in ${space.title}`}
                        title={space.title}
                      />
                    ))}
                  </div>
                )}
                {result.recent ? forgetButton(result, result.item.title) : result.item.kind === 'history' && result.item.url && (
                  <button
                    type="button"
                    className="command-history-delete"
                    disabled={deletingHistoryId === result.item.id}
                    onClick={(event) => {
                      event.stopPropagation();
                      deleteHistoryItem(result.item);
                    }}
                    aria-label={`Delete ${result.item.title} from history`}
                    title="Delete from history"
                  >
                    <Trash2 size={14} aria-hidden="true" />
                  </button>
                )}
              </div>
            );
          }
          return null;
        }) : (
          <div className="command-bar-empty" role="status">
            {pending || historyLoading ? 'Searching...' : 'No matching commands or pages'}
          </div>
        )}
        </div>}
      {menu}
    </section>
  );
}