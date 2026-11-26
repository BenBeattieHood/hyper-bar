import { useEffect, useRef, type Dispatch, type SetStateAction } from 'react';
import type { Space } from '../../lib/bookmarks';
import { expandFolders } from '../lib/folderReveal';

const BOOKMARK_FOLDER_IDLE_COLLAPSE_MS = 5 * 60 * 1000;

export function useFolderCollapse({
  activeSpace,
  bookmarkFolderIdList,
  bookmarksPaneVisible,
  bookmarksRootId,
  bookmarksVisible,
  isLoading,
  openBookmarkFolderIds,
  openTabFolderIds,
  setCollapsedIds,
  tabFoldersPending,
  tabsPaneVisible,
}: {
  activeSpace: Space | undefined;
  bookmarkFolderIdList: string[];
  bookmarksPaneVisible: boolean;
  bookmarksRootId: string | undefined;
  bookmarksVisible: boolean;
  isLoading: boolean;
  openBookmarkFolderIds: string[];
  openTabFolderIds: string[];
  setCollapsedIds: Dispatch<SetStateAction<Set<string>>>;
  tabFoldersPending: boolean;
  tabsPaneVisible: boolean;
}) {
  const initialCollapsedBookmarkRoot = useRef<string | undefined>(undefined);
  const bookmarkFolderIdsRef = useRef<string[]>([]);
  const bookmarksHiddenLongEnoughRef = useRef(false);
  const paneRevealSpaceIdRef = useRef<string | undefined>(undefined);
  const revealedPanesRef = useRef<Set<'tabs' | 'bookmarks'>>(new Set());
  const bookmarkFolderKey = bookmarkFolderIdList.join(',');
  bookmarkFolderIdsRef.current = bookmarkFolderIdList;

  useEffect(() => {
    if (
      isLoading ||
      !bookmarksRootId ||
      initialCollapsedBookmarkRoot.current === bookmarksRootId
    ) return;
    initialCollapsedBookmarkRoot.current = bookmarksRootId;
    setCollapsedIds(new Set(bookmarkFolderIdList));
  }, [bookmarkFolderKey, bookmarksRootId, isLoading]);

  useEffect(() => {
    if (!activeSpace || isLoading) return;
    if (paneRevealSpaceIdRef.current !== activeSpace.id) {
      paneRevealSpaceIdRef.current = activeSpace.id;
      revealedPanesRef.current = new Set();
    }

    const panes = [
      ['tabs', tabsPaneVisible && !tabFoldersPending, openTabFolderIds],
      ['bookmarks', bookmarksPaneVisible, openBookmarkFolderIds],
    ] as const;
    const folderIds = panes.flatMap(([pane, visible, openFolderIds]) => {
      if (!visible || revealedPanesRef.current.has(pane)) return [];
      revealedPanesRef.current.add(pane);
      return openFolderIds;
    });
    if (folderIds.length === 0) return;
    setCollapsedIds((current) => expandFolders(current, folderIds));
  }, [
    activeSpace,
    bookmarksPaneVisible,
    isLoading,
    openBookmarkFolderIds,
    openTabFolderIds,
    tabFoldersPending,
    tabsPaneVisible,
  ]);

  useEffect(() => {
    if (bookmarksVisible) {
      bookmarksHiddenLongEnoughRef.current = false;
      return;
    }
    bookmarksHiddenLongEnoughRef.current = false;
    const timer = window.setTimeout(() => {
      bookmarksHiddenLongEnoughRef.current = true;
      setCollapsedIds(new Set(bookmarkFolderIdsRef.current));
    }, BOOKMARK_FOLDER_IDLE_COLLAPSE_MS);
    return () => window.clearTimeout(timer);
  }, [bookmarksVisible]);

  useEffect(() => {
    if (bookmarksVisible || !bookmarksHiddenLongEnoughRef.current) return;
    setCollapsedIds(new Set(bookmarkFolderIdList));
  }, [bookmarkFolderKey, bookmarksVisible]);
}
