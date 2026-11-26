import { isCount, isFiniteNumber, isRecord } from './collections';
/**
 * Intent payloads cross a port, so they are untrusted input. Every reader throws
 * on a shape it does not recognise, and the submitter turns that into a rejected
 * command before the effect is admitted, so a malformed intent can never reach a
 * browser call.
 */

import { bookmarkTarget, spaceTarget, type TargetKey } from './modelGuards';
import {
  MAX_SEARCH_SELECTION_QUERY_LENGTH,
  MAX_SEARCH_SELECTION_RESULT_ID_LENGTH,
} from './searchSelection';
import type { RemoteTabReference } from './remoteTab';
import { pageUrlFromText } from './urlIdentity';

/** Reads the field `name` of a payload, throwing when it is missing or malformed. */
type Reader<T> = (payload: unknown, name: string) => T;
type Parser<T> = (payload: unknown) => T;

function field(payload: unknown, name: string): unknown {
  if (!isRecord(payload)) throw new Error('An intent payload must be an object.');
  return payload[name];
}

export function requireNumber(payload: unknown, name: string): number {
  const value = field(payload, name);
  if (!isFiniteNumber(value)) {
    throw new Error(`An intent needs a numeric ${name}.`);
  }
  return value;
}

export function requireNumbers(payload: unknown, name: string): readonly number[] {
  const value = field(payload, name);
  if (!Array.isArray(value) || value.some((entry) => !isFiniteNumber(entry))) {
    throw new Error(`An intent needs a numeric ${name} list.`);
  }
  return value as readonly number[];
}

function requireIndex(payload: unknown, name: string): number {
  const value = requireNumber(payload, name);
  if (!isCount(value)) {
    throw new Error(`An intent needs a whole, non-negative ${name}.`);
  }
  return value;
}

export function requireString(payload: unknown, name: string): string {
  const value = field(payload, name);
  if (typeof value !== 'string' || !value) {
    throw new Error(`An intent needs a ${name}.`);
  }
  return value;
}

/** Titles may legitimately be empty, unlike an identifier. */
export function requireTitle(payload: unknown, name: string): string {
  const value = field(payload, name);
  if (typeof value !== 'string') throw new Error(`An intent needs a ${name} string.`);
  return value;
}

function requireBoolean(payload: unknown, name: string): boolean {
  const value = field(payload, name);
  if (typeof value !== 'boolean') throw new Error(`An intent needs a ${name} flag.`);
  return value;
}

function bounded(read: Reader<string>, maxLength: number): Reader<string> {
  return (payload, name) => {
    const value = read(payload, name);
    if (value.length > maxLength) throw new Error(`An intent needs a shorter ${name}.`);
    return value;
  };
}

function oneOf<const Value extends string>(...values: readonly Value[]): Reader<Value> {
  return (payload, name) => {
    const value = requireString(payload, name);
    if (!(values as readonly string[]).includes(value)) {
      throw new Error(`An intent needs a ${name} of ${values.join(', ')}.`);
    }
    return value as Value;
  };
}

/** A list of one to `MAX_INTENT_ITEMS` entries, each read by `parse`. */
function listOf<Item>(parse: Parser<Item>): Reader<Item[]> {
  return (payload, name) => {
    const items = field(payload, name);
    if (!Array.isArray(items) || items.length === 0 || items.length > MAX_INTENT_ITEMS) {
      throw new Error(`An intent needs a list of ${name}.`);
    }
    return items.map(parse);
  };
}

function optional<T>(read: Reader<T>): Reader<T | undefined> {
  return (payload, name) => field(payload, name) === undefined ? undefined : read(payload, name);
}

function orDefault<T>(read: Reader<T | undefined>, fallback: T): Reader<T> {
  return (payload, name) => read(payload, name) ?? fallback;
}

