import { addToMapList, addToMapSet, isRecord } from './collections';
import { normaliseQuery } from './searchText';
import { type TabGroupColour } from './tabGroups';
import { pageIdentity, tabPageIdentity, tabUrl, urlsRepresentSamePage } from './urlIdentity';

export type BookmarkNode = Browser.bookmarks.BookmarkTreeNode;
export type BrowserTab = Browser.tabs.Tab;

export interface Space {
  /** Set while the space is archived: hidden from pagination, with its tabs parked until it returns. */
  archived?: true;
  /**
   * The colour the space's tab groups wear, filled by the model from the live
   * groups. Absent when the space has no group, or was read from bookmarks alone.
   */
  colour?: TabGroupColour;
  id: string;
  /** Absent until repair creates the space's marked bookmarks root. */
  rootId?: string;
  title: string;
  index: number;
  children: BookmarkNode[];
}

/** The space a window may switch to, failing for a space removed or archived. */
export function openableSpace(spaces: readonly Space[], spaceId: string): Space {
  const space = spaces.find((candidate) => candidate.id === spaceId);
  if (!space) throw new Error('This space no longer exists.');
  if (space.archived) throw new Error('This space is archived.');
  return space;
}

/** The spaces a window can show, in pagination order: every space not archived. */
export function shownSpaces<Entry extends Pick<Space, 'archived'>>(spaces: readonly Entry[]): Entry[] {
  return spaces.filter((space) => !space.archived);
}

export function archivedSpaces<Entry extends Pick<Space, 'archived'>>(spaces: readonly Entry[]): Entry[] {
  return spaces.filter((space) => space.archived);
}

/** The shown space that takes over from `spaceId` when it leaves pagination: the next one, else the previous. */
export function neighbourShownSpace<Entry extends Pick<Space, 'archived' | 'id'>>(
  spaces: readonly Entry[],
  spaceId: string,
): Entry | undefined {
  const index = spaces.findIndex((space) => space.id === spaceId);
  const takesOver = (space: Entry) => !space.archived && space.id !== spaceId;
  return spaces.slice(index + 1).find(takesOver) ?? spaces.slice(0, Math.max(index, 0)).findLast(takesOver);
}

export function preferredActiveSpaceId(
  spaces: readonly Pick<Space, 'id'>[],
  storedSpaceId: string | null | undefined,
  currentSpaceId: string | null | undefined,
): string | null {
  if (storedSpaceId && spaces.some((space) => space.id === storedSpaceId)) {
    return storedSpaceId;
  }
  if (currentSpaceId && spaces.some((space) => space.id === currentSpaceId)) {
    return currentSpaceId;
  }
  return spaces[0]?.id ?? null;
}

export interface HyperBookmarkStructure {
  hyper: BookmarkNode;
  favourites: BookmarkNode;
  spaces: BookmarkNode;
  /** Bookmarks that belong to no space, shown behind the favourites bar's bookmark button. */
  bookmarks?: BookmarkNode;
}

export interface DerivedBookmarkState {
  spaces: Space[];
  favourites: BookmarkNode[];
  favouriteSlots: Array<BookmarkNode | undefined>;
  globalBookmarks: BookmarkNode[];
  globalBookmarksRootId?: string;
  localBookmarksBySpaceId: Readonly<Record<string, BookmarkNode[]>>;
  localBookmarkSpaceIds: Readonly<Record<string, string>>;
  nodeMap: Map<string, BookmarkNode>;
}

export type TabIdentityIndex = ReadonlyMap<string, BrowserTab[]>;
export type SpaceIdentityIndex = ReadonlyMap<string, ReadonlySet<string>>;

export interface BookmarkTabStatus {
  openTabs: BrowserTab[];
  isSleeping: boolean;
  isActive: boolean;
}

export type BookmarkMetadata = Record<string, unknown>;

export interface ParsedBookmarkTitle {
  title: string;
  metadata: BookmarkMetadata;
}

export const HYPER_FOLDER_TITLE = 'hyper';
export const FAVOURITES_FOLDER_TITLE = 'favourites';
export const BOOKMARKS_FOLDER_TITLE = 'bookmarks';
export const SPACES_FOLDER_TITLE = 'spaces';
export const TABS_FOLDER_TITLE = 'tabs';
/** The bar holds eight tiles; the last is the global bookmarks button. */
export const MAX_FAVOURITES = 7;

export function parseBookmarkTitle(rawTitle: string): ParsedBookmarkTitle {
  for (let index = rawTitle.lastIndexOf('{'); index > 0; index = rawTitle.lastIndexOf('{', index - 1)) {
    if (!/\s/.test(rawTitle[index - 1] ?? '')) continue;
    try {
      const metadata: unknown = JSON.parse(rawTitle.slice(index));
      if (isRecord(metadata)) return { title: rawTitle.slice(0, index).trimEnd(), metadata };
    } catch {
      // Keep scanning in case an earlier opening brace begins the trailing object.
    }
  }
  return { title: rawTitle, metadata: {} };
}

export function serializeBookmarkTitle(
  title: string,
  metadata: BookmarkMetadata,
): string {
  const compactMetadata = Object.fromEntries(Object.entries(metadata).flatMap(
    ([key, value]) => {
      if (value === undefined) return [];
      if (!isRecord(value)) {
        return [[key, value]];
      }
      const compactValue = JSON.parse(serializeBookmarkTitle('', value as BookmarkMetadata) || '{}');
      return Object.keys(compactValue).length > 0 ? [[key, compactValue]] : [];
    },
  ));
  return Object.keys(compactMetadata).length > 0
    ? `${title.trimEnd()} ${JSON.stringify(compactMetadata)}`.trimStart()
    : title.trimEnd();
}

