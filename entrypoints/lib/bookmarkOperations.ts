import {
  shownSpaces,
  bookmarkNodesHaveUrl,
  bookmarkTitleWithCustomName,
  bookmarkTitleWithFavouriteSlot,
  bookmarkableTabUrl,
  deriveSpaces,
  findEquivalentVisibleBookmark,
  indexTabSpacesByPageIdentity,
  parseBookmarkTitle,
  preferredActiveSpaceId,
  preferredSpaceForPage,
  type BookmarkNode,
  type BrowserTab,
} from './bookmarks';
import type {
  CopyBookmarkPayload,
  CreateBookmarkPayload,
  OpenFavouritePayload,
  UpdateBookmarkUrlPayload,
} from './modelIntentPayloads';
import type { ModelTabTitles } from './model';
import { bookmarkTitleForTab, tabsInBrowsingContext } from './tabs';

export interface BookmarkCreateDetails {
  index?: number;
  parentId: string;
  title: string;
  url?: string;
}

export interface BookmarkCreationResult {
  created: boolean;
  node: BookmarkNode;
}

export interface OpenTabInSpaceOptions {
  active: boolean;
  destinationSpaceId?: string;
  forceNew: boolean;
  reuse: 'browser' | 'window';
  url: string;
  windowId: number;
}

export interface OpenTabInSpaceResult {
  created: boolean;
  tab: BrowserTab;
}

/** The bookmark reads and writes these operations make, injected so tests can stand in for them. */
export interface BookmarkEffects {
  createBookmark(details: BookmarkCreateDetails): Promise<BookmarkNode>;
  getBookmark(bookmarkId: string): Promise<BookmarkNode | undefined>;
  getBookmarkChildren(parentId: string): Promise<BookmarkNode[]>;
}

/** Copies a leaf bookmark, retaining all metadata except a favourite slot. */
export async function copyBookmark(
  payload: CopyBookmarkPayload,
  effects: BookmarkEffects,
): Promise<BookmarkNode | undefined> {
  const source = await effects.getBookmark(payload.bookmarkId);
  if (!source?.url) throw new Error('Only bookmarks can be copied.');
  if (payload.skipExisting) {
    const destinationChildren = await effects.getBookmarkChildren(payload.parentId);
    if (bookmarkNodesHaveUrl(destinationChildren, source.url)) return undefined;
  }
  return effects.createBookmark({
    parentId: payload.parentId,
    ...(payload.index === undefined ? {} : { index: payload.index }),
    title: bookmarkTitleWithFavouriteSlot(source),
    url: source.url,
  });
}

export interface BookmarkCreationEffects
  extends Pick<BookmarkEffects, 'createBookmark' | 'getBookmarkChildren'> {
  extensionOrigin: string;
  getActiveTab(windowId: number): Promise<BrowserTab | undefined>;
  getTab(tabId: number): Promise<BrowserTab>;
  /** Links the tab to the bookmark made from it, so the two keep one name. */
  linkTabToBookmark?(tabId: number, bookmarkId: string): Promise<void>;
  /** The model's name for the tab, which the bookmark adopts, and its page's last known title. */
  tabTitles?(tabId: number, url: string): ModelTabTitles;
}

/** Bookmarks `url` in a folder under the title `title` gives, unless the folder already holds it. */
async function createBookmarkUnlessHeld(
  url: string,
  { index, parentId }: { index?: number; parentId: string },
  title: () => string,
  effects: Pick<BookmarkEffects, 'createBookmark' | 'getBookmarkChildren'>,
): Promise<BookmarkCreationResult> {
  const existing = findEquivalentVisibleBookmark(await effects.getBookmarkChildren(parentId), url);
  if (existing) return { created: false, node: existing };
  return {
    created: true,
    node: await effects.createBookmark({
      parentId,
      ...(index === undefined ? {} : { index }),
      title: title(),
      url,
    }),
  };
}

/** Bookmarks a page in a folder, unless the folder already holds it. */
export function createPageBookmark(
  { title, url }: { title: string; url: string },
  place: { index?: number; parentId: string },
  effects: Pick<BookmarkEffects, 'createBookmark' | 'getBookmarkChildren'>,
): Promise<BookmarkCreationResult> {
  // Pasted text could end in what reads as Hyper's metadata, so only what shows is kept.
  return createBookmarkUnlessHeld(url, place, () => parseBookmarkTitle(title).title || url, effects);
}

