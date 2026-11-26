import {
  BOOKMARKS_FOLDER_TITLE,
  bookmarkableTabUrl,
  bookmarkHyperMetadata,
  bookmarkTitleWithFavouriteSlot,
  bookmarkTitleWithHyper,
  FAVOURITES_FOLDER_TITLE,
  findBookmarkBar,
  findHyperBookmarkStructure,
  HYPER_FOLDER_TITLE,
  isFolderTitled,
  isSpaceTabsFolder,
  isTabBackingBookmark,
  isTabFolder,
  isSplitViewFolder,
  overflowingFavourites,
  parseBookmarkTitle,
  serializeBookmarkTitle,
  spaceBookmarkTitleWithMigratedLastActiveTabWindowIds,
  SPACES_FOLDER_TITLE,
  splitViewFolderBookmarkTitle,
  TABS_FOLDER_TITLE,
  tabBackingBookmarkLink,
  tabBackingBookmarkTitle,
  tabBackingIndex,
  tabBackingInstallationId,
  tabBackingSpaceId,
  tabBackingTitleInWindow,
  tabBackingTitleForSession,
  tabBackingTitleLeavingDomain,
  tabBackingTitleWithName,
  tabBackingTitleWithoutName,
  tabBackingToken,
  tabBackingWindowId,
  tabFolderBookmarkTitle,
  visibleBookmarkTitle,
  type HyperBookmarkStructure,
} from './bookmarks';
import {
  hyperRootTitleWithPreferences,
  legacyPreferenceStorageKeys,
  legacyStoredPreferences,
  savedHyperPreferences,
  type HyperPreferences,
} from './preferences';
import { runConcurrentOperations, withNamedAsyncLock } from './async';
import { addToMapSet } from './collections';
import { tabPageTitle } from './tabBookmarkLink';
import { loadTabOwnerships } from './tabOwnership';
import { canSyncBookmarkTitleFromTab, closeTabOrWindow, closeTabsConcurrently } from './tabs';
import { pageIdentity, urlsShareDomain } from './urlIdentity';

export const INSTALLATION_ID_KEY = 'hyperInstallationId';
const INSTALLATION_STARTED_KEY = 'hyperInstallationStartedAt';
let hierarchyRepair: Promise<HyperBookmarkStructure> | undefined;
let installationIdLoad: Promise<string> | undefined;
let emptyMetadataCleanupBookmarksApi: typeof browser.bookmarks | undefined;
let preferenceWrites: Promise<void> = Promise.resolve();

async function removeFolderIfEmpty(folderId: string): Promise<boolean> {
  const children = await browser.bookmarks.getChildren(folderId).catch(() => undefined);
  if (!children || children.length > 0) return false;
  try {
    await browser.bookmarks.remove(folderId);
    return true;
  } catch {
    return false;
  }
}

async function removeEmptyMetadataSuffixes(
  node: Browser.bookmarks.BookmarkTreeNode,
): Promise<void> {
  const parsed = parseBookmarkTitle(node.title);
  if (
    parsed.title !== node.title &&
    serializeBookmarkTitle('', parsed.metadata) === ''
  ) {
    await browser.bookmarks.update(node.id, { title: parsed.title });
  }
  if (node.url) return;
  const children = await browser.bookmarks.getChildren(node.id);
  await Promise.all(children.map(removeEmptyMetadataSuffixes));
}

async function mergeDuplicateFolders(
  folders: Browser.bookmarks.BookmarkTreeNode[],
): Promise<Browser.bookmarks.BookmarkTreeNode | undefined> {
  const [canonical, ...duplicates] = folders;
  if (!canonical) return undefined;
  for (const duplicate of duplicates) {
    const children = await browser.bookmarks.getChildren(duplicate.id).catch(() => []);
    for (const child of children) {
      await browser.bookmarks.move(child.id, { parentId: canonical.id });
    }
    await removeFolderIfEmpty(duplicate.id);
  }
  return canonical;
}

async function ensureUniqueMatchingFolder(
  parentId: string,
  predicate: (node: Browser.bookmarks.BookmarkTreeNode) => boolean,
  create: () => Promise<unknown>,
  errorMessage: string,
): Promise<Browser.bookmarks.BookmarkTreeNode> {
  let matches = (await browser.bookmarks.getChildren(parentId)).filter(predicate);
  if (matches.length === 0) {
    await create();
    matches = (await browser.bookmarks.getChildren(parentId)).filter(predicate);
  }
  const folder = await mergeDuplicateFolders(matches);
  if (!folder) throw new Error(errorMessage);
  return folder;
}

async function ensureUniqueFolder(
  parentId: string,
  title: string,
  errorMessage = `Unable to initialize ${title}.`,
): Promise<Browser.bookmarks.BookmarkTreeNode> {
  return ensureUniqueMatchingFolder(
    parentId,
    (node) => isFolderTitled(node, title),
    () => browser.bookmarks.create({ parentId, title }),
    errorMessage,
  );
}

/** A space's two marked folders: its tab tree's root, and the root of its bookmarks. */
const spaceFolderRoles = {
  spaceBookmarks: {
    matches: (node: Browser.bookmarks.BookmarkTreeNode) => isFolderTitled(node, BOOKMARKS_FOLDER_TITLE),
    title: BOOKMARKS_FOLDER_TITLE,
  },
  spaceTabs: { matches: isSpaceTabsFolder, title: TABS_FOLDER_TITLE },
} as const;

type SpaceFolderRole = keyof typeof spaceFolderRoles;

async function ensureSpaceFolderForNode(
  space: Browser.bookmarks.BookmarkTreeNode,
  role: SpaceFolderRole,
): Promise<Browser.bookmarks.BookmarkTreeNode> {
  const { matches, title } = spaceFolderRoles[role];
  const marker = { [role]: true, spaceId: space.id };
  const folder = await ensureUniqueMatchingFolder(
    space.id,
    matches,
    () => browser.bookmarks.create({
      parentId: space.id,
      title: serializeBookmarkTitle(title, { hyper: marker }),
    }),
    `Unable to initialize ${title} for ${visibleBookmarkTitle(space)}.`,
  );
  const hyper = bookmarkHyperMetadata(folder);
  if (hyper[role] === true && hyper.spaceId === space.id) return folder;
  return browser.bookmarks.update(folder.id, {
    title: bookmarkTitleWithHyper(folder.title, marker, { visible: title }),
  });
}