export function visibleBookmarkTitle(node: Pick<BookmarkNode, 'title'>): string {
  return parseBookmarkTitle(node.title).title;
}

/** A node's child folders whose visible title is `title`. */
export function childFoldersTitled(
  parent: Pick<BookmarkNode, 'children'> | undefined,
  title: string,
): BookmarkNode[] {
  return (parent?.children ?? []).filter((node) => isFolderTitled(node, title));
}

export function isFolderTitled(node: Pick<BookmarkNode, 'title' | 'url'>, title: string): boolean {
  return !node.url && visibleBookmarkTitle(node) === title;
}

export function isBookmarkSeparator(node: BookmarkNode): boolean {
  return (node as BookmarkNode & { type?: string }).type === 'separator';
}

export function isBookmarkFolder(node: BookmarkNode): boolean {
  return !node.url && !isBookmarkSeparator(node);
}

export function bookmarkFolderIds(nodes: readonly BookmarkNode[]): string[] {
  return nodes.flatMap((node) => !isBookmarkFolder(node)
    ? []
    : [node.id, ...bookmarkFolderIds(node.children ?? [])]);
}

export function bookmarkFolderIdsContainingUrls(
  nodes: readonly BookmarkNode[],
  urls: readonly (string | undefined)[],
): string[] {
  const identities = new Set(urls.flatMap((url) => {
    const identity = pageIdentity(url);
    return identity ? [identity] : [];
  }));
  if (identities.size === 0) return [];

  const matchingFolderIds = (children: readonly BookmarkNode[]): string[] =>
    children.flatMap((node) => {
      if (!isBookmarkFolder(node)) return [];
      const descendantFolderIds = matchingFolderIds(node.children ?? []);
      const hasDirectMatch = node.children?.some((child) =>
        child.url && identities.has(pageIdentity(child.url) ?? '')) ?? false;
      return hasDirectMatch || descendantFolderIds.length > 0
        ? [node.id, ...descendantFolderIds]
        : [];
    });

  return matchingFolderIds(nodes);
}

export interface BookmarkFolderOption {
  id: string;
  title: string;
  path: string;
}

export function bookmarkFolderOptions(
  nodes: readonly BookmarkNode[],
  excludedRootIds: ReadonlySet<string>,
  parentPath: readonly string[] = [],
): BookmarkFolderOption[] {
  return nodes.flatMap((node) => {
    if (!isBookmarkFolder(node) || excludedRootIds.has(node.id)) return [];
    const title = visibleBookmarkTitle(node) || 'Bookmarks';
    const isBrowserRoot = node.parentId === undefined;
    const path = isBrowserRoot ? parentPath : [...parentPath, title];
    return [
      ...(isBrowserRoot ? [] : [{ id: node.id, title, path: path.join(' / ') }]),
      ...bookmarkFolderOptions(node.children ?? [], excludedRootIds, path),
    ];
  });
}

export function bookmarkTitleWithCustomName(
  node: Pick<BookmarkNode, 'title'>,
  title: string,
): string {
  return bookmarkTitleWithHyper(node.title, {}, { metadata: { isCustomName: true }, visible: title });
}

export function customBookmarkTitleMatches(
  node: Pick<BookmarkNode, 'title'>,
  title: string,
): boolean {
  const parsed = parseBookmarkTitle(node.title);
  return parsed.metadata.isCustomName === true && parsed.title === title.trim();
}

function hyperRecord(metadata: BookmarkMetadata): Record<string, unknown> {
  return isRecord(metadata.hyper) ? metadata.hyper : {};
}

/** The `hyper` metadata a node's title carries. */
export function bookmarkHyperMetadata(node: Pick<BookmarkNode, 'title'>): Record<string, unknown> {
  return hyperRecord(parseBookmarkTitle(node.title).metadata);
}

/** A reader for one `hyper` metadata field, answering it only when `isType` accepts it. */
function hyperField<T>(isType: (value: unknown) => value is T) {
  return (node: Pick<BookmarkNode, 'title'>, key: string): T | undefined => {
    const value = bookmarkHyperMetadata(node)[key];
    return isType(value) ? value : undefined;
  };
}

export const hyperString = hyperField((value): value is string => typeof value === 'string');
const hyperNumber = hyperField((value): value is number => typeof value === 'number');

/**
 * A title with its `hyper` metadata patched, an `undefined` value removing a
 * key. `metadata` patches the top-level metadata beside it, and `visible`
 * replaces the visible title.
 */
export function bookmarkTitleWithHyper(
  title: string,
  hyper: Record<string, unknown>,
  { metadata, visible }: { metadata?: BookmarkMetadata; visible?: string } = {},
): string {
  const parsed = parseBookmarkTitle(title);
  return serializeBookmarkTitle(visible ?? parsed.title, {
    ...parsed.metadata,
    ...metadata,
    hyper: { ...hyperRecord(parsed.metadata), ...hyper },
  });
}

function lastActiveTabTokensByWindow(
  node: Pick<BookmarkNode, 'title'>,
): Record<string, unknown> | undefined {
  const tokens = bookmarkHyperMetadata(node).lastActiveTabTokensByWindow;
  return isRecord(tokens) ? tokens : undefined;
}

export function spaceLastActiveTabToken(
  node: Pick<BookmarkNode, 'title'>,
  windowId?: number,
): string | undefined {
  const tokens = lastActiveTabTokensByWindow(node);
  if (windowId !== undefined && tokens) {
    const token = tokens[String(windowId)];
    return typeof token === 'string' ? token : undefined;
  }
  return hyperString(node, 'lastActiveTabToken');
}

