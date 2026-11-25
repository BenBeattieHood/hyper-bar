import type { OpenTabInSpaceOptions, OpenTabInSpaceResult } from './bookmarkOperations';
import { bookmarkStepIndex } from './bookmarks';
import {
  bookmarkById,
  createTabFolder,
  existingBookmarks,
  moveTabTreeNodes,
  removeTabFolder,
  renameTabFolder,
  saveHyperPreferences,
} from './bookmarkStorage';
import { setFavouriteSlot } from './favouriteStorage';
import {
  restorePlacements,
  restoreTabFolder,
  snapshotPlacements,
  tabTreeSpaceId,
  undoMessageText,
  undoSeries,
} from './bookmarkUndo';
import type { HyperActionKind } from './modelActions';
import { bookmarkTarget, spaceTarget, tabTarget, windowTarget } from './modelGuards';
import { intentHandler, runEachItem, type HyperIntentHandlers } from './modelIntents';
import {
  optionalString,
  parseDeleteSpacePayload,
  parseMoveBookmarkItems,
  parseOpenBookmarkItems,
  parseSelectSpacePayload,
  parseSetTabFolderItems,
  requireNumber,
  requireString,
  requireTitle,
  setTabFolderTargets,
  type DeleteSpacePayload,
  type MoveBookmarkPayload,
} from './modelIntentPayloads';
import { parsePreferencePayload } from './preferences';
import type { WindowSpaceChoice } from './windowSpaceChoice';
import type { TimedMessages } from './timedMessages';
import { getTabOwnership } from './tabOwnership';

type WorkspaceIntentKind = Extract<HyperActionKind,
  | 'deleteSpace'
  | 'duplicateTab'
  | 'importBookmarkFolder'
  | 'moveBookmark'
  | 'openBookmark'
  | 'renameBookmark'
  | 'renameTab'
  | 'selectSpace'
  | 'setFavourite'
  | 'setPreference'
  | 'setTabFolder'
>;

export interface WorkspaceIntentHandlerDependencies {
  deleteSpace(payload: DeleteSpacePayload, windowId: number): Promise<unknown>;
  duplicateTab(tabId: number): Promise<void>;
  importBookmarkFolder(sourceFolderId: string, destinationParentId: string): Promise<unknown>;
  messages: Pick<TimedMessages, 'offer'>;
  openTabInSpace(options: OpenTabInSpaceOptions): Promise<OpenTabInSpaceResult>;
  queueMutation<Result>(operation: () => Promise<Result>): Promise<Result>;
  releaseDepartingBackings(backingIds: Iterable<string>): Promise<void>;
  renameBookmark(bookmarkId: string, title: string, url?: string): Promise<void>;
  renameTab(tabId: number, backingId: string, title: string): Promise<void>;
  /** Read when a handler runs: the background builds the handlers before its window choice. */
  windowSpaces(): Pick<WindowSpaceChoice, 'beforePage' | 'select' | 'switchTo'>;
}