/**
 * The bar lost a slot to the global bookmarks button, so a favourite with no
 * slot left joins the global bookmarks rather than vanishing from view.
 */
async function moveOverflowingFavourites(favouritesId: string, globalId: string): Promise<void> {
  const children = await browser.bookmarks.getChildren(favouritesId);
  for (const node of overflowingFavourites(children)) {
    await browser.bookmarks.move(node.id, { parentId: globalId });
    const title = bookmarkTitleWithFavouriteSlot(node);
    if (title !== node.title) await browser.bookmarks.update(node.id, { title });
  }
}

async function repairHyperBookmarkStructure(): Promise<HyperBookmarkStructure> {
  const tree = await browser.bookmarks.getTree();
  const bookmarkBar = findBookmarkBar(tree);
  if (!bookmarkBar) throw new Error('No browser bookmark root is available.');

  const hyper = await ensureUniqueFolder(
    bookmarkBar.id,
    HYPER_FOLDER_TITLE,
    'Unable to initialize Hyper bookmarks.',
  );

  const favourites = await ensureUniqueFolder(hyper.id, FAVOURITES_FOLDER_TITLE);
  const spaces = await ensureUniqueFolder(hyper.id, SPACES_FOLDER_TITLE);
  const globalBookmarks = await ensureUniqueFolder(hyper.id, BOOKMARKS_FOLDER_TITLE);
  await moveOverflowingFavourites(favourites.id, globalBookmarks.id);
  let spaceFolders = (await browser.bookmarks.getChildren(spaces.id)).filter(
    (node) => !node.url,
  );
  if (spaceFolders.length === 0) {
    const space = await browser.bookmarks.create({ parentId: spaces.id, title: 'Space 1' });
    spaceFolders = [space];
  }

  await Promise.all(spaceFolders.map(async (space) => {
    await ensureSpaceFolderForNode(space, 'spaceTabs');
    await ensureSpaceFolderForNode(space, 'spaceBookmarks');
  }));
  if (emptyMetadataCleanupBookmarksApi !== browser.bookmarks) {
    await removeEmptyMetadataSuffixes(hyper);
    emptyMetadataCleanupBookmarksApi = browser.bookmarks;
  }
  const repairedTree = await browser.bookmarks.getTree();
  const structure = findHyperBookmarkStructure(repairedTree);
  if (!structure) {
    throw new Error('Unable to initialize Hyper bookmarks.');
  }
  return structure;
}

export function ensureHyperBookmarkStructure(): Promise<HyperBookmarkStructure> {
  hierarchyRepair ??= repairHyperBookmarkStructure().finally(() => {
    hierarchyRepair = undefined;
  });
  return hierarchyRepair;
}

export async function saveHyperPreferences(
  preferences: Partial<HyperPreferences>,
): Promise<void> {
  await writeHyperPreferences(() => preferences);
}

/** Writers read and rewrite the one root title, so a second must wait for the first. */
function writeHyperPreferences(
  next: (saved: Partial<HyperPreferences>) => Partial<HyperPreferences>,
): Promise<void> {
  const write = preferenceWrites.then(async () => {
    const { hyper } = await ensureHyperBookmarkStructure();
    const title = hyperRootTitleWithPreferences(hyper, next(savedHyperPreferences(hyper)));
    if (title !== hyper.title) await browser.bookmarks.update(hyper.id, { title });
  });
  preferenceWrites = write.catch(() => undefined);
  return write;
}

/**
 * Moves preferences that earlier versions kept in storage.local onto the root
 * folder, then removes them. A preference the root already carries was saved
 * after the move, on this device or another through sync, so it wins over the
 * stale local copy.
 */
export async function migrateLegacyPreferences(): Promise<void> {
  const stored = await browser.storage.local.get([...legacyPreferenceStorageKeys]);
  if (Object.keys(stored).length === 0) return;
  await writeHyperPreferences((saved) => ({ ...legacyStoredPreferences(stored), ...saved }));
  await browser.storage.local.remove([...legacyPreferenceStorageKeys]);
}

export interface TabBackingLocation {
  backingId: string;
  backingToken: string;
  spaceId: string;
  windowId?: number;
  url: string;
}

export async function installationId(): Promise<string> {
  installationIdLoad ??= (async () => {
    const loadOrCreate = async () => {
      const stored = await browser.storage.local.get(INSTALLATION_ID_KEY);
      if (typeof stored[INSTALLATION_ID_KEY] === 'string') {
        return stored[INSTALLATION_ID_KEY];
      }
      // Removing and re-adding the extension clears its storage, but not the tabs it backs.
      const inherited = await installationInOpenWindows().catch(() => undefined);
      const created = inherited ?? crypto.randomUUID();
      await browser.storage.local.set({
        [INSTALLATION_ID_KEY]: created,
        ...(inherited ? {} : { [INSTALLATION_STARTED_KEY]: Date.now() }),
      });
      return created;
    };
    return withNamedAsyncLock(INSTALLATION_ID_KEY, loadOrCreate);
  })().catch((error) => {
    installationIdLoad = undefined;
    throw error;
  });
  return installationIdLoad;
}

async function ensureSpaceFolder(spaceId: string, role: SpaceFolderRole) {
  const structure = await ensureHyperBookmarkStructure();
  const space = (await browser.bookmarks.getChildren(structure.spaces.id)).find(
    (node) => !node.url && node.id === spaceId,
  );
  if (!space) throw new Error('This space no longer exists.');
  return ensureSpaceFolderForNode(space, role);
}

export function ensureSpaceTabsFolder(spaceId: string) {
  return ensureSpaceFolder(spaceId, 'spaceTabs');
}

export function ensureSpaceBookmarksFolder(spaceId: string) {
  return ensureSpaceFolder(spaceId, 'spaceBookmarks');
}

interface TabTreeContents {
  backings: Browser.bookmarks.BookmarkTreeNode[];
  folders: Browser.bookmarks.BookmarkTreeNode[];
}

/** Reads the whole tabs tree once, then walks it in order. */
async function tabTreeContents(
  tabsFolder: Browser.bookmarks.BookmarkTreeNode,
): Promise<TabTreeContents> {
  const contents: TabTreeContents = { backings: [], folders: [] };
  const visit = (folder: Browser.bookmarks.BookmarkTreeNode): void => {
    for (const child of folder.children ?? []) {
      if (isTabBackingBookmark(child)) {
        contents.backings.push(child);
      } else if (isTabFolder(child)) {
        contents.folders.push(child);
        visit(child);
      }
    }
  };
  const [subtree] = await browser.bookmarks.getSubTree(tabsFolder.id);
  if (subtree) visit(subtree);
  return contents;
}