export function spaceBookmarkTitleWithLastActiveTabToken(
  node: Pick<BookmarkNode, 'title'>,
  token: string,
  windowId?: number,
): string {
  const tokensByWindow = lastActiveTabTokensByWindow(node) ?? {};
  return bookmarkTitleWithHyper(node.title, {
    lastActiveTabToken: token,
    ...(windowId === undefined ? {} : {
      lastActiveTabTokensByWindow: {
        ...tokensByWindow,
        [String(windowId)]: token,
      },
    }),
  });
}

/**
 * A space folder's title without the colour earlier versions kept on it. A
 * space's colour is now only ever its tab groups' colour.
 */
export function spaceBookmarkTitleWithoutColour(node: Pick<BookmarkNode, 'title'>): string {
  return Object.hasOwn(bookmarkHyperMetadata(node), 'colour')
    ? bookmarkTitleWithHyper(node.title, { colour: undefined })
    : node.title;
}

/** Whether a space folder's title marks it archived. */
export function spaceBookmarkArchived(node: Pick<BookmarkNode, 'title'>): boolean {
  return bookmarkHyperMetadata(node).archived === true;
}

export function spaceBookmarkTitleWithArchived(
  node: Pick<BookmarkNode, 'title'>,
  archived: boolean,
): string {
  return bookmarkTitleWithHyper(node.title, { archived: archived || undefined });
}

export function spaceBookmarkTitleWithMigratedLastActiveTabWindowIds(
  node: Pick<BookmarkNode, 'title'>,
  previousToCurrentWindowIds: ReadonlyMap<number, number>,
): string {
  const existingTokens = lastActiveTabTokensByWindow(node);
  if (!existingTokens) return node.title;
  let changed = false;
  const migratedTokens = Object.fromEntries(Object.entries(existingTokens).map(
    ([windowId, token]) => {
      const currentWindowId = previousToCurrentWindowIds.get(Number(windowId));
      if (currentWindowId === undefined || String(currentWindowId) === windowId) {
        return [windowId, token];
      }
      changed = true;
      return [String(currentWindowId), token];
    },
  ));
  if (!changed) return node.title;
  return bookmarkTitleWithHyper(node.title, { lastActiveTabTokensByWindow: migratedTokens });
}

export function isTabBackingBookmark(
  node: Pick<BookmarkNode, 'title' | 'url'>,
): boolean {
  return Boolean(node.url) && bookmarkHyperMetadata(node).tab === true;
}

/** A folder titled `title` whose `hyper` metadata sets `marker`. */
function isMarkedFolder(
  node: Pick<BookmarkNode, 'title' | 'url'>,
  title: string,
  marker: string,
): boolean {
  return isFolderTitled(node, title) && bookmarkHyperMetadata(node)[marker] === true;
}

export function isSpaceTabsFolder(
  node: Pick<BookmarkNode, 'title' | 'url'>,
): boolean {
  return isMarkedFolder(node, TABS_FOLDER_TITLE, 'spaceTabs');
}

export function isSpaceBookmarksFolder(
  node: Pick<BookmarkNode, 'title' | 'url'>,
): boolean {
  return isMarkedFolder(node, BOOKMARKS_FOLDER_TITLE, 'spaceBookmarks');
}

export function isTabFolder(
  node: Pick<BookmarkNode, 'title' | 'url'>,
): boolean {
  return !node.url && bookmarkHyperMetadata(node).tabFolder === true;
}

/** A window folder an earlier layout kept a window's tab backings in. */
function isLegacyWindowFolder(node: Pick<BookmarkNode, 'title' | 'url'>): boolean {
  const hyper = bookmarkHyperMetadata(node);
  return !node.url && typeof hyper.installationId === 'string' && typeof hyper.windowId === 'number';
}

/**
 * A tab folder holding the tabs of one split view, shown side by side. It is
 * still marked as a tab folder, so anything that cannot show it as panes shows
 * it as a folder.
 */
export function isSplitViewFolder(
  node: Pick<BookmarkNode, 'title' | 'url'>,
): boolean {
  return isTabFolder(node) && bookmarkHyperMetadata(node).splitView === true;
}

export const SPLIT_VIEW_FOLDER_TITLE = 'Side by side';

export function splitViewFolderBookmarkTitle(): string {
  return serializeBookmarkTitle(SPLIT_VIEW_FOLDER_TITLE, {
    hyper: { splitView: true, tabFolder: true },
  });
}

/** A tab folder's title marked, or no longer marked, as holding a split view. */
export function tabFolderTitleWithSplitView(title: string, splitView: boolean): string {
  return bookmarkTitleWithHyper(title, { splitView: splitView || undefined, tabFolder: true });
}

export function isLocalBookmarkFolder(
  node: Pick<BookmarkNode, 'title' | 'url'>,
): boolean {
  return !node.url &&
    !isSpaceTabsFolder(node) &&
    !isSpaceBookmarksFolder(node) &&
    !isTabFolder(node) &&
    !isLegacyWindowFolder(node);
}

export function isLocalBookmarkNode(
  node: Pick<BookmarkNode, 'title' | 'url'>,
): boolean {
  return node.url ? !isTabBackingBookmark(node) : isLocalBookmarkFolder(node);
}

export function findEquivalentVisibleBookmark(
  nodes: readonly BookmarkNode[],
  url: string | undefined,
): BookmarkNode | undefined {
  const identity = pageIdentity(url);
  if (!identity) return undefined;
  return nodes.find((node) =>
    node.url &&
    !isTabBackingBookmark(node) &&
    pageIdentity(node.url) === identity);
}

