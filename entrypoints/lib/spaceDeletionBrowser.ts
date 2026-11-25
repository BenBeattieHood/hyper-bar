import {
  isSpaceBookmarksFolder,
  isSpaceTabsFolder,
  visibleBookmarkTitle,
  type BookmarkNode,
} from './bookmarks';
import { bookmarkById } from './bookmarkStorage';
import type {
  ProvisionalSpaceInfrastructureDependencies,
  SpaceBookmarkMoveDependencies,
  SpaceDeletionVerificationDependencies,
  SpaceGroupCleanupDependencies,
} from './spaceDeletion';
import { sessionStorageArea } from './sessionValues';

export interface SpaceDeletionBrowserPort extends
  ProvisionalSpaceInfrastructureDependencies,
  SpaceBookmarkMoveDependencies,
  Pick<SpaceDeletionVerificationDependencies,
    'getBookmarkTree' | 'listTabs' | 'readSession'>,
  Pick<SpaceGroupCleanupDependencies, 'removeSessionKeys' | 'ungroup'> {}

/** Browser-facing port for deletion policy; all policy stays in spaceDeletion. */
export function createSpaceDeletionBrowserPort(): SpaceDeletionBrowserPort {
  const session = sessionStorageArea();
  const tabs = browser.tabs as typeof browser.tabs & {
    ungroup?: (tabIds: number[]) => Promise<void>;
  };
  return {
    createBookmarkFolder: (parentId, title) => browser.bookmarks.create({ parentId, title }),
    getBookmark: bookmarkById,
    getBookmarkChildren: (parentId) => browser.bookmarks.getChildren(parentId)
      .catch(() => []),
    getBookmarkTree: () => browser.bookmarks.getTree(),
    isInfrastructureFolder: (node: BookmarkNode) =>
      isSpaceTabsFolder(node) || isSpaceBookmarksFolder(node),
    listTabs: () => browser.tabs.query({}),
    moveBookmark: (bookmarkId, parentId) => browser.bookmarks.move(bookmarkId, { parentId }),
    readSession: async () =>
      await session?.get(null).catch((): Record<string, unknown> => ({})) ?? {},
    removeSessionKeys: async (keys) => { await session?.remove([...keys]); },
    ungroup: tabs.ungroup === undefined
      ? undefined
      : (tabIds) => tabs.ungroup!([...tabIds]),
    visibleTitle: visibleBookmarkTitle,
  };
}