/** Every space folder, in order, or none while the structure is missing. */
async function hyperSpaceFolders(): Promise<Browser.bookmarks.BookmarkTreeNode[]> {
  const structure = findHyperBookmarkStructure(await browser.bookmarks.getTree());
  if (!structure) return [];
  return (await browser.bookmarks.getChildren(structure.spaces.id)).filter((node) => !node.url);
}

async function spaceTabsFolders(spaceId: string): Promise<Browser.bookmarks.BookmarkTreeNode[]> {
  return (await browser.bookmarks.getChildren(spaceId)).filter(isSpaceTabsFolder);
}

/** Every backing in the tab trees under these Tabs folders, in order. */
async function backingsIn(
  tabsFolders: readonly Browser.bookmarks.BookmarkTreeNode[],
): Promise<Browser.bookmarks.BookmarkTreeNode[]> {
  return (await Promise.all(tabsFolders.map(async (folder) =>
    (await tabTreeContents(folder)).backings))).flat();
}

async function findSpaceTabsFolders(
  spaceId: string,
): Promise<Browser.bookmarks.BookmarkTreeNode[]> {
  const structure = findHyperBookmarkStructure(await browser.bookmarks.getTree());
  if (!structure) return [];
  const space = await bookmarkById(spaceId);
  if (!space || space.url || space.parentId !== structure.spaces.id) return [];
  return spaceTabsFolders(space.id);
}

/**
 * Whether a folder is the space's Tabs folder or a tab folder within it, each
 * folder from it up to that Tabs folder being a tab folder.
 */
async function tabTreeFolderHasCanonicalLocation(
  folder: Browser.bookmarks.BookmarkTreeNode | undefined,
  spaceId: string,
): Promise<boolean> {
  for (let node = folder; node; node = await bookmarkById(node.parentId)) {
    if (isSpaceTabsFolder(node)) {
      return node.parentId === spaceId && await spaceHasCanonicalAncestry(spaceId);
    }
    if (!isTabFolder(node)) return false;
  }
  return false;
}

async function tabFolderHasCanonicalLocation(
  folder: Browser.bookmarks.BookmarkTreeNode,
  spaceId: string,
): Promise<boolean> {
  return isTabFolder(folder) && tabTreeFolderHasCanonicalLocation(folder, spaceId);
}

/** A tab folder that sits where it belongs in any space's tab tree. */
async function canonicalTabFolder(
  folderId: string,
): Promise<Browser.bookmarks.BookmarkTreeNode & { parentId: string }> {
  const folder = await bookmarkById(folderId);
  const isCanonical = folder && await Promise.all(
    (await hyperSpaceFolders()).map((space) => tabFolderHasCanonicalLocation(folder, space.id)),
  );
  if (!folder?.parentId || !isCanonical?.some(Boolean)) {
    throw new Error('This tab folder no longer exists.');
  }
  return { ...folder, parentId: folder.parentId };
}

/** A folder title trimmed, refusing one left blank. */
function requireFolderTitle(title: string): string {
  const trimmed = title.trim();
  if (!trimmed) throw new Error('A folder title is required.');
  return trimmed;
}

export async function createTabFolder(
  spaceId: string,
  parentId?: string,
  title = 'New folder',
): Promise<Browser.bookmarks.BookmarkTreeNode> {
  const nextTitle = requireFolderTitle(title);
  const tabsFolder = await ensureSpaceTabsFolder(spaceId);
  let targetParentId = tabsFolder.id;
  if (parentId && parentId !== tabsFolder.id) {
    const parent = await bookmarkById(parentId);
    if (!parent || !(await tabFolderHasCanonicalLocation(parent, spaceId))) {
      throw new Error('This tab folder no longer exists.');
    }
    targetParentId = parent.id;
  }
  return browser.bookmarks.create({
    parentId: targetParentId,
    title: tabFolderBookmarkTitle(nextTitle),
  });
}

export async function renameTabFolder(
  folderId: string,
  title: string,
): Promise<Browser.bookmarks.BookmarkTreeNode> {
  const nextTitle = requireFolderTitle(title);
  const folder = await canonicalTabFolder(folderId);
  return browser.bookmarks.update(folder.id, {
    title: tabFolderBookmarkTitle(nextTitle, folder.title),
  });
}

/**
 * Removes a tab folder. Alone, only an empty one, as cancelling a new folder
 * must. Given a window, as the bin does, the folder's tabs in that window
 * close, and whatever else it held (other windows' and sessions' tabs, parked
 * tabs) moves up to where it was, so nothing the window did not show is lost.
 */
export async function removeTabFolder(folderId: string, closingWindowId?: number): Promise<void> {
  const folder = await canonicalTabFolder(folderId);
  if (closingWindowId === undefined) {
    if ((await browser.bookmarks.getChildren(folder.id)).length > 0) {
      throw new Error('Only empty tab folders can be removed.');
    }
    await browser.bookmarks.remove(folder.id);
    return;
  }
  const held: Browser.bookmarks.BookmarkTreeNode[] = [];
  const collect = (node: Browser.bookmarks.BookmarkTreeNode) => {
    for (const child of node.children ?? []) {
      if (child.url) held.push(child);
      else collect(child);
    }
  };
  const [subtree] = await browser.bookmarks.getSubTree(folder.id);
  if (subtree) collect(subtree);
  const heldIds = new Set(held.map((node) => node.id));
  const windowTabs = await browser.tabs.query({ windowId: closingWindowId });
  const ownerships = await loadTabOwnerships(windowTabs);
  const closing = windowTabs.flatMap((tab) => {
    const backingId = tab.id === undefined ? undefined : ownerships[tab.id]?.backingId;
    return tab.id !== undefined && backingId && heldIds.has(backingId) ? [{ backingId, tabId: tab.id }] : [];
  });
  await closeTabsConcurrently(
    closing.map(({ tabId }) => tabId),
    (tabId) => closeTabOrWindow(tabId, closingWindowId),
  );
  const closed = new Set(closing.map(({ backingId }) => backingId));
  let index = folder.index ?? 0;
  for (const node of held) {
    if (closed.has(node.id)) continue;
    await browser.bookmarks.move(node.id, { index, parentId: folder.parentId });
    index += 1;
  }
  await browser.bookmarks.removeTree(folder.id);
}