/** Creates a bookmark for a named tab, a given page, or the issuer's claimed active tab. */
export async function createBookmarkFromTab(
  payload: CreateBookmarkPayload,
  windowId: number,
  effects: BookmarkCreationEffects,
): Promise<BookmarkCreationResult> {
  if (payload.page) {
    return createPageBookmark(payload.page, payload, effects);
  }
  const tab = payload.tabId === undefined
    ? await effects.getActiveTab(windowId)
    : await effects.getTab(payload.tabId);
  const url = bookmarkableTabUrl(tab, effects.extensionOrigin);
  if (!tab || !url) {
    throw new Error(
      payload.tabId === undefined
        ? 'The current page cannot be bookmarked.'
        : 'This tab cannot be bookmarked.',
    );
  }
  const result = await createBookmarkUnlessHeld(url, payload, () => {
    const { name, pageTitle } = tab.id === undefined ? {} : effects.tabTitles?.(tab.id, url) ?? {};
    const title = pageTitle ?? bookmarkTitleForTab(tab, url);
    return name ? bookmarkTitleWithCustomName({ title }, name) : title;
  }, effects);
  if (result.created && tab.id !== undefined) await effects.linkTabToBookmark?.(tab.id, result.node.id);
  return result;
}

export function createBookmarkFolder(
  parentId: string,
  effects: Pick<BookmarkEffects, 'createBookmark'>,
): Promise<BookmarkNode> {
  return effects.createBookmark({ parentId, title: 'New folder' });
}

export interface SpaceCreationEffects extends Pick<BookmarkEffects, 'createBookmark'> {
  ensureSpaceBookmarksFolder(spaceId: string): Promise<BookmarkNode>;
  ensureSpaceTabsFolder(spaceId: string): Promise<BookmarkNode>;
  removeBookmarkTree(bookmarkId: string): Promise<void>;
}

/** Creates a complete space or removes its exact new root if setup fails. */
export async function createSpace(
  spacesFolderId: string,
  effects: SpaceCreationEffects,
): Promise<BookmarkNode> {
  const space = await effects.createBookmark({
    parentId: spacesFolderId,
    title: 'New space',
  });
  try {
    const tabsFolder = await effects.ensureSpaceTabsFolder(space.id);
    const bookmarksFolder = await effects.ensureSpaceBookmarksFolder(space.id);
    return { ...space, children: [tabsFolder, bookmarksFolder] };
  } catch (error) {
    await effects.removeBookmarkTree(space.id).catch(() => undefined);
    throw error;
  }
}

export interface BookmarkUrlUpdateEffects extends Pick<BookmarkEffects, 'getBookmark'> {
  updateBookmarkUrl(bookmarkId: string, url: string): Promise<BookmarkNode>;
}

export async function updateBookmarkUrl(
  payload: UpdateBookmarkUrlPayload,
  effects: BookmarkUrlUpdateEffects,
): Promise<void> {
  const current = await effects.getBookmark(payload.bookmarkId);
  if (!current?.url) throw new Error('This bookmark no longer exists.');
  await effects.updateBookmarkUrl(payload.bookmarkId, payload.url);
}

export interface FavouriteOpeningEffects {
  getBookmarkTree(): Promise<BookmarkNode[]>;
  getTabSpaceIds(tabs: BrowserTab[]): Promise<Record<number, string>>;
  getTabs(): Promise<BrowserTab[]>;
  getWindowActiveSpaceId(windowId: number): Promise<string | null | undefined>;
  getWindowIncognito(windowId: number): Promise<boolean>;
  openTabInSpace(options: OpenTabInSpaceOptions): Promise<OpenTabInSpaceResult>;
}

/** Opens a favourite in the space already holding that page when possible. */
export async function openFavourite(
  payload: OpenFavouritePayload,
  windowId: number,
  effects: FavouriteOpeningEffects,
): Promise<BrowserTab> {
  const [tree, storedActiveSpaceId, incognito] = await Promise.all([
    effects.getBookmarkTree(),
    effects.getWindowActiveSpaceId(windowId),
    effects.getWindowIncognito(windowId),
  ]);
  const spaces = shownSpaces(deriveSpaces(tree));
  const activeSpaceId = preferredActiveSpaceId(
    spaces,
    storedActiveSpaceId,
    payload.activeSpaceId,
  );
  if (!activeSpaceId) throw new Error('No space is available.');
  const forceNew = payload.forceNew ?? false;
  let destinationSpaceId = activeSpaceId;
  if (!forceNew) {
    const contextTabs = tabsInBrowsingContext(await effects.getTabs(), incognito);
    destinationSpaceId = preferredSpaceForPage(
      payload.url,
      activeSpaceId,
      spaces,
      indexTabSpacesByPageIdentity(
        contextTabs,
        await effects.getTabSpaceIds(contextTabs),
      ),
    );
  }
  const { tab } = await effects.openTabInSpace({
    active: true,
    destinationSpaceId,
    forceNew,
    reuse: 'browser',
    url: payload.url,
    windowId,
  });
  return tab;
}