export const optionalNumber = optional(requireNumber);
/** Unlike `requireString`, an optional string may be empty. */
export const optionalString = optional(requireTitle);
export const optionalBoolean = optional(requireBoolean);
const optionalId = optional(requireString);
const optionalIndex = optional(requireIndex);
/** A flag that is either set or absent, so a false one is never sent on. */
const optionalTrue: Reader<true | undefined> = (payload, name) =>
  optionalBoolean(payload, name) || undefined;

type Spec = Record<string, Reader<unknown>>;
type Read<S extends Spec> = { [K in keyof S]: S[K] extends Reader<infer T> ? T : never };
type Simplify<T> = { [K in keyof T]: T[K] } & {};
/** The object a spec reads; a field whose reader may answer `undefined` is optional. */
type Parsed<S extends Spec> = Simplify<
  { [K in keyof S as undefined extends Read<S>[K] ? never : K]: Read<S>[K] } &
  { [K in keyof S as undefined extends Read<S>[K] ? K : never]?: Exclude<Read<S>[K], undefined> }
>;

/** Reads each field of a spec in order, leaving out the absent optional ones. */
function fields<const S extends Spec>(spec: S): Parser<Parsed<S>> {
  return (payload) => {
    const parsed: Record<string, unknown> = {};
    for (const [name, read] of Object.entries(spec)) {
      const value = read(payload, name);
      if (value !== undefined) parsed[name] = value;
    }
    return parsed as Parsed<S>;
  };
}

type Variants<Key extends string, Table extends Record<string, Parser<object>>> = {
  [Variant in keyof Table & string]: Simplify<{ [K in Key]: Variant } & ReturnType<Table[Variant]>>;
}[keyof Table & string];

/** Reads a payload whose `key` names which of the table's shapes it has. */
function variants<const Key extends string, Table extends Record<string, Parser<object>>>(
  key: Key,
  table: Table,
): Parser<Variants<Key, Table>> {
  const readVariant = oneOf(...Object.keys(table));
  return (payload) => {
    const variant = readVariant(payload, key);
    return { [key]: variant, ...table[variant]!(payload) } as Variants<Key, Table>;
  };
}

/** An action that carries no arguments still needs an object payload. */
function emptyPayload(action: string): Parser<Record<string, never>> {
  return (payload) => {
    if (!isRecord(payload)) throw new Error(`A ${action} intent needs an object payload.`);
    return {};
  };
}

/** A long selection stays far inside this; it only bounds a hostile payload. */
export const MAX_INTENT_ITEMS = 1_000;

export interface IntentItems<Payload> {
  /** Whether the intent carried `items`, so it answers with every item's result. */
  batch: boolean;
  items: readonly Payload[];
}

/**
 * Reads one payload, or `{ items: [...] }` holding several of the same shape.
 *
 * Dropping a selection is one user choice however many items it holds, so a
 * view sends it as one intent instead of sequencing one per item. The
 * background runs the items in order as one command, and the view waits for a
 * single outcome.
 */
export function eachItem<Payload>(
  parse: (payload: unknown) => Payload,
): (payload: unknown) => IntentItems<Payload> {
  const readItems = listOf(parse);
  return (payload) => field(payload, 'items') === undefined
    ? { batch: false, items: [parse(payload)] }
    : { batch: true, items: readItems(payload, 'items') };
}

/**
 * A bookmark's new place, or a step past one sibling, which the background
 * resolves against the siblings it finds when the move runs rather than a
 * place the view worked out from a projection an earlier move may have outrun.
 */
export type MoveBookmarkPayload =
  | { bookmarkId: string; index?: number; offset?: never; parentId?: string }
  | { bookmarkId: string; index?: never; offset: -1 | 1; parentId?: never };

const parseMoveBookmarkPlace = fields({
  bookmarkId: requireString,
  index: optionalIndex,
  parentId: optionalString,
});