export async function removeProvisionalBookmarkFolder(
  folderId: string,
  expectedTitle: string,
): Promise<boolean> {
  const [folder, children] = await Promise.all([
    bookmarkById(folderId),
    browser.bookmarks.getChildren(folderId).catch(() => []),
  ]);
  if (
    !folder ||
    folder.url ||
    visibleBookmarkTitle(folder) !== expectedTitle ||
    children.length > 0
  ) return false;
  await browser.bookmarks.remove(folder.id);
  return true;
}

export async function moveTabTreeNode(
  spaceId: string,
  nodeId: string,
  destination: { parentId: string; index?: number },
): Promise<Browser.bookmarks.BookmarkTreeNode> {
  if (
    destination.index !== undefined &&
    (!Number.isInteger(destination.index) || destination.index < 0)
  ) {
    throw new Error('The destination index is invalid.');
  }
  const [node, parent] = await Promise.all([
    bookmarkById(nodeId),
    bookmarkById(destination.parentId),
  ]);
  if (!node || !parent || parent.url) {
    throw new Error('This tab tree destination is unavailable.');
  }
  const sourceIsCanonical = isTabFolder(node)
    ? await tabFolderHasCanonicalLocation(node, spaceId)
    : isTabBackingBookmark(node) && await backingHasLocalCanonicalLocation(node, spaceId);
  if (!sourceIsCanonical) throw new Error('This tab tree node cannot be moved.');
  if (!(await tabTreeFolderHasCanonicalLocation(parent, spaceId))) {
    throw new Error('This tab tree destination is unavailable.');
  }
  if (isTabFolder(node)) {
    let ancestor: Browser.bookmarks.BookmarkTreeNode | undefined = parent;
    while (ancestor) {
      if (ancestor.id === node.id) {
        throw new Error('A tab folder cannot be moved into itself or its descendant.');
      }
      if (isSpaceTabsFolder(ancestor)) break;
      ancestor = await bookmarkById(ancestor.parentId);
    }
  }
  return browser.bookmarks.move(node.id, destination);
}

/** Moves nodes in order so each lands directly after the one before it. */
export async function moveTabTreeNodes(
  spaceId: string,
  nodeIds: readonly string[],
  destination: { parentId: string; index?: number },
): Promise<void> {
  let index = destination.index;
  for (const nodeId of nodeIds) {
    const moved = await moveTabTreeNode(spaceId, nodeId, {
      parentId: destination.parentId,
      ...(index === undefined ? {} : { index }),
    });
    if (index !== undefined) index = (moved.index ?? index) + 1;
  }
}

/**
 * Stores a split view's tabs, in pane order, in a split view folder where the
 * first of them sits. A tab leaving another split takes the new folder to where
 * that one sits, so split view folders never nest.
 */
export async function gatherSplitViewFolder(
  spaceId: string,
  backingIds: readonly string[],
): Promise<Browser.bookmarks.BookmarkTreeNode> {
  const first = await bookmarkById(backingIds[0]);
  const firstParent = await bookmarkById(first?.parentId);
  const anchor = firstParent && isSplitViewFolder(firstParent) ? firstParent : first;
  const parent = await bookmarkById(anchor?.parentId);
  if (
    !first ||
    !isTabBackingBookmark(first) ||
    !(await backingHasLocalCanonicalLocation(first, spaceId)) ||
    !parent ||
    anchor?.index === undefined ||
    !(await tabTreeFolderHasCanonicalLocation(parent, spaceId))
  ) {
    throw new Error('This tab is no longer in its space.');
  }
  const folder = await browser.bookmarks.create({
    index: anchor.index,
    parentId: parent.id,
    title: splitViewFolderBookmarkTitle(),
  });
  await moveTabTreeNodes(spaceId, backingIds, { parentId: folder.id, index: 0 });
  return folder;
}

/**
 * Puts a split view folder's tabs back where it sits, in order, and removes it.
 * One holding a folder was arranged by hand, so it stays as it is.
 */
export async function dissolveSplitViewFolder(
  spaceId: string,
  folderId: string,
): Promise<void> {
  const folder = await bookmarkById(folderId);
  if (
    !folder ||
    !isSplitViewFolder(folder) ||
    folder.parentId === undefined ||
    folder.index === undefined ||
    !(await tabFolderHasCanonicalLocation(folder, spaceId))
  ) return;
  const children = await browser.bookmarks.getChildren(folder.id);
  if (children.some((child) => !child.url)) return;
  for (const [offset, child] of children.entries()) {
    await browser.bookmarks.move(child.id, {
      index: folder.index + offset,
      parentId: folder.parentId,
    });
  }
  await browser.bookmarks.remove(folder.id);
}

export async function windowTabBackings(
  spaceId: string,
  windowId: number,
): Promise<Browser.bookmarks.BookmarkTreeNode[]> {
  const localInstallationId = await installationId();
  return (await backingsIn(await findSpaceTabsFolders(spaceId))).filter((backing) =>
    tabBackingInstallationId(backing) === localInstallationId &&
    tabBackingWindowId(backing) === windowId &&
    tabBackingSpaceId(backing) === spaceId);
}

async function retitleTabBackingWindow(
  backing: Browser.bookmarks.BookmarkTreeNode,
  spaceId: string,
  windowId: number,
  localInstallationId: string,
): Promise<void> {
  const title = tabBackingBookmarkTitle(
    visibleBookmarkTitle(backing),
    tabBackingIndex(backing),
    tabBackingToken(backing),
    spaceId,
    backing.title,
    { windowId, installationId: localInstallationId },
  );
  if (title !== backing.title) {
    await browser.bookmarks.update(backing.id, { title });
  }
}

/** Records a parked backing under the window whose tab has taken it back. */
export async function moveTabBackingToWindow(backingId: string, windowId: number): Promise<void> {
  const backing = await bookmarkById(backingId);
  const spaceId = backing && tabBackingSpaceId(backing);
  const localInstallationId = await installationId();
  if (!backing || !spaceId || tabBackingInstallationId(backing) !== localInstallationId) return;
  await retitleTabBackingWindow(backing, spaceId, windowId, localInstallationId);
}