export function tabFolderBookmarkTitle(
  title: string,
  existingTitle?: string,
): string {
  return bookmarkTitleWithHyper(existingTitle ?? '', { tabFolder: true }, { visible: title.trim() });
}

export function tabBackingToken(node: Pick<BookmarkNode, 'title'>): string | undefined {
  return hyperString(node, 'tabToken');
}

export function tabBackingIndex(node: Pick<BookmarkNode, 'title'>): number | undefined {
  return hyperNumber(node, 'tabIndex');
}

export function tabBackingSpaceId(node: Pick<BookmarkNode, 'title'>): string | undefined {
  return hyperString(node, 'spaceId');
}

export function tabBackingWindowId(node: Pick<BookmarkNode, 'title'>): number | undefined {
  return hyperNumber(node, 'windowId');
}

export function tabBackingInstallationId(node: Pick<BookmarkNode, 'title'>): string | undefined {
  return hyperString(node, 'installationId');
}

export function tabBackingBookmarkTitle(
  title: string,
  tabIndex?: number,
  tabToken?: string,
  spaceId?: string,
  existingTitle?: string,
  ownership?: { windowId?: number; installationId?: string },
): string {
  const existing = { title: existingTitle ?? '' };
  const name = bookmarkCustomName(existing);
  return bookmarkTitleWithHyper(existing.title, {
    tab: true,
    // A named backing keeps the page's own title beside the name, to return to.
    pageTitle: name === undefined
      ? undefined
      : title === name ? bookmarkHyperMetadata(existing).pageTitle : title,
    ...(tabIndex !== undefined ? { tabIndex } : {}),
    ...(tabToken ? { tabToken } : {}),
    ...(spaceId ? { spaceId } : {}),
    ...(ownership?.windowId !== undefined ? { windowId: ownership.windowId } : {}),
    ...(ownership?.installationId ? { installationId: ownership.installationId } : {}),
  }, { visible: name ?? title });
}

/** Moves a backing to a window, or parks it with no window until its space next opens. */
export function tabBackingTitleInWindow(
  title: string,
  windowId: number | undefined,
  installationId?: string,
): string {
  return bookmarkTitleWithHyper(title, { windowId, ...(installationId ? { installationId } : {}) });
}

/**
 * A backing as `installationId` keeps it in `spaceId`: parked until that
 * session opens the space unless it names a window, and under its own token
 * when it is a copy.
 */
export function tabBackingTitleForSession(
  title: string,
  session: { installationId: string; spaceId: string; tabToken?: string; windowId?: number },
): string {
  return bookmarkTitleWithHyper(title, {
    installationId: session.installationId,
    spaceId: session.spaceId,
    ...(session.tabToken === undefined ? {} : { tabToken: session.tabToken }),
    windowId: session.windowId,
  });
}

/** A name the user gave a bookmark or tab, rather than one following its page. */
export function bookmarkCustomName(node: Pick<BookmarkNode, 'title'>): string | undefined {
  const parsed = parseBookmarkTitle(node.title);
  return parsed.metadata.isCustomName === true ? parsed.title : undefined;
}

/** A bookmark follows its page again, showing `pageTitle` if known and its current title until then. */
export function bookmarkTitleWithoutCustomName(
  node: Pick<BookmarkNode, 'title'>,
  pageTitle?: string,
): string {
  return bookmarkTitleWithHyper(node.title, {}, { metadata: { isCustomName: undefined }, visible: pageTitle });
}

/** The title a tab's page gives itself, as its backing keeps it: shown, or beside a user-given name. */
export function tabBackingPageTitle(node: Pick<BookmarkNode, 'title'>): string | undefined {
  return bookmarkCustomName(node) === undefined
    ? visibleBookmarkTitle(node)
    : hyperString(node, 'pageTitle');
}

export function tabBackingTitleWithName(node: Pick<BookmarkNode, 'title'>, name: string): string {
  return bookmarkTitleWithHyper(
    node.title,
    { pageTitle: tabBackingPageTitle(node) },
    { metadata: { isCustomName: true }, visible: name },
  );
}

/** A backing shows its page's own title again; `fallback` stands in if that was never kept. */
export function tabBackingTitleWithoutName(node: Pick<BookmarkNode, 'title'>, fallback: string): string {
  return bookmarkTitleWithHyper(
    node.title,
    { pageTitle: undefined },
    { metadata: { isCustomName: undefined }, visible: tabBackingPageTitle(node) ?? fallback },
  );
}

export interface TabBookmarkLinkMetadata {
  /** The bookmark the tab shows, kept while the tab stays on its domain. */
  linkedBookmarkId?: string;
  /** A bookmark the user unlinked, so matching its page again does not relink it. */
  declinedBookmarkId?: string;
}

export function tabBackingBookmarkLink(node: Pick<BookmarkNode, 'title'>): TabBookmarkLinkMetadata {
  const linkedBookmarkId = hyperString(node, 'linkedBookmarkId');
  const declinedBookmarkId = hyperString(node, 'declinedBookmarkId');
  return {
    ...(linkedBookmarkId === undefined ? {} : { linkedBookmarkId }),
    ...(declinedBookmarkId === undefined ? {} : { declinedBookmarkId }),
  };
}

export function tabBackingTitleWithBookmarkLink(
  title: string,
  link: TabBookmarkLinkMetadata,
): string {
  return bookmarkTitleWithHyper(title, {
    linkedBookmarkId: link.linkedBookmarkId,
    declinedBookmarkId: link.declinedBookmarkId,
  });
}