/** Reads a move to a place, or a step whose place the background finds when the move runs. */
export const parseMoveBookmarkPayload: Parser<MoveBookmarkPayload> = (payload) => {
  const offset = field(payload, 'offset');
  if (offset === undefined) return parseMoveBookmarkPlace(payload);
  if (offset !== -1 && offset !== 1) throw new Error('A bookmark moves by an offset of -1 or 1.');
  if (field(payload, 'index') !== undefined || field(payload, 'parentId') !== undefined) {
    throw new Error('A bookmark moves by an offset or to a place, not both.');
  }
  return { bookmarkId: requireString(payload, 'bookmarkId'), offset };
};

export interface CopyBookmarkPayload {
  bookmarkId: string;
  /** Places the copy in this favourite slot as part of the same intent. */
  favouriteSlot?: number;
  index?: number;
  parentId: string;
  skipExisting?: boolean;
}

export const parseCopyBookmarkPayload: Parser<CopyBookmarkPayload> = fields({
  bookmarkId: requireString,
  favouriteSlot: optionalIndex,
  index: optionalIndex,
  parentId: requireString,
  skipExisting: optionalBoolean,
});

export interface CreateBookmarkPayload {
  /** Places the bookmark in this favourite slot as part of the same intent. */
  favouriteSlot?: number;
  index?: number;
  /** A page to bookmark rather than a tab, such as an address pasted onto a folder. */
  page?: { title: string; url: string };
  parentId: string;
  tabId?: number;
}

const MAX_PAGE_TITLE_LENGTH = 2_048;

const readBookmarkPage: Reader<{ title: string; url: string } | undefined> = optional((payload, name) => {
  const page = field(payload, name);
  const url = pageUrlFromText(requireString(page, 'url'));
  if (!url) throw new Error('A bookmark needs a web or file address.');
  const title = requireTitle(page, 'title').trim();
  if (title.length > MAX_PAGE_TITLE_LENGTH) throw new Error('A bookmark needs a shorter title.');
  return { title, url };
});

const readCreateBookmark = fields({
  favouriteSlot: optionalIndex,
  index: optionalIndex,
  page: readBookmarkPage,
  parentId: requireString,
  tabId: optionalNumber,
});

export function parseCreateBookmarkPayload(payload: unknown): CreateBookmarkPayload {
  const parsed = readCreateBookmark(payload);
  if (parsed.page !== undefined && parsed.tabId !== undefined) {
    throw new Error('A bookmark is made from a tab or a page, not both.');
  }
  return parsed;
}

export const parseCreateBookmarkFolderPayload = fields({ parentId: requireString });

export const parseCreateSpacePayload = fields({ spacesFolderId: requireString });

export const parseSelectSpacePayload = fields({ spaceId: requireString });

/** A space whose tabs in the asking window one choice closes or reloads together. */
export const parseSpaceTabsPayload = parseSelectSpacePayload;

/**
 * Archives or unarchives a space. It goes just before `beforeSpaceId` in the
 * list it joins, or last in it without one.
 */
export interface SetSpaceArchivedPayload {
  archived: boolean;
  beforeSpaceId?: string;
  spaceId: string;
}

const readSetSpaceArchived = fields({
  archived: requireBoolean,
  beforeSpaceId: (payload, name) => optionalString(payload, name) || undefined,
  spaceId: requireString,
});

export function parseSetSpaceArchivedPayload(payload: unknown): SetSpaceArchivedPayload {
  const parsed = readSetSpaceArchived(payload);
  if (parsed.beforeSpaceId === parsed.spaceId) throw new Error('A space cannot be placed before itself.');
  return parsed;
}

export const parseDuplicateSpacePayload = fields({
  spaceId: requireString,
  /** Also copies the asking window's tabs in the space, with their folders and splits. */
  withTabs: orDefault(optionalBoolean, false),
});

export const parseCreateTabPayload = emptyPayload('create tab');

export interface RemoteTabOperationPayload {
  source: RemoteTabReference;
  spaceId: string;
}