export async function migrateTabBackingWindowIds(
  previousToCurrentWindowIds: ReadonlyMap<number, number>,
): Promise<Set<string>> {
  if (previousToCurrentWindowIds.size === 0) return new Set();
  const spaces = await hyperSpaceFolders();
  if (spaces.length === 0) return new Set();
  const localInstallationId = await installationId();
  const migratedIds = new Set<string>();
  for (const space of spaces) {
    const migratedSpaceTitle = spaceBookmarkTitleWithMigratedLastActiveTabWindowIds(
      space,
      previousToCurrentWindowIds,
    );
    if (migratedSpaceTitle !== space.title) {
      await browser.bookmarks.update(space.id, { title: migratedSpaceTitle });
    }
    for (const backing of await backingsIn(await spaceTabsFolders(space.id))) {
      const previousWindowId = tabBackingWindowId(backing);
      const currentWindowId = previousWindowId === undefined
        ? undefined
        : previousToCurrentWindowIds.get(previousWindowId);
      const spaceId = tabBackingSpaceId(backing);
      if (
        currentWindowId === undefined ||
        currentWindowId === previousWindowId ||
        !spaceId ||
        tabBackingInstallationId(backing) !== localInstallationId
      ) continue;
      await retitleTabBackingWindow(backing, spaceId, currentWindowId, localInstallationId);
      migratedIds.add(backing.id);
    }
  }
  return migratedIds;
}

export interface LocalTabBacking {
  backingId: string;
  backingToken: string;
  spaceId: string;
  tabIndex?: number;
  url: string;
  windowId: number;
}

/** This installation's backings that name a window, wherever they sit in their space's tab tree. */
export async function localTabBackings(): Promise<LocalTabBacking[]> {
  const backings = await localWindowTabBackings();
  return backings.flatMap((backing) => {
    const windowId = tabBackingWindowId(backing)!;
    const backingToken = tabBackingToken(backing);
    const spaceId = tabBackingSpaceId(backing);
    const tabIndex = tabBackingIndex(backing);
    return backingToken && spaceId && backing.url
      ? [{
          backingId: backing.id,
          backingToken,
          spaceId,
          ...(tabIndex === undefined ? {} : { tabIndex }),
          url: backing.url,
          windowId,
        }]
      : [];
  });
}

/** This installation's backings that name a window, in every space. */
async function localWindowTabBackings(): Promise<Browser.bookmarks.BookmarkTreeNode[]> {
  const backings = await allTabBackings();
  if (backings.length === 0) return [];
  const localInstallationId = await installationId();
  return backings.filter((backing) =>
    tabBackingWindowId(backing) !== undefined &&
    tabBackingInstallationId(backing) === localInstallationId);
}

export async function localTabBackingPagesByWindow(): Promise<Map<number, Set<string>>> {
  const pagesByWindow = new Map<number, Set<string>>();
  for (const backing of await localTabBackings()) {
    const identity = pageIdentity(backing.url);
    if (!identity) continue;
    addToMapSet(pagesByWindow, backing.windowId, identity);
  }
  return pagesByWindow;
}

/** Windows still open; a backing recorded under any other window is parked. */
async function openWindowIds(): Promise<Set<number>> {
  return new Set((await browser.windows.getAll()).flatMap((window) =>
    window.id === undefined ? [] : [window.id]));
}

async function allTabBackings(): Promise<Browser.bookmarks.BookmarkTreeNode[]> {
  const backings: Browser.bookmarks.BookmarkTreeNode[] = [];
  for (const space of await hyperSpaceFolders()) {
    backings.push(...await backingsIn(await spaceTabsFolders(space.id)));
  }
  return backings;
}

/** The installation whose backings name this browser's open windows, which no other device can. */
async function installationInOpenWindows(): Promise<string | undefined> {
  const open = await openWindowIds();
  const counts = new Map<string, number>();
  for (const backing of await allTabBackings()) {
    const installation = tabBackingInstallationId(backing);
    const windowId = tabBackingWindowId(backing);
    if (installation && windowId !== undefined && open.has(windowId)) {
      counts.set(installation, (counts.get(installation) ?? 0) + 1);
    }
  }
  return [...counts].sort((left, right) => right[1] - left[1])[0]?.[0];
}

async function installationStartedAt(
  local: string,
  backings: readonly Browser.bookmarks.BookmarkTreeNode[],
): Promise<number> {
  const stored = (await browser.storage.local.get(INSTALLATION_STARTED_KEY))[INSTALLATION_STARTED_KEY];
  if (typeof stored === 'number') return stored;
  // An installation from before this was recorded began no later than its oldest backing.
  const started = Math.min(Date.now(), ...backings.flatMap((backing) =>
    tabBackingInstallationId(backing) === local && backing.dateAdded !== undefined
      ? [backing.dateAdded]
      : []));
  await browser.storage.local.set({ [INSTALLATION_STARTED_KEY]: started });
  return started;
}

/**
 * The installation this one replaced: the latest whose backings all predate it.
 * Reinstalling starts a new installation, while another device in use goes on
 * adding backings after this one began.
 */
async function predecessorInstallation(
  local: string,
  backings: readonly Browser.bookmarks.BookmarkTreeNode[],
): Promise<string | undefined> {
  const started = await installationStartedAt(local, backings);
  const newest = new Map<string, number>();
  for (const backing of backings) {
    const installation = tabBackingInstallationId(backing);
    if (!installation || installation === local) continue;
    newest.set(installation, Math.max(newest.get(installation) ?? 0, backing.dateAdded ?? 0));
  }
  return [...newest]
    .filter(([, added]) => added < started)
    .sort((left, right) => right[1] - left[1])[0]?.[0];
}

async function parkedTabBackings(
  spaceId: string,
): Promise<Browser.bookmarks.BookmarkTreeNode[]> {
  const localInstallationId = await installationId();
  const open = await openWindowIds();
  const backings = (await backingsIn(await findSpaceTabsFolders(spaceId))).filter((backing) =>
    tabBackingSpaceId(backing) === spaceId);
  const local = backings.filter((backing) => tabBackingInstallationId(backing) === localInstallationId);
  const parked = local.filter((backing) => {
    const windowId = tabBackingWindowId(backing);
    return windowId === undefined || !open.has(windowId);
  });
  const predecessor = await predecessorInstallation(localInstallationId, await allTabBackings());
  if (!predecessor) return parked;
  // Tabs the replaced installation left waiting for this space wait for it here, unless already here.
  const pages = new Set(local.map((backing) => pageIdentity(backing.url)));
  return [...parked, ...backings.filter((backing) =>
    tabBackingInstallationId(backing) === predecessor &&
    tabBackingWindowId(backing) === undefined &&
    !pages.has(pageIdentity(backing.url)))];
}

export async function hasParkedTabBackings(spaceId: string): Promise<boolean> {
  return (await parkedTabBackings(spaceId)).length > 0;
}

