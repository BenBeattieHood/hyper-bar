import {
  copyBookmark,
  createBookmarkFolder,
  createBookmarkFromTab,
  createSpace,
  openFavourite,
  updateBookmarkUrl,
  type BookmarkCreateDetails,
  type OpenTabInSpaceOptions,
  type OpenTabInSpaceResult,
} from './bookmarkOperations';
import {
  ensureSpaceBookmarksFolder,
  ensureSpaceTabsFolder,
  removeProvisionalBookmarkFolder,
} from './bookmarkStorage';
import { recreateTrees, snapshotTrees, treeIds, undoMessageText, undoSeries } from './bookmarkUndo';
import { isTabBackingBookmark } from './bookmarks';
import type { ModelTabTitles } from './model';
import type { HyperActionKind } from './modelActions';
import { intentHandler, runEachItem, type HyperIntentHandlers } from './modelIntents';
import {
  parseCopyBookmarkItems,
  parseCreateBookmarkFolderPayload,
  parseCreateBookmarkItems,
  parseCreateSpacePayload,
  parseDeleteBookmarkItems,
  parseOpenFavouritePayload,
  parseUpdateBookmarkUrlPayload,
} from './modelIntentPayloads';
import {
  bookmarkTarget,
  spaceTarget,
  tabTarget,
  windowTarget,
} from './modelGuards';
import { loadTabSpaceIds } from './tabOwnership';
import { tabById } from './tabs';
import { goToNewSpace, type WindowSpaceChoice } from './windowSpaceChoice';
import { getWindowActiveSpaceId } from './windowState';
import type { TimedMessages } from './timedMessages';
import { tabUrl, urlsShareDomain } from './urlIdentity';

type BookmarkIntentKind = Extract<HyperActionKind,
  | 'copyBookmark'
  | 'createBookmark'
  | 'createBookmarkFolder'
  | 'createSpace'
  | 'deleteBookmark'
  | 'openFavourite'
  | 'updateBookmarkUrl'
>;

export interface BookmarkIntentHandlerDependencies {
  linkTabToBookmark(tabId: number, bookmarkId: string): Promise<void>;
  messages: Pick<TimedMessages, 'offer'>;
  openTabInSpace(options: OpenTabInSpaceOptions): Promise<OpenTabInSpaceResult>;
  queueMutation<Result>(operation: () => Promise<Result>): Promise<Result>;
  setFavouriteSlot(bookmarkId: string, slotIndex: number, windowId: number): Promise<void>;
  tabTitles(tabId: number, url: string): ModelTabTitles;
  /** Each tab linked to one of these bookmarks, with the bookmark it is linked to. */
  tabsLinkedTo(bookmarkIds: ReadonlySet<string>): ReadonlyMap<number, string>;
  /** Read when a handler runs: the background builds the handlers before its window choice. */
  windowSpaces(): Pick<WindowSpaceChoice, 'select' | 'showNewSpace'>;
}

/**
 * Browser APIs stay on the background side of this factory. The caller injects
 * its serial lane and tab-routing operation because those are worker-local.
 */