/** A tab that moves to another site leaves its name and bookmark link behind. */
export function tabBackingTitleLeavingDomain(title: string): string {
  return bookmarkTitleWithHyper(
    title,
    { linkedBookmarkId: undefined, declinedBookmarkId: undefined },
    { metadata: { isCustomName: undefined } },
  );
}

function nestedTabBackings(nodes: readonly BookmarkNode[]): BookmarkNode[] {
  return nodes.flatMap((node) => {
    if (isTabBackingBookmark(node)) return [node];
    return isTabFolder(node) || isLegacyWindowFolder(node)
      ? nestedTabBackings(node.children ?? [])
      : [];
  });
}

export function tabBackings(space: Space): BookmarkNode[] {
  return space.children.filter(isTabBackingBookmark);
}

export function spaceHasTabUrl(
  space: Space,
  url?: string,
  spaceIdsByPageIdentity?: SpaceIdentityIndex,
): boolean {
  const identity = pageIdentity(url);
  if (identity && spaceIdsByPageIdentity) {
    return spaceIdsByPageIdentity.get(identity)?.has(space.id) ?? false;
  }
  return Boolean(identity) && tabBackings(space).some(
    (node) => pageIdentity(node.url) === identity,
  );
}

export function bookmarkNodesHaveUrl(
  nodes: ReadonlyArray<Pick<BookmarkNode, 'url'>>,
  url?: string,
): boolean {
  const identity = pageIdentity(url);
  return Boolean(identity) && nodes.some(
    (node) => node.url && pageIdentity(node.url) === identity,
  );
}

export function bookmarkTitleFollowingPageTitle(
  node: Pick<BookmarkNode, 'title' | 'url'>,
  pageTitle: string,
): string | undefined {
  if (!node.url) return undefined;
  const title = pageTitle.trim();
  const parsed = parseBookmarkTitle(node.title);
  if (!title || parsed.metadata.isCustomName === true || parsed.title === title) {
    return undefined;
  }
  return serializeBookmarkTitle(title, parsed.metadata);
}

export function bookmarkTitleUpdatesFollowingPageTitle(
  nodes: BookmarkNode[],
  pageUrl: string | undefined,
  pageTitle: string,
): Array<{ id: string; title: string }> {
  const identity = pageIdentity(pageUrl);
  if (!identity) return [];
  return [...buildNodeMap(nodes).values()].flatMap((node) => {
    if (!node.url || pageIdentity(node.url) !== identity) return [];
    const title = bookmarkTitleFollowingPageTitle(node, pageTitle);
    return title ? [{ id: node.id, title }] : [];
  });
}

export function isBookmark(node: BookmarkNode): boolean {
  return Boolean(node.url);
}

/** The node with `nodeId` anywhere in `tree`, depth first. */
export function findBookmarkNode(
  tree: readonly BookmarkNode[],
  nodeId: string,
): BookmarkNode | undefined {
  for (const node of tree) {
    if (node.id === nodeId) return node;
    const child = findBookmarkNode(node.children ?? [], nodeId);
    if (child) return child;
  }
  return undefined;
}

/**
 * The `bookmarks.move` index that steps a bookmark one place past a sibling,
 * counted before the bookmark leaves its place, or nothing when it is already
 * at that end or not among the siblings.
 */
export function bookmarkStepIndex(
  siblings: readonly Pick<BookmarkNode, 'id'>[],
  bookmarkId: string,
  offset: -1 | 1,
): number | undefined {
  const from = siblings.findIndex((sibling) => sibling.id === bookmarkId);
  const to = from + offset;
  if (from < 0 || to < 0 || to >= siblings.length) return undefined;
  return offset > 0 ? to + 1 : to;
}

export function findBookmarkBar(tree: BookmarkNode[]): BookmarkNode | undefined {
  const containers = tree[0]?.children ?? [];
  return (
    containers.find((node) => node.id === '1') ??
    containers.find((node) => node.id.toLocaleLowerCase().includes('toolbar')) ??
    containers.find((node) => /\b(bar|toolbar)\b/i.test(node.title)) ??
    containers[0]
  );
}

export function bestTabFaviconUrl(tabs: BrowserTab[]): string | undefined {
  return (
    tabs.find((tab) => tab.active && tab.favIconUrl)?.favIconUrl ??
    tabs.find((tab) => tab.favIconUrl)?.favIconUrl
  );
}

export function collectUniqueBookmarkUrls(node: BookmarkNode): string[] {
  const urls: string[] = [];
  const identities = new Set<string>();
  const collect = (current: BookmarkNode) => {
    if (current.url) {
      const identity = pageIdentity(current.url);
      if (identity && !identities.has(identity)) {
        identities.add(identity);
        urls.push(current.url);
      }
      return;
    }
    current.children?.forEach(collect);
  };
  collect(node);
  return urls;
}

/**
 * The `hyper` root on its own. Its title carries the preferences, so readers of
 * those must not depend on the folders beneath it being intact.
 */
export function findHyperRootFolder(tree: BookmarkNode[]): BookmarkNode | undefined {
  return childFoldersTitled(findBookmarkBar(tree), HYPER_FOLDER_TITLE)[0];
}

export function findHyperBookmarkStructure(
  tree: BookmarkNode[],
): HyperBookmarkStructure | null {
  const hyper = findHyperRootFolder(tree);
  if (!hyper) return null;

  const [favourites] = childFoldersTitled(hyper, FAVOURITES_FOLDER_TITLE);
  const [spaces] = childFoldersTitled(hyper, SPACES_FOLDER_TITLE);
  const [bookmarks] = childFoldersTitled(hyper, BOOKMARKS_FOLDER_TITLE);
  return favourites && spaces
    ? { hyper, favourites, spaces, ...(bookmarks ? { bookmarks } : {}) }
    : null;
}