const MAX_REMOTE_TAB_REFERENCE_ID_LENGTH = 512;

const readRemoteTabOperation: Parser<RemoteTabOperationPayload> = fields({
  source: (payload, name) => variants('kind', {
    bookmark: fields({ bookmarkId: bounded(requireString, MAX_REMOTE_TAB_REFERENCE_ID_LENGTH) }),
    tab: fields({ tabId: requireIndex }),
  })(field(payload, name)),
  spaceId: requireString,
});

export type ActivateTabPayload =
  | { operation: 'local'; tabId: number }
  | ({ operation: 'remote' } & RemoteTabOperationPayload);

/** A legacy tabId stays local; remote activation must carry an opaque source. */
export function parseActivateTabPayload(payload: unknown): ActivateTabPayload {
  const operation = field(payload, 'operation');
  if (operation === undefined) return { operation: 'local', tabId: requireNumber(payload, 'tabId') };
  if (operation !== 'remote') throw new Error('An activate tab intent needs a supported operation.');
  return { operation, ...readRemoteTabOperation(payload) };
}

export const parseMoveTabToWindowPayload = readRemoteTabOperation;

export interface DeleteBookmarkPayload {
  bookmarkId: string;
  expectedProvisionalTitle?: string;
  unpin?: boolean;
}

export const parseDeleteBookmarkPayload: Parser<DeleteBookmarkPayload> = fields({
  bookmarkId: requireString,
  expectedProvisionalTitle: optionalString,
  unpin: optionalBoolean,
});

export interface DeleteSpacePayload {
  expectedProvisionalTitle?: string;
  /** Keeps the space's bookmarks in a folder named for it in the first other space. */
  moveBookmarks?: boolean;
  spaceId: string;
}

export const parseDeleteSpacePayload: Parser<DeleteSpacePayload> = fields({
  expectedProvisionalTitle: optionalString,
  moveBookmarks: optionalBoolean,
  spaceId: requireString,
});

export const parseDeleteHistoryPayload = fields({ url: requireString });

export type CloseTabsPayload =
  /** `folderTitle` names the folder whose tabs these are, when the user closed a folder. */
  | { condition?: undefined; folderTitle?: string; tabIds: readonly number[] }
  | {
      condition: 'other-unpinned';
      keepTabId: number;
      tabIds: readonly number[];
      windowId: number;
    }
  /** The page of a row this client shows, closed wherever that space has it open. */
  | ({ condition: 'page-in-space' } & RemoteTabOperationPayload);

const readCloseNamedTabs = fields({
  folderTitle: optional(bounded(requireTitle, MAX_PAGE_TITLE_LENGTH)),
  tabIds: requireNumbers,
});

const readCloseOtherUnpinnedTabs = fields({
  keepTabId: requireNumber,
  tabIds: requireNumbers,
  windowId: requireNumber,
});

/** A bulk close from the palette names its old targets but re-proves their safety in the worker. */
export function parseCloseTabsPayload(payload: unknown): CloseTabsPayload {
  const condition = field(payload, 'condition');
  if (condition === undefined) return readCloseNamedTabs(payload);
  if (condition === 'page-in-space') return { condition, ...readRemoteTabOperation(payload) };
  if (condition === 'other-unpinned') return { condition, ...readCloseOtherUnpinnedTabs(payload) };
  throw new Error('A tab close intent needs a supported condition.');
}

const searchSelectionResultPrefixes = [
  'bookmark:',
  'command:',
  'folder:',
  'history:',
  'navigate:search:',
  'navigate:url:',
  'tab:',
] as const;

const requireSearchResultId: Reader<string> = (payload, name) => {
  const resultId = bounded(requireString, MAX_SEARCH_SELECTION_RESULT_ID_LENGTH)(payload, name);
  if (!searchSelectionResultPrefixes.some((prefix) =>
    resultId.startsWith(prefix) && resultId.length > prefix.length)) {
    throw new Error('A search selection needs a known result identifier.');
  }
  return resultId;
};