async function openWindowBackingPageCounts(): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  const open = await openWindowIds();
  for (const backing of await localWindowTabBackings()) {
    const identity = pageIdentity(backing.url);
    if (!identity || !open.has(tabBackingWindowId(backing)!)) continue;
    counts.set(identity, (counts.get(identity) ?? 0) + 1);
  }
  return counts;
}

/** Hands a space's parked backings to the window it is opening in, for restoration there. */
export async function adoptParkedTabBackings(
  spaceId: string,
  windowId: number,
): Promise<number> {
  const parked = await parkedTabBackings(spaceId);
  if (parked.length === 0) return 0;
  // Live pages no open-window backing accounts for were restored by the browser itself.
  const unbacked = new Map<string, number>();
  for (const tab of await browser.tabs.query({})) {
    const identity = pageIdentity(bookmarkableTabUrl(tab, browser.runtime.getURL('')) ?? undefined);
    if (identity && !tab.incognito) unbacked.set(identity, (unbacked.get(identity) ?? 0) + 1);
  }
  for (const [identity, count] of await openWindowBackingPageCounts()) {
    unbacked.set(identity, (unbacked.get(identity) ?? 0) - count);
  }
  let adopted = 0;
  for (const backing of parked) {
    const identity = pageIdentity(backing.url);
    if (identity && (unbacked.get(identity) ?? 0) > 0) {
      unbacked.set(identity, unbacked.get(identity)! - 1);
      await browser.bookmarks.remove(backing.id);
      continue;
    }
    await browser.bookmarks.update(backing.id, {
      title: tabBackingTitleInWindow(backing.title, windowId, await installationId()),
    });
    adopted += 1;
  }
  return adopted;
}

/** The space whose tabs hold a backing, through any folders, earlier layouts' window folders included. */
async function backingSpaceId(
  backing: Browser.bookmarks.BookmarkTreeNode,
): Promise<string | undefined> {
  let parent = await bookmarkById(backing.parentId);
  while (parent && !parent.url) {
    if (isSpaceTabsFolder(parent)) {
      return parent.parentId && await spaceHasCanonicalAncestry(parent.parentId)
        ? parent.parentId
        : undefined;
    }
    parent = await bookmarkById(parent.parentId);
  }
  return undefined;
}

async function keptBacking(backingId: string) {
  const backing = await bookmarkById(backingId);
  const spaceId = backing && isTabBackingBookmark(backing) ? await backingSpaceId(backing) : undefined;
  if (!backing?.url || !spaceId) throw new Error('That tab is no longer kept in a space.');
  return { backing, spaceId, url: backing.url };
}

/** The page another session keeps a tab of, as a bookmark of it would name it. */
export async function sessionBackingPage(backingId: string): Promise<{ title: string; url: string }> {
  const { backing, url } = await keptBacking(backingId);
  if (tabBackingInstallationId(backing) === await installationId()) {
    throw new Error('This session\'s tabs are bookmarked from its windows.');
  }
  return { title: visibleBookmarkTitle(backing) || url, url };
}

/** Keeps a copy of a backing's tab for another session, beside it and parked until that session opens the space. */
export async function copyBackingToSession(
  backingId: string,
  sessionInstallationId: string,
): Promise<Browser.bookmarks.BookmarkTreeNode> {
  const { backing, spaceId, url } = await keptBacking(backingId);
  const parent = await bookmarkById(backing.parentId);
  // A split view folder holds one split's tabs, so a copy for another session sits beside it.
  const anchor = parent && isSplitViewFolder(parent) ? parent : backing;
  return browser.bookmarks.create({
    parentId: anchor.parentId,
    ...(anchor.index === undefined ? {} : { index: anchor.index + 1 }),
    title: tabBackingTitleForSession(backing.title, {
      installationId: sessionInstallationId,
      spaceId,
      tabToken: crypto.randomUUID(),
    }),
    url,
  });
}

/**
 * Hands another session's tab to a session: parked for another one, or to this
 * one in `windowId`, for a tab there to take over. A `spaceId` it must be kept
 * in guards a move meant for that space.
 */
export async function moveBackingToSession(
  backingId: string,
  session: { installationId: string; spaceId?: string; windowId?: number },
): Promise<TabBackingLocation> {
  const { backing, spaceId, url } = await keptBacking(backingId);
  if (session.spaceId !== undefined && session.spaceId !== spaceId) {
    throw new Error('That tab is kept in another space.');
  }
  if (tabBackingInstallationId(backing) === await installationId()) {
    throw new Error('That tab is already this session\'s.');
  }
  const backingToken = tabBackingToken(backing) ?? crypto.randomUUID();
  const updated = await browser.bookmarks.update(backing.id, {
    title: tabBackingTitleForSession(backing.title, {
      installationId: session.installationId,
      spaceId,
      tabToken: backingToken,
      ...(session.windowId === undefined ? {} : { windowId: session.windowId }),
    }),
  });
  // An earlier layout's window folder is no place for a tab this session keeps.
  if (session.windowId !== undefined && !(await backingHasCanonicalLocation(updated, spaceId))) {
    await browser.bookmarks.move(backing.id, { parentId: (await ensureSpaceTabsFolder(spaceId)).id });
  }
  return {
    backingId: backing.id,
    backingToken,
    spaceId,
    url,
    ...(session.windowId === undefined ? {} : { windowId: session.windowId }),
  };
}

export async function reconcileTabBackingFolders(
  openWindowIds: ReadonlySet<number>,
  liveBackingIds: ReadonlySet<string>,
  shouldContinue: () => boolean = () => true,
): Promise<void> {
  const spaces = await hyperSpaceFolders();
  if (spaces.length === 0) return;
  const localInstallationId = await installationId();
  await runConcurrentOperations(spaces, async (space) => {
    await runConcurrentOperations(await spaceTabsFolders(space.id), async (tabsFolder) => {
      const staleBackings = (await tabTreeContents(tabsFolder)).backings.filter((backing) =>
        tabBackingInstallationId(backing) === localInstallationId &&
        tabBackingWindowId(backing) !== undefined &&
        !liveBackingIds.has(backing.id));
      await runConcurrentOperations(staleBackings, async (backing) => {
        if (!shouldContinue()) {
          throw new Error('Tab lifecycle changed during reconciliation.');
        }
        // A window that did not come back leaves its tabs parked for their space.
        if (!openWindowIds.has(tabBackingWindowId(backing)!)) {
          await browser.bookmarks.update(backing.id, {
            title: tabBackingTitleInWindow(backing.title, undefined),
          });
        } else await browser.bookmarks.remove(backing.id);
      }, 'Unable to reconcile every backing.');
    }, 'Unable to reconcile every tabs container.');
  }, 'Unable to reconcile every tab backing.');
}