function storedFavouriteSlot(node: BookmarkNode): number | undefined {
  const slot = bookmarkHyperMetadata(node).favouriteSlot;
  return Number.isInteger(slot) && Number(slot) >= 0 ? Number(slot) : undefined;
}

export function favouriteSlot(node: BookmarkNode): number | undefined {
  const slot = storedFavouriteSlot(node);
  return slot !== undefined && slot < MAX_FAVOURITES ? slot : undefined;
}

/**
 * Favourites with no room on the bar: those an earlier, wider bar placed beyond
 * its last slot, then whatever still does not fit. Repair moves them into the
 * global bookmarks so shrinking the bar never loses one.
 */
export function overflowingFavourites(nodes: BookmarkNode[]): BookmarkNode[] {
  const bookmarks = nodes.filter(isBookmark);
  const beyond = bookmarks.filter((node) => (storedFavouriteSlot(node) ?? 0) >= MAX_FAVOURITES);
  const placed = new Set(arrangeFavouriteSlots(bookmarks.filter((node) => !beyond.includes(node)))
    .flatMap((node) => node ? [node.id] : []));
  return bookmarks.filter((node) => !placed.has(node.id));
}

export function bookmarkTitleWithFavouriteSlot(
  node: BookmarkNode,
  slotIndex?: number,
): string {
  return bookmarkTitleWithHyper(node.title, { favouriteSlot: slotIndex });
}

export interface FavouriteSlotReplacementPlan {
  displaced?: BookmarkNode;
  titleUpdates: Array<{ node: BookmarkNode; title: string }>;
}

export function planFavouriteSlotReplacement(
  nodes: BookmarkNode[],
  source: BookmarkNode,
  slotIndex: number,
): FavouriteSlotReplacementPlan {
  const slots = arrangeFavouriteSlots(nodes);
  if (slots[slotIndex]?.id === source.id) {
    return { titleUpdates: [] };
  }
  const displaced = slots[slotIndex]?.id === source.id ? undefined : slots[slotIndex];
  const titleUpdates = slots.flatMap((node, index) => {
    if (!node || node.id === source.id || node.id === displaced?.id) return [];
    return [{ node, title: bookmarkTitleWithFavouriteSlot(node, index) }];
  });
  if (displaced) {
    titleUpdates.push({
      node: displaced,
      title: bookmarkTitleWithFavouriteSlot(displaced),
    });
  }
  titleUpdates.push({
    node: source,
    title: bookmarkTitleWithFavouriteSlot(source, slotIndex),
  });
  return { displaced, titleUpdates };
}

export function arrangeFavouriteSlots(
  nodes: BookmarkNode[],
): Array<BookmarkNode | undefined> {
  const slots = Array<BookmarkNode | undefined>(MAX_FAVOURITES).fill(undefined);
  const unassigned: BookmarkNode[] = [];

  for (const node of nodes.filter(isBookmark)) {
    const slot = favouriteSlot(node);
    if (slot !== undefined && !slots[slot]) slots[slot] = node;
    else unassigned.push(node);
  }

  for (const node of unassigned) {
    const slot = slots.findIndex((candidate) => !candidate);
    if (slot < 0) break;
    slots[slot] = node;
  }
  return slots;
}

export function deriveSpaces(tree: BookmarkNode[]): Space[] {
  return spacesFromStructure(findHyperBookmarkStructure(tree));
}

function favouriteSlotsFromStructure(
  structure: HyperBookmarkStructure | null,
): Array<BookmarkNode | undefined> {
  return arrangeFavouriteSlots(structure?.favourites.children ?? []);
}

function spacesFromStructure(structure: HyperBookmarkStructure | null): Space[] {
  return (structure?.spaces.children ?? [])
    .filter((node) => !node.url)
    .map((folder, index) => {
      const bookmarkRoot = folder.children?.find(isSpaceBookmarksFolder);
      return {
        ...(spaceBookmarkArchived(folder) ? { archived: true as const } : {}),
        id: folder.id,
        rootId: bookmarkRoot?.id,
        title: visibleBookmarkTitle(folder) || 'Untitled space',
        index,
        children: [
          ...(folder.children ?? []).flatMap((child) =>
            isSpaceTabsFolder(child)
              ? nestedTabBackings(child.children ?? [])
              : []),
          ...(bookmarkRoot?.children ?? []),
        ],
      };
    });
}

/**
 * Spaces, favourites and bookmarks as the tree holds them. A space's colour is
 * not in the tree but on its live tab groups, so callers pass what they read.
 */
export function deriveBookmarkState(
  tree: BookmarkNode[],
  colours: Readonly<Record<string, TabGroupColour>> = {},
): DerivedBookmarkState {
  const structure = findHyperBookmarkStructure(tree);
  const favouriteSlots = favouriteSlotsFromStructure(structure);
  const spaces = spacesFromStructure(structure).map((space) => {
    const colour = colours[space.id];
    return colour ? { ...space, colour } : space;
  });
  const localBookmarksBySpaceId = Object.fromEntries(spaces.map((space) => [
    space.id,
    space.children.filter(isLocalBookmarkNode),
  ]));
  const localBookmarkSpaceIds: Record<string, string> = {};
  const indexLocalNodes = (nodes: readonly BookmarkNode[], spaceId: string) => {
    for (const node of nodes) {
      localBookmarkSpaceIds[node.id] = spaceId;
      indexLocalNodes(node.children ?? [], spaceId);
    }
  };
  for (const [spaceId, nodes] of Object.entries(localBookmarksBySpaceId)) {
    indexLocalNodes(nodes, spaceId);
  }
  return {
    spaces,
    favouriteSlots,
    favourites: favouriteSlots.filter(
      (node): node is BookmarkNode => Boolean(node),
    ),
    globalBookmarks: structure?.bookmarks?.children ?? [],
    ...(structure?.bookmarks ? { globalBookmarksRootId: structure.bookmarks.id } : {}),
    localBookmarksBySpaceId,
    localBookmarkSpaceIds,
    nodeMap: buildNodeMap(tree),
  };
}