export function createBookmarkIntentHandlers(
  dependencies: BookmarkIntentHandlerDependencies,
): Pick<HyperIntentHandlers, BookmarkIntentKind> {
  /**
   * Points tabs that were linked to deleted bookmarks at their recreated
   * copies, unless a tab has since left its bookmark's domain.
   */
  const relinkTabs = async (
    linked: ReadonlyMap<number, string>,
    recreated: ReadonlyMap<string, Browser.bookmarks.BookmarkTreeNode>,
  ) => {
    for (const [tabId, bookmarkId] of linked) {
      const copy = recreated.get(bookmarkId);
      const tab = copy?.url ? await tabById(tabId) : undefined;
      if (copy && tab && urlsShareDomain(copy.url, tabUrl(tab))) {
        await dependencies.linkTabToBookmark(tabId, copy.id);
      }
    }
  };
  const bookmarkEffects = {
    createBookmark: (details: BookmarkCreateDetails) => browser.bookmarks.create(details),
    getBookmark: async (bookmarkId: string) => (await browser.bookmarks.get(bookmarkId))[0],
    getBookmarkChildren: (parentId: string) => browser.bookmarks.getChildren(parentId),
  };
  return {
    copyBookmark: intentHandler({
      parse: parseCopyBookmarkItems,
      run: (copies, client) => dependencies.queueMutation(() => runEachItem(copies, async (payload) => {
        const copy = await copyBookmark(payload, bookmarkEffects);
        if (!copy || payload.favouriteSlot === undefined) return copy;
        try {
          await dependencies.setFavouriteSlot(copy.id, payload.favouriteSlot, client.windowId);
        } catch (error) {
          // A copy that could not take its slot would be a stray bookmark the user never asked for.
          await browser.bookmarks.remove(copy.id).catch(() => undefined);
          throw error;
        }
        return copy;
      })),
      targets: (copies) => copies.items.flatMap((payload) => [
        bookmarkTarget(payload.bookmarkId),
        bookmarkTarget(payload.parentId),
      ]),
    }),
    createBookmark: intentHandler({
      parse: parseCreateBookmarkItems,
      run: (bookmarks, client) => dependencies.queueMutation(() => {
        // Indexes are the places the items take if every one is created; a tab
        // already bookmarked there takes none, so the items after it close up.
        const skippedByParent = new Map<string, number>();
        return runEachItem(bookmarks, async (payload) => {
          const skipped = skippedByParent.get(payload.parentId) ?? 0;
          const result = await createBookmarkFromTab(
            payload.index === undefined ? payload : { ...payload, index: payload.index - skipped },
            client.windowId,
            {
              ...bookmarkEffects,
              extensionOrigin: browser.runtime.getURL(''),
              getActiveTab: async (windowId) => (
                await browser.tabs.query({ active: true, windowId })
              )[0],
              getTab: (tabId) => browser.tabs.get(tabId),
              linkTabToBookmark: dependencies.linkTabToBookmark,
              tabTitles: dependencies.tabTitles,
            },
          );
          if (!result.created) skippedByParent.set(payload.parentId, skipped + 1);
          if (payload.favouriteSlot !== undefined) {
            await dependencies.setFavouriteSlot(result.node.id, payload.favouriteSlot, client.windowId);
          }
          return result;
        });
      }),
      targets: (bookmarks, client) => bookmarks.items.flatMap((payload) => [
        bookmarkTarget(payload.parentId),
        ...(payload.tabId === undefined
          ? [windowTarget(client.windowId)]
          : [tabTarget(payload.tabId)]),
      ]),
    }),
    createBookmarkFolder: intentHandler({
      parse: parseCreateBookmarkFolderPayload,
      run: (payload) => dependencies.queueMutation(() => createBookmarkFolder(payload.parentId, bookmarkEffects)),
      targets: (payload) => [bookmarkTarget(payload.parentId)],
    }),
    createSpace: intentHandler({
      parse: parseCreateSpacePayload,
      run: async (payload, client) => {
        const space = await dependencies.queueMutation(() => createSpace(payload.spacesFolderId, {
          createBookmark: bookmarkEffects.createBookmark,
          ensureSpaceBookmarksFolder,
          ensureSpaceTabsFolder,
          removeBookmarkTree: (bookmarkId) => browser.bookmarks.removeTree(bookmarkId),
        }));
        await goToNewSpace(dependencies.windowSpaces(), space.id, client, 'Unable to show the new space.');
        return space;
      },
      targets: (payload, client) => [
        bookmarkTarget(payload.spacesFolderId),
        windowTarget(client.windowId),
      ],
    }),
    deleteBookmark: intentHandler({
      parse: parseDeleteBookmarkItems,
      run: (deletions, client) => dependencies.queueMutation(async () => {
        // A provisional folder is a creation being cancelled, which has nothing to undo.
        const deleted = await snapshotTrees(deletions.items.flatMap(
          ({ bookmarkId, expectedProvisionalTitle }) => expectedProvisionalTitle === undefined ? [bookmarkId] : [],
        ));
        const linked = dependencies.tabsLinkedTo(treeIds(deleted));
        const result = await runEachItem(
          deletions,
          async ({ bookmarkId, expectedProvisionalTitle }) => {
            if (expectedProvisionalTitle !== undefined) {
              return removeProvisionalBookmarkFolder(bookmarkId, expectedProvisionalTitle);
            }
            const [node] = await browser.bookmarks.get(bookmarkId);
            if (!node) throw new Error('This bookmark no longer exists.');
            if (node.url) await browser.bookmarks.remove(bookmarkId);
            else await browser.bookmarks.removeTree(bookmarkId);
            return undefined;
          },
        );
        if (deleted.length > 0) {
          // Another session's tabs are closed from the tab list, so their message says so.
          const tabs = deleted.every(isTabBackingBookmark);
          dependencies.messages.offer(client.windowId, {
            act: (remade) => dependencies.queueMutation(async () => {
              const recreated = await recreateTrees(deleted, remade);
              await relinkTabs(linked, recreated);
            }),
            kind: 'undo',
            series: deletions.items.every((item) => item.unpin)
              ? undoSeries('unpinned', 'Unpinned', deleted)
              : tabs ? undoSeries('closed-session-tabs', 'Closed', deleted) : undoSeries('deleted', 'Deleted', deleted),
            ...(deletions.items.every((item) => item.unpin)
              ? { text: deleted.length === 1 ? 'Item unpinned' : `Unpinned ${deleted.length} items` }
              : tabs
                ? undoMessageText('Closed', deleted, { folder: 'folder', leaf: 'tab' })
                : undoMessageText('Deleted', deleted, { folder: 'folder', leaf: 'bookmark' })),
          });
        }
        return result;
      }),
      targets: (deletions) => deletions.items.map(({ bookmarkId }) => bookmarkTarget(bookmarkId)),
    }),
    openFavourite: intentHandler({
      parse: parseOpenFavouritePayload,
      run: (payload, client) => dependencies.queueMutation(() => openFavourite(
        payload,
        client.windowId,
        {
          getBookmarkTree: () => browser.bookmarks.getTree(),
          getTabSpaceIds: loadTabSpaceIds,
          getTabs: () => browser.tabs.query({}),
          getWindowActiveSpaceId,
          getWindowIncognito: async (windowId) => (
            await browser.windows.get(windowId)
          ).incognito ?? false,
          openTabInSpace: dependencies.openTabInSpace,
        },
      )),
      targets: (payload, client) => [
        windowTarget(client.windowId),
        ...(payload.activeSpaceId ? [spaceTarget(payload.activeSpaceId)] : []),
      ],
    }),
    updateBookmarkUrl: intentHandler({
      parse: parseUpdateBookmarkUrlPayload,
      run: (payload) => dependencies.queueMutation(() => updateBookmarkUrl(payload, {
        getBookmark: bookmarkEffects.getBookmark,
        updateBookmarkUrl: (bookmarkId, url) => browser.bookmarks.update(bookmarkId, { url }),
      })),
      targets: (payload) => [bookmarkTarget(payload.bookmarkId)],
    }),
  };
}