/** The node with this ID, or nothing if there is none. */
export async function bookmarkById(
  id: string | undefined,
): Promise<Browser.bookmarks.BookmarkTreeNode | undefined> {
  if (!id) return undefined;
  return (await browser.bookmarks.get(id).catch(() => []))[0];
}

/** The nodes with these IDs that still exist, in order. */
export async function existingBookmarks(
  ids: readonly string[],
): Promise<Browser.bookmarks.BookmarkTreeNode[]> {
  return (await Promise.all(ids.map(bookmarkById))).filter((node) => node !== undefined);
}

async function spaceHasCanonicalAncestry(spaceId: string): Promise<boolean> {
  const structure = findHyperBookmarkStructure(await browser.bookmarks.getTree());
  const space = await bookmarkById(spaceId);
  return Boolean(space && !space.url && space.parentId === structure?.spaces.id);
}

async function backingHasCanonicalLocation(
  backing: Browser.bookmarks.BookmarkTreeNode,
  spaceId: string,
): Promise<boolean> {
  return tabBackingSpaceId(backing) === spaceId &&
    tabTreeFolderHasCanonicalLocation(await bookmarkById(backing.parentId), spaceId);
}

async function backingHasLocalCanonicalLocation(
  backing: Browser.bookmarks.BookmarkTreeNode,
  spaceId: string,
  windowId?: number,
): Promise<boolean> {
  const localInstallationId = await installationId();
  return tabBackingInstallationId(backing) === localInstallationId &&
    (windowId === undefined || tabBackingWindowId(backing) === windowId) &&
    backingHasCanonicalLocation(backing, spaceId);
}

async function backingIsAdoptableExactCandidate(
  backing: Browser.bookmarks.BookmarkTreeNode,
  previous: Partial<TabBackingLocation>,
): Promise<boolean> {
  if (
    !previous.backingToken ||
    !previous.spaceId ||
    !tabBackingMatchesLocation(backing, {
      backingId: backing.id,
      backingToken: previous.backingToken,
      spaceId: previous.spaceId,
    })
  ) return false;
  return backingHasLocalCanonicalLocation(
    backing,
    previous.spaceId,
    previous.windowId,
  );
}

/**
 * Where a new backing goes in its space's tab tree, named by the backings of
 * other tabs: just after one, as a link's tab follows its page, or between the
 * backed tabs either side of its tab in the strip.
 */
export type TabBackingPlace = { after: string } | { previous?: string; next: string };

/** The node holding a backing's place in its space's tab tree: the backing, or its split view, which takes no third tab. */
async function tabTreeUnit(
  backingId: string,
  spaceId: string,
): Promise<Browser.bookmarks.BookmarkTreeNode | undefined> {
  const backing = await bookmarkById(backingId);
  if (!backing || !(await backingHasLocalCanonicalLocation(backing, spaceId))) return undefined;
  const parent = await bookmarkById(backing.parentId);
  return parent && isSplitViewFolder(parent) ? parent : backing;
}

/** A tab tree node and the folders holding it, from its space's Tabs folder down. */
async function tabTreePath(
  node: Browser.bookmarks.BookmarkTreeNode,
): Promise<Browser.bookmarks.BookmarkTreeNode[] | undefined> {
  const path = [node];
  while (!isSpaceTabsFolder(path[0]!)) {
    const parent = await bookmarkById(path[0]!.parentId);
    if (!parent) return undefined;
    path.unshift(parent);
  }
  return path;
}

const besideTreeNode = (node: Browser.bookmarks.BookmarkTreeNode | undefined, offset: 0 | 1) =>
  node?.parentId && node.index !== undefined
    ? { parentId: node.parentId, index: node.index + offset }
    : undefined;

async function tabTreePlace(
  place: TabBackingPlace,
  spaceId: string,
): Promise<{ parentId: string; index: number } | undefined> {
  if ('after' in place) return besideTreeNode(await tabTreeUnit(place.after, spaceId), 1);
  const next = await tabTreeUnit(place.next, spaceId);
  const nextPath = next && await tabTreePath(next);
  if (!nextPath) return undefined;
  const previous = place.previous ? await tabTreeUnit(place.previous, spaceId) : undefined;
  const previousPath = previous && await tabTreePath(previous);
  const parting = previousPath?.findIndex((node, depth) => nextPath[depth]?.id !== node.id);
  // Both are one split view, which the tab cannot join.
  if (parting === -1) return besideTreeNode(previous, 1);
  // With no tab before it, the tab joins no folder: it goes before the next one's top-level node.
  if (!previousPath || !parting) return besideTreeNode(nextPath[1], 0);
  // Otherwise it follows the previous one, in the deepest folder that holds the next one too.
  return besideTreeNode(previousPath[parting], 1);
}