export function buildNodeMap(tree: BookmarkNode[]): Map<string, BookmarkNode> {
  const nodes = new Map<string, BookmarkNode>();

  const visit = (node: BookmarkNode) => {
    nodes.set(node.id, node);
    node.children?.forEach(visit);
  };

  tree.forEach(visit);
  return nodes;
}

export function withoutBookmarkNode(
  nodes: BookmarkNode[],
  nodeId: string,
): BookmarkNode[] {
  let changed = false;
  const next = nodes.flatMap((node) => {
    if (node.id === nodeId) {
      changed = true;
      return [];
    }
    if (!node.children) return [node];
    const children = withoutBookmarkNode(node.children, nodeId);
    if (children === node.children) return [node];
    changed = true;
    return [{ ...node, children }];
  });
  return changed ? next : nodes;
}

export function filterBookmarkTree(
  nodes: BookmarkNode[],
  query: string,
): BookmarkNode[] {
  const normalisedQuery = normaliseQuery(query);
  if (!normalisedQuery) return nodes;

  return nodes.flatMap((node) => {
    const matches = `${visibleBookmarkTitle(node)} ${node.url ?? ''}`
      .toLocaleLowerCase()
      .includes(normalisedQuery);

    if (node.url) return matches ? [node] : [];
    if (matches) return [node];

    const children = filterBookmarkTree(node.children ?? [], query);
    if (children.length === 0) return [];
    return [{ ...node, children }];
  });
}

export function containsNode(node: BookmarkNode, nodeId: string): boolean {
  return Boolean(
    node.children?.some(
      (child) => child.id === nodeId || containsNode(child, nodeId),
    ),
  );
}

export function findBookmarkPathByUrl(
  nodes: BookmarkNode[],
  url?: string,
): BookmarkNode[] | null {
  for (const node of nodes) {
    if (node.url && urlsRepresentSamePage(node.url, url)) return [node];
    const childPath = findBookmarkPathByUrl(node.children ?? [], url);
    if (childPath) return [node, ...childPath];
  }
  return null;
}

export function bookmarkNodeIdForPage(
  nodes: readonly BookmarkNode[],
  identity: string | undefined,
  selectedNodeId?: string,
): string | undefined {
  if (!identity) return undefined;
  let fallbackId: string | undefined;
  const visit = (node: BookmarkNode): string | undefined => {
    if (node.url && pageIdentity(node.url) === identity) {
      if (node.id === selectedNodeId) return node.id;
      fallbackId ??= node.id;
    }
    for (const child of node.children ?? []) {
      const selectedId = visit(child);
      if (selectedId) return selectedId;
    }
    return undefined;
  };
  for (const node of nodes) {
    const selectedId = visit(node);
    if (selectedId) return selectedId;
  }
  return fallbackId;
}

export function deriveSpaceTabs(
  tabs: BrowserTab[],
  currentWindowId: number | null,
  activeGroupId: number | null,
  activeSpaceId?: string,
  tabSpaceIds?: Readonly<Record<number, string>>,
): BrowserTab[] {
  return tabs
    .filter((tab) =>
      tab.id !== undefined &&
      (currentWindowId === null || tab.windowId === currentWindowId) &&
      (activeGroupId !== null
        ? tab.groupId === activeGroupId
        : activeSpaceId && tabSpaceIds
          ? tabSpaceIds[tab.id] === activeSpaceId
          : tab.groupId < 0))
    .sort((left, right) => left.index - right.index);
}

export interface DerivedSpaceTabTree {
  rootId?: string;
  nodes: BookmarkNode[];
}

export function deriveWindowSpaceTabTree(
  tree: BookmarkNode[],
  activeSpaceId: string | undefined,
  liveBackingIds: ReadonlySet<string>,
): DerivedSpaceTabTree {
  if (!activeSpaceId) return { nodes: [] };
  const space = buildNodeMap(tree).get(activeSpaceId);
  const root = space?.children?.find(isSpaceTabsFolder);
  if (!root) return { nodes: [] };

  const retain = (nodes: readonly BookmarkNode[]): BookmarkNode[] =>
    nodes.flatMap((node) => {
      if (isTabBackingBookmark(node)) {
        return liveBackingIds.has(node.id) ? [node] : [];
      }
      if (!isTabFolder(node)) return [];
      return [{ ...node, children: retain(node.children ?? []) }];
    });

  return { rootId: root.id, nodes: retain(root.children ?? []) };
}

export function descendantCount(node: BookmarkNode): number {
  return bookmarkCount(node.children ?? []);
}

export function descendantItemCount(node: BookmarkNode): number {
  return (node.children ?? []).reduce(
    (total, child) => total + 1 + descendantItemCount(child),
    0,
  );
}

/** Bookmarks among the nodes and inside their folders, not counting the folders. */
export function bookmarkCount(nodes: readonly BookmarkNode[]): number {
  return nodes.reduce(
    (total, node) => total + (node.url ? 1 : bookmarkCount(node.children ?? [])),
    0,
  );
}