export function createWorkspaceIntentHandlers(
  dependencies: WorkspaceIntentHandlerDependencies,
): Pick<HyperIntentHandlers, WorkspaceIntentKind> {
  const queueMutation = dependencies.queueMutation;
  /** Where a move goes; a step already at its end goes nowhere. */
  const moveDestination = async (
    move: MoveBookmarkPayload,
  ): Promise<{ index?: number; parentId?: string } | undefined> => {
    if (move.offset === undefined) return { index: move.index, parentId: move.parentId };
    const parentId = (await bookmarkById(move.bookmarkId))?.parentId;
    if (!parentId) return undefined;
    const index = bookmarkStepIndex(await browser.bookmarks.getChildren(parentId), move.bookmarkId, move.offset);
    return index === undefined ? undefined : { index, parentId };
  };
  const offerUndoMove = (
    windowId: number,
    placements: Awaited<ReturnType<typeof snapshotPlacements>>,
    moved: readonly Browser.bookmarks.BookmarkTreeNode[],
    leaf: string,
  ) => {
    if (placements.parents.size === 0) return;
    dependencies.messages.offer(windowId, {
      act: (remade) => queueMutation(() => restorePlacements(placements, remade)),
      kind: 'undo',
      series: undoSeries(`moved-${leaf}s`, 'Moved', moved),
      ...undoMessageText('Moved', moved, { folder: 'folder', leaf }),
    });
  };
  /** Closed tabs come back in the background, each with a backing the folder takes back. */
  const offerUndoFolderRemoval = (
    windowId: number,
    spaceId: string,
    tree: Browser.bookmarks.BookmarkTreeNode,
  ) => {
    dependencies.messages.offer(windowId, {
      act: (remade) => queueMutation(() => restoreTabFolder(tree, async (url) => {
        const { tab } = await dependencies.openTabInSpace({
          active: false,
          destinationSpaceId: spaceId,
          forceNew: true,
          reuse: 'window',
          url,
          windowId,
        });
        return tab.id === undefined ? undefined : (await getTabOwnership(tab.id))?.backingId;
      }, remade)),
      kind: 'undo',
      series: undoSeries('removed-folders', 'Removed', [tree], 'folders'),
      ...undoMessageText('Removed', [tree], { folder: 'folder', leaf: 'folder' }),
    });
  };
  return {
    deleteSpace: intentHandler({
      parse: parseDeleteSpacePayload,
      run: (payload, client) => queueMutation(() => dependencies.deleteSpace(payload, client.windowId)),
      targets: (payload, client) => [spaceTarget(payload.spaceId), windowTarget(client.windowId)],
    }),
    duplicateTab: intentHandler({
      parse: (payload) => requireNumber(payload, 'tabId'),
      run: (tabId) => queueMutation(() => dependencies.duplicateTab(tabId)),
      targets: (tabId, client) => [tabTarget(tabId), windowTarget(client.windowId)],
    }),
    importBookmarkFolder: intentHandler({
      parse: (payload) => ({
        destinationParentId: requireString(payload, 'destinationParentId'),
        sourceFolderId: requireString(payload, 'sourceFolderId'),
      }),
      run: (payload) => dependencies.importBookmarkFolder(
        payload.sourceFolderId,
        payload.destinationParentId,
      ),
      targets: (payload) => [
        bookmarkTarget(payload.destinationParentId),
        bookmarkTarget(payload.sourceFolderId),
      ],
    }),
    moveBookmark: intentHandler({
      parse: parseMoveBookmarkItems,
      // Queued with the background's other bookmark work, so a step reads the siblings as they are when it runs.
      run: (moves, client) => queueMutation(async () => {
        const ids = moves.items.map((move) => move.bookmarkId);
        const placements = await snapshotPlacements(ids);
        const moved = await existingBookmarks(ids);
        let changed = false;
        const result = await runEachItem(moves, async (move) => {
          const destination = await moveDestination(move);
          if (!destination) return bookmarkById(move.bookmarkId);
          changed = true;
          return browser.bookmarks.move(move.bookmarkId, destination);
        });
        if (changed) offerUndoMove(client.windowId, placements, moved, 'bookmark');
        return result;
      }),
      targets: (moves) => moves.items.flatMap((move) => [
        bookmarkTarget(move.bookmarkId),
        ...(move.parentId ? [bookmarkTarget(move.parentId)] : []),
      ]),
    }),
    openBookmark: intentHandler({
      admit: (pages, client) => pages.items.forEach(
        (page) => dependencies.windowSpaces().beforePage(page, client).admit(),
      ),
      parse: parseOpenBookmarkItems,
      run: (pages, client) => queueMutation(() => runEachItem(pages, async (page) => {
        await dependencies.windowSpaces().beforePage(page, client).run();
        return (await dependencies.openTabInSpace({ ...page, windowId: client.windowId })).tab;
      })),
      targets: (pages, client) => [
        ...pages.items.flatMap((page) => page.destinationSpaceId
          ? [spaceTarget(page.destinationSpaceId)]
          : []),
        windowTarget(client.windowId),
      ],
    }),
    renameBookmark: intentHandler({
      parse: (payload) => ({
        bookmarkId: requireString(payload, 'bookmarkId'),
        title: requireTitle(payload, 'title'),
        url: optionalString(payload, 'url'),
      }),
      run: (payload) => queueMutation(
        () => dependencies.renameBookmark(payload.bookmarkId, payload.title, payload.url),
      ),
      targets: (payload) => [bookmarkTarget(payload.bookmarkId)],
    }),
    renameTab: intentHandler({
      parse: (payload) => ({
        backingId: requireString(payload, 'backingId'),
        tabId: requireNumber(payload, 'tabId'),
        title: requireTitle(payload, 'title'),
      }),
      run: (payload) => queueMutation(() => dependencies.renameTab(
        payload.tabId,
        payload.backingId,
        payload.title,
      )),
      targets: (payload) => [
        bookmarkTarget(payload.backingId),
        tabTarget(payload.tabId),
      ],
    }),
    selectSpace: intentHandler({
      // The port issues the window: from sender.tab where the browser supplies
      // it, and for a side panel from a claim bounded by single occupancy. The
      // intent body never names a window, so it cannot target another one.
      admit: ({ spaceId }, client) => dependencies.windowSpaces().select(spaceId, client),
      parse: parseSelectSpacePayload,
      run: ({ spaceId }, client) => dependencies.windowSpaces().switchTo(spaceId, client),
      targets: (payload, client) => [
        spaceTarget(payload.spaceId),
        windowTarget(client.windowId),
      ],
    }),
    setFavourite: intentHandler({
      parse: (payload) => ({
        bookmarkId: requireString(payload, 'bookmarkId'),
        slotIndex: requireNumber(payload, 'slotIndex'),
      }),
      run: (payload, client) => queueMutation(
        () => setFavouriteSlot(payload.bookmarkId, payload.slotIndex, client.windowId),
      ),
      targets: (payload) => [bookmarkTarget(payload.bookmarkId)],
    }),
    setPreference: intentHandler({ parse: parsePreferencePayload, run: saveHyperPreferences, targets: () => [] }),
    setTabFolder: intentHandler({
      parse: parseSetTabFolderItems,
      // Create answers with the node: the caller opens it for renaming, and
      // the result rides the revision that already contains it.
      run: (operations, client) => queueMutation(() => runEachItem(operations, async (payload) => {
        if (payload.operation === 'create') {
          return createTabFolder(payload.spaceId, payload.parentId, payload.title);
        }
        if (payload.operation === 'move') {
          const placements = await snapshotPlacements(payload.nodeIds);
          const moved = await existingBookmarks(payload.nodeIds);
          await dependencies.releaseDepartingBackings(payload.nodeIds);
          await moveTabTreeNodes(payload.spaceId, payload.nodeIds, {
            parentId: payload.parentId,
            ...(payload.index === undefined ? {} : { index: payload.index }),
          });
          offerUndoMove(client.windowId, placements, moved, 'tab');
          return undefined;
        }
        if (payload.operation === 'remove') {
          if (!payload.withTabs) return removeTabFolder(payload.folderId);
          const [tree] = await browser.bookmarks.getSubTree(payload.folderId).catch(() => []);
          const spaceId = await tabTreeSpaceId(payload.folderId);
          await removeTabFolder(payload.folderId, client.windowId);
          if (tree && spaceId) offerUndoFolderRemoval(client.windowId, spaceId, tree);
          return undefined;
        }
        return renameTabFolder(payload.folderId, payload.title);
      })),
      targets: (operations) => operations.items.flatMap(setTabFolderTargets),
    }),
  };
}