export async function ensureTabBackingBookmark(
  tab: Browser.tabs.Tab,
  spaceId: string,
  previous?: Partial<TabBackingLocation>,
  claimedBackingIds: ReadonlySet<string> = new Set(),
  claimedBackingTokens: ReadonlySet<string> = new Set(),
  /** Where a backing it has to create goes, asked only then; with no place, it goes last. */
  placeNewBacking?: () => Promise<TabBackingPlace | undefined>,
): Promise<TabBackingLocation | undefined> {
  if (tab.incognito) return undefined;
  const url = bookmarkableTabUrl(tab, browser.runtime.getURL(''));
  const identity = pageIdentity(url ?? undefined);
  if (!url || !identity) return undefined;

  const tabsFolder = await ensureSpaceTabsFolder(spaceId);
  const localInstallationId = await installationId();
  const children = (await tabTreeContents(tabsFolder)).backings;
  const sameTab = (node: Browser.bookmarks.BookmarkTreeNode) =>
    tabBackingInstallationId(node) === localInstallationId &&
    tabBackingSpaceId(node) === spaceId &&
    pageIdentity(node.url) === identity;
  // A parked backing is a closed window's tab awaiting its space; a live copy takes it over.
  const open = await openWindowIds();
  const matches = [
    ...children.filter((node) => sameTab(node) && tabBackingWindowId(node) === tab.windowId),
    ...children.filter((node) => {
      const windowId = tabBackingWindowId(node);
      return sameTab(node) && (windowId === undefined || !open.has(windowId));
    }),
  ];
  let existing = previous?.backingId && !claimedBackingIds.has(previous.backingId)
    ? await bookmarkById(previous.backingId)
    : undefined;
  let rejectedExactBackingId: string | undefined;
  if (
    existing && (
      !(await backingIsAdoptableExactCandidate(existing, previous ?? {}))
    )
  ) {
    rejectedExactBackingId = existing.id;
    existing = undefined;
  }
  existing ??= previous?.backingToken
    ? children.find((node) =>
        isTabBackingBookmark(node) &&
        tabBackingInstallationId(node) === localInstallationId &&
        tabBackingSpaceId(node) === spaceId &&
        !claimedBackingIds.has(node.id) &&
        !claimedBackingTokens.has(tabBackingToken(node) ?? '') &&
        tabBackingToken(node) === previous.backingToken)
    : undefined;
  existing ??= matches.find((node) =>
    node.id !== rejectedExactBackingId &&
    !claimedBackingIds.has(node.id) &&
    !claimedBackingTokens.has(tabBackingToken(node) ?? ''),
  );
  const previousClaimed = Boolean(
    previous?.backingId && claimedBackingIds.has(previous.backingId),
  ) || Boolean(
    previous?.backingToken && (
      claimedBackingTokens.has(previous.backingToken) ||
      children.some((node) =>
        claimedBackingIds.has(node.id) &&
        tabBackingToken(node) === previous.backingToken)
    ),
  );
  const backingToken = (!previousClaimed && !rejectedExactBackingId
    ? previous?.backingToken
    : undefined)
    ?? (existing && !previousClaimed ? tabBackingToken(existing) : undefined)
    ?? crypto.randomUUID();
  const leftDomain = Boolean(existing?.url && !urlsShareDomain(existing.url, url));
  const link = existing && !leftDomain ? tabBackingBookmarkLink(existing) : {};
  // An unlinked bookmark's name can linger in the tab strip until the page title is restored.
  const namingBookmarkId = link.linkedBookmarkId ?? link.declinedBookmarkId;
  const namingBookmark = await bookmarkById(namingBookmarkId);
  const pageTitle = canSyncBookmarkTitleFromTab(tab)
    ? tabPageTitle(tab.title, url, leftDomain ? undefined : existing, namingBookmark)
    : url;
  const title = tabBackingBookmarkTitle(
    pageTitle,
    tab.index,
    backingToken,
    spaceId,
    existing && leftDomain ? tabBackingTitleLeavingDomain(existing.title) : existing?.title,
    { windowId: tab.windowId, installationId: localInstallationId },
  );
  if (existing) {
    if (!(await backingHasCanonicalLocation(existing, spaceId))) {
      existing = await browser.bookmarks.move(existing.id, { parentId: tabsFolder.id });
    }
    if (existing.title !== title || existing.url !== url) {
      await browser.bookmarks.update(existing.id, { title, url });
    }
  } else {
    const place = await placeNewBacking?.();
    const anchor = place ? await tabTreePlace(place, spaceId) : undefined;
    existing = await browser.bookmarks.create({
      parentId: anchor?.parentId ?? tabsFolder.id,
      ...(anchor ? { index: anchor.index } : {}),
      title,
      url,
    });
  }
  return {
    backingId: existing.id,
    backingToken,
    spaceId,
    windowId: tab.windowId,
    url,
  };
}

/** Names a backing, or with a blank title returns it to its page's own title. */
export async function renameTabBackingBookmark(
  backingId: string,
  title: string,
  expected?: Pick<TabBackingLocation, 'backingToken' | 'spaceId' | 'windowId'>,
  pageTitleFallback = '',
): Promise<Browser.bookmarks.BookmarkTreeNode> {
  const nextTitle = title.trim();
  const backing = await bookmarkById(backingId);
  if (
    !backing ||
    !expected ||
    !tabBackingMatchesLocation(backing, { backingId, ...expected }) ||
    !(await backingHasLocalCanonicalLocation(backing, expected.spaceId, expected.windowId))
  ) {
    throw new Error('This tab backing no longer exists.');
  }
  return browser.bookmarks.update(backing.id, {
    title: nextTitle
      ? tabBackingTitleWithName(backing, nextTitle)
      : tabBackingTitleWithoutName(backing, pageTitleFallback || backing.url || ''),
  });
}

export function tabBackingMatchesLocation(
  backing: Browser.bookmarks.BookmarkTreeNode,
  location: Pick<TabBackingLocation, 'backingId'> &
    Partial<Pick<TabBackingLocation, 'backingToken' | 'spaceId'>>,
): boolean {
  return backing.id === location.backingId &&
    isTabBackingBookmark(backing) &&
    (!location.backingToken || tabBackingToken(backing) === location.backingToken) &&
    (!location.spaceId || tabBackingSpaceId(backing) === location.spaceId);
}

export async function removeTabBackingBookmark(
  location: TabBackingLocation | undefined,
): Promise<void> {
  if (!location) return;
  if (location.backingId) {
    const backing = await bookmarkById(location.backingId);
    if (
      !backing ||
      !tabBackingMatchesLocation(backing, location) ||
      !(await backingHasLocalCanonicalLocation(backing, location.spaceId, location.windowId))
    ) return;
    try {
      await browser.bookmarks.remove(location.backingId);
    } catch (error) {
      let tree: Browser.bookmarks.BookmarkTreeNode[];
      try {
        tree = await browser.bookmarks.getTree();
      } catch {
        throw error;
      }
      const containsExactId = (nodes: Browser.bookmarks.BookmarkTreeNode[]): boolean =>
        nodes.some((node) => node.id === location.backingId ||
          containsExactId(node.children ?? []));
      if (containsExactId(tree)) throw error;
    }
    return;
  }
  const identity = pageIdentity(location.url);
  if (!identity) return;
  const localInstallationId = await installationId();
  const tabsFolders = await findSpaceTabsFolders(location.spaceId).catch(() => []);
  const children = await backingsIn(tabsFolders);
  const match = children.find((node) =>
    tabBackingInstallationId(node) === localInstallationId &&
    (location.windowId === undefined || tabBackingWindowId(node) === location.windowId) && (
      tabBackingToken(node) === location.backingToken ||
      (!location.backingToken && pageIdentity(node.url) === identity)
    ));
  if (match) await browser.bookmarks.remove(match.id);
}