export function bookmarkableTabUrl(
  tab: BrowserTab | undefined,
  extensionOrigin: string,
): string | null {
  const url = tabUrl(tab);
  if (!url || url.startsWith(extensionOrigin)) return null;
  try {
    const protocol = new URL(url).protocol;
    return [
      'about:',
      'chrome:',
      'chrome-extension:',
      'devtools:',
      'edge:',
      'moz-extension:',
    ].includes(protocol)
      ? null
      : url;
  } catch {
    return null;
  }
}

export function indexTabsByPageIdentity(tabs: BrowserTab[]): TabIdentityIndex {
  const index = new Map<string, BrowserTab[]>();
  for (const tab of tabs) {
    const identity = tabPageIdentity(tab);
    if (!identity) continue;
    addToMapList(index, identity, tab);
  }
  return index;
}

export function indexTabSpacesByPageIdentity(
  tabs: BrowserTab[],
  tabSpaceIds: Readonly<Record<number, string>>,
): SpaceIdentityIndex {
  const index = new Map<string, Set<string>>();
  for (const tab of tabs) {
    if (tab.id === undefined) continue;
    const identity = tabPageIdentity(tab);
    const spaceId = tabSpaceIds[tab.id];
    if (!identity || !spaceId) continue;
    addToMapSet(index, identity, spaceId);
  }
  return index;
}

/**
 * The space a page is open in that opening it should go to: the active space
 * when it has the page, otherwise the left-most space that does.
 */
export function openSpaceForPage(
  url: string | undefined,
  activeSpaceId: string | undefined,
  spaces: ReadonlyArray<Pick<Space, 'id'>>,
  spaceIdsByPageIdentity: SpaceIdentityIndex,
): string | undefined {
  const openSpaceIds = spaceIdsByPageIdentity.get(pageIdentity(url) ?? '');
  if (activeSpaceId !== undefined && openSpaceIds?.has(activeSpaceId)) return activeSpaceId;
  return spaces.find((space) => openSpaceIds?.has(space.id))?.id;
}

export function preferredSpaceForPage(
  url: string | undefined,
  activeSpaceId: string,
  spaces: ReadonlyArray<Pick<Space, 'id'>>,
  spaceIdsByPageIdentity: SpaceIdentityIndex,
): string {
  return openSpaceForPage(url, activeSpaceId, spaces, spaceIdsByPageIdentity) ?? activeSpaceId;
}

export function foremostTabInWindow(
  tabs: BrowserTab[],
  windowId: number | null,
  windowFocused: boolean,
): BrowserTab | undefined {
  if (!windowFocused || windowId === null) return undefined;
  return tabs.find((tab) => tab.active && tab.windowId === windowId);
}

export function tabSpaceId(
  tab: BrowserTab | undefined,
  tabSpaceIds: Readonly<Record<number, string>>,
  spaceGroupIds: Readonly<Record<string, number>>,
  activeSpaceId?: string,
  activeGroupId?: number | null,
): string | undefined {
  if (tab?.id === undefined) return undefined;
  const portableSpaceId = tabSpaceIds[tab.id];
  if (portableSpaceId) return portableSpaceId;
  const groupedSpaceId = Object.entries(spaceGroupIds).find(
    ([, groupId]) => groupId === tab.groupId,
  )?.[0];
  if (groupedSpaceId) return groupedSpaceId;
  return tab.groupId === activeGroupId ? activeSpaceId : undefined;
}

export function pageIsForemostInSpace(
  url: string | undefined,
  spaceId: string,
  foremostPageIdentity?: string,
  foremostSpaceId?: string,
): boolean {
  const identity = pageIdentity(url);
  return Boolean(
    identity &&
    identity === foremostPageIdentity &&
    spaceId === foremostSpaceId,
  );
}

export function isTabSleeping(tab: BrowserTab): boolean {
  return Boolean(tab.discarded || tab.frozen);
}

export function bookmarkTabStatus(
  tabsByPageIdentity: TabIdentityIndex,
  url?: string,
): BookmarkTabStatus {
  const identity = pageIdentity(url);
  const openTabs = identity ? tabsByPageIdentity.get(identity) ?? [] : [];
  return {
    openTabs,
    isSleeping: openTabs.length > 0 && openTabs.every(isTabSleeping),
    isActive: openTabs.some((tab) => tab.active),
  };
}

export interface BookmarkFolderSummary {
  bookmarkCount: number;
  hasOpenTab: boolean;
}

/**
 * Counts each folder's bookmarks and notes whether any is open, visiting every
 * node once, so nested folders shown together do not each re-walk their subtree.
 */
export function summariseBookmarkFolders(
  folders: Iterable<BookmarkNode>,
  tabsByPageIdentity: TabIdentityIndex,
): Map<string, BookmarkFolderSummary> {
  const summaries = new Map<string, BookmarkFolderSummary>();
  const summarise = (folder: BookmarkNode): BookmarkFolderSummary => {
    const known = summaries.get(folder.id);
    if (known) return known;
    const summary: BookmarkFolderSummary = { bookmarkCount: 0, hasOpenTab: false };
    for (const child of folder.children ?? []) {
      if (child.url) {
        summary.bookmarkCount += 1;
        summary.hasOpenTab ||= bookmarkTabStatus(tabsByPageIdentity, child.url).openTabs.length > 0;
      } else {
        const nested = summarise(child);
        summary.bookmarkCount += nested.bookmarkCount;
        summary.hasOpenTab ||= nested.hasOpenTab;
      }
    }
    summaries.set(folder.id, summary);
    return summary;
  };
  for (const folder of folders) summarise(folder);
  return summaries;
}