export const parseRecordSearchSelectionPayload = fields({
  query: (payload, name) => {
    const query = bounded(requireString, MAX_SEARCH_SELECTION_QUERY_LENGTH)(payload, name);
    if (!query.trim()) throw new Error('A search selection needs a query.');
    return query;
  },
  resultId: requireSearchResultId,
});

export const parseForgetSearchSelectionPayload = fields({ resultId: requireSearchResultId });

export type NavigateTabPayload =
  | { kind: 'search'; newTab?: boolean; query: string; tabId?: number }
  | { kind: 'url'; newTab?: boolean; tabId?: number; url: string };

const navigateTabFields = { newTab: optionalTrue, tabId: optionalIndex };

export const parseNavigateTabPayload: Parser<NavigateTabPayload> = variants('kind', {
  search: fields({ ...navigateTabFields, query: requireString }),
  url: fields({ ...navigateTabFields, url: requireString }),
});

export const parseOpenBookmarkPayload = fields({
  active: orDefault(optionalBoolean, true),
  destinationSpaceId: optionalString,
  forceNew: orDefault(optionalBoolean, false),
  reuse: orDefault(optional(oneOf('browser', 'window')), 'window'),
  url: requireString,
});

export type OpenBookmarkPayload = ReturnType<typeof parseOpenBookmarkPayload>;

export interface OpenFavouritePayload {
  activeSpaceId?: string;
  forceNew?: boolean;
  url: string;
}

export const parseOpenFavouritePayload: Parser<OpenFavouritePayload> = fields({
  activeSpaceId: optionalString,
  forceNew: optionalBoolean,
  url: requireString,
});

export interface UpdateBookmarkUrlPayload {
  bookmarkId: string;
  url: string;
}

export const parseUpdateBookmarkUrlPayload: Parser<UpdateBookmarkUrlPayload> = fields({
  bookmarkId: requireString,
  url: requireString,
});

export const parseSetTabMediaPlaybackPayload = fields({
  state: oneOf('paused', 'playing'),
  tabId: requireNumber,
});

export const parseSetTabGroupPayload = fields({ spaceId: requireString, tabIds: requireNumbers });

export const parseSetTabMutedPayload = fields({ muted: requireBoolean, tabId: requireNumber });

/** A place in a space's tab tree: under `parentId`, or at its top level, at `index` or last. */
const readTabTreePlace = (payload: unknown, name: string) => fields({
  index: optionalIndex,
  parentId: optionalId,
  spaceId: requireString,
})(field(payload, name));

/**
 * Moves tabs to an index in a window; `tree` also puts them in a space there, at
 * a place in its tab tree. Tabs a sidebar dragged in from another window are
 * named by the shared drag's token, since remote tab IDs never reach a view.
 */
export type MoveTabsPayload = {
  index: number;
  tree?: { index?: number; parentId?: string; spaceId: string };
  windowId: number;
} & ({ tabIds: readonly number[] } | { sharedDrag: string });

const readMoveTabs = fields({
  index: requireNumber,
  tree: optional(readTabTreePlace),
  windowId: requireNumber,
});

export function parseMoveTabsPayload(payload: unknown): MoveTabsPayload {
  const sharedDrag = field(payload, 'sharedDrag');
  if (sharedDrag !== undefined && field(payload, 'tabIds') !== undefined) {
    throw new Error('A tab move names its tabs once.');
  }
  return {
    ...readMoveTabs(payload),
    ...(sharedDrag === undefined
      ? { tabIds: requireNumbers(payload, 'tabIds') }
      : { sharedDrag: requireString(payload, 'sharedDrag') }),
  };
}

/**
 * Moves a tab between sessions, or with `copy` copies it: another session's
 * tab, named by its backing, into this window's tab tree, to another session,
 * or into a bookmark folder as a bookmark; or this window's tab to another
 * session, which keeps it parked.
 */
export interface MoveSessionTabPayload {
  copy: boolean;
  destination:
    | { installationId: string }
    | { bookmarks: { index?: number; parentId: string } }
    | { index: number; tree: { index?: number; parentId?: string; spaceId: string } };
  source: { backingId: string } | { tabId: number };
}

const MAX_INSTALLATION_ID_LENGTH = 128;

/** Reads the one of `shapes` whose distinguishing field the payload carries. */
function exactlyOne<Shape>(
  description: string,
  shapes: Record<string, Parser<Shape>>,
): Reader<Shape> {
  return (payload, name) => {
    const value = field(payload, name);
    const named = Object.keys(shapes).filter((key) => field(value, key) !== undefined);
    if (named.length !== 1) throw new Error(`A session tab move names one ${description}.`);
    return shapes[named[0]!]!(value);
  };
}

const readMoveSessionTab = fields({
  copy: orDefault(optionalBoolean, false),
  destination: exactlyOne<MoveSessionTabPayload['destination']>('destination', {
    bookmarks: fields({
      bookmarks: (payload, name) => fields({ index: optionalIndex, parentId: requireString })(field(payload, name)),
    }),
    installationId: fields({ installationId: bounded(requireString, MAX_INSTALLATION_ID_LENGTH) }),
    tree: fields({ index: requireNumber, tree: readTabTreePlace }),
  }),
  source: exactlyOne<MoveSessionTabPayload['source']>('tab', {
    backingId: fields({ backingId: requireString }),
    tabId: fields({ tabId: requireNumber }),
  }),
});

export function parseMoveSessionTabPayload(payload: unknown): MoveSessionTabPayload {
  const parsed = readMoveSessionTab(payload);
  if ('bookmarks' in parsed.destination && !('backingId' in parsed.source)) {
    throw new Error('Only another session\'s tab is bookmarked by a session tab move.');
  }
  return parsed;
}

/** A tab or bookmark in a drag that a sidebar offers to the sidebars of other windows. */
export type SharedDragReference =
  | { kind: 'favourite' | 'tree'; nodeId: string }
  | { kind: 'tab'; tabId: number };

export type ShareDragPayload =
  | { items: readonly SharedDragReference[]; operation: 'offer'; token: string }
  | { operation: 'withdraw'; token: string };

const MAX_SHARED_DRAG_TOKEN_LENGTH = 128;

const readSharedDragNode = fields({ nodeId: requireString });

const parseSharedDragReference: Parser<SharedDragReference> = variants('kind', {
  favourite: readSharedDragNode,
  tab: fields({ tabId: requireNumber }),
  tree: readSharedDragNode,
});

const readSharedDragToken = bounded(requireString, MAX_SHARED_DRAG_TOKEN_LENGTH);

export const parseShareDragPayload: Parser<ShareDragPayload> = variants('operation', {
  offer: fields({ items: listOf(parseSharedDragReference), token: readSharedDragToken }),
  withdraw: fields({ token: readSharedDragToken }),
});

/** Shows another tab, or a page in a new tab, beside `tabId` in a split view. */
export type SplitTabPayload =
  | { tabId: number; url: string }
  | { tabId: number; withTabId: number };

export function parseSplitTabPayload(payload: unknown): SplitTabPayload {
  const tabId = requireNumber(payload, 'tabId');
  const withTabId = optionalNumber(payload, 'withTabId');
  const hasUrl = field(payload, 'url') !== undefined;
  if ((withTabId === undefined) === !hasUrl) {
    throw new Error('A split needs either a tab or a page to show beside the tab.');
  }
  return withTabId === undefined
    ? { tabId, url: requireString(payload, 'url') }
    : { tabId, withTabId };
}

const requireIds: Reader<string[]> = (payload, name) => {
  const ids = field(payload, name);
  if (
    !Array.isArray(ids) || ids.length === 0 ||
    !ids.every((id) => typeof id === 'string' && id.length > 0)
  ) {
    throw new Error(`An intent needs the ${name}.`);
  }
  return ids;
};

/**
 * The tab folder tree is one action rather than five, because its operations
 * share a target space and must not interleave with each other.
 */
export const parseSetTabFolderPayload = variants('operation', {
  create: fields({ parentId: optionalString, spaceId: requireString, title: optionalString }),
  move: fields({ index: optionalIndex, nodeIds: requireIds, parentId: requireString, spaceId: requireString }),
  remove: fields({ folderId: requireString, withTabs: optionalTrue }),
  rename: fields({ folderId: requireString, title: requireTitle }),
});

export type SetTabFolderPayload = ReturnType<typeof parseSetTabFolderPayload>;

export function setTabFolderTargets(payload: SetTabFolderPayload): readonly TargetKey[] {
  if (payload.operation === 'create') {
    return payload.parentId
      ? [bookmarkTarget(payload.parentId), spaceTarget(payload.spaceId)]
      : [spaceTarget(payload.spaceId)];
  }
  if (payload.operation === 'move') {
    return [
      ...payload.nodeIds.map(bookmarkTarget),
      bookmarkTarget(payload.parentId),
      spaceTarget(payload.spaceId),
    ];
  }
  return [bookmarkTarget(payload.folderId)];
}

export const parseCreateWindowPayload = fields({ incognito: orDefault(optionalBoolean, false) });

export const parseDetachTabPayload = fields({ tabId: requireNumber });

export const parseNavigateTabHistoryPayload = fields({
  direction: oneOf('back', 'forward'),
  tabId: requireNumber,
});

export interface ReloadTabPayload {
  tabId: number;
}

export const parseReloadTabPayload: Parser<ReloadTabPayload> = parseDetachTabPayload;

const readRestoreClosedTab = fields({ sessionId: optionalString });
const requireRestoreClosedTabObject = emptyPayload('restore closed tab');

export function parseRestoreClosedTabPayload(payload: unknown): { sessionId?: string } {
  requireRestoreClosedTabObject(payload);
  const { sessionId } = readRestoreClosedTab(payload);
  return sessionId ? { sessionId } : {};
}

export const parseSetTabPinnedPayload = fields({ pinned: requireBoolean, tabId: requireNumber });

export const parseSetTabZoomPayload = fields({
  mode: oneOf('in', 'out', 'reset'),
  tabId: requireNumber,
});

export const parseToggleWindowFullscreenPayload = emptyPayload('fullscreen');

export const parseMoveBookmarkItems = eachItem(parseMoveBookmarkPayload);
export const parseMoveSessionTabItems = eachItem(parseMoveSessionTabPayload);
export const parseCopyBookmarkItems = eachItem(parseCopyBookmarkPayload);
export const parseCreateBookmarkItems = eachItem(parseCreateBookmarkPayload);
export const parseDeleteBookmarkItems = eachItem(parseDeleteBookmarkPayload);
export const parseOpenBookmarkItems = eachItem(parseOpenBookmarkPayload);
export const parseSetTabFolderItems = eachItem(parseSetTabFolderPayload);
export const parseReloadTabItems = eachItem(parseReloadTabPayload);

/** The intents a view may send with `items`, and the shape of each item. */
export interface IntentItemPayloads {
  copyBookmark: CopyBookmarkPayload;
  createBookmark: CreateBookmarkPayload;
  deleteBookmark: DeleteBookmarkPayload;
  moveBookmark: MoveBookmarkPayload;
  moveSessionTab: MoveSessionTabPayload;
  openBookmark: OpenBookmarkPayload;
  reloadTab: ReloadTabPayload;
  setTabFolder: SetTabFolderPayload;
}
