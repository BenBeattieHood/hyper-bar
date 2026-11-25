import { useRef, useState, type Dispatch, type RefObject, type SetStateAction } from 'react';
import {
  isTabFolder,
  MAX_FAVOURITES,
  visibleBookmarkTitle,
  type BookmarkNode,
  type Space,
} from '../../lib/bookmarks';
import type { BookmarkEditorProps } from '../components/BookmarkEditor';
import { openFolderPath } from '../lib/folderReveal';
import { errorMessage, type Notify } from '../lib/notify';
import type { useBrowserState } from './useBrowserState';

type BrowserStateApi = ReturnType<typeof useBrowserState>;

export function useNodeEditing({
  activeSpace,
  bookmarksRootId,
  browserState,
  clearSelectedTabs,
  favourites,
  nodeMap,
  searchTriggerRef,
  setCollapsedIds,
  setSearchOpen,
  showNotice,
  tabFoldersPending,
}: {
  activeSpace: Space | undefined;
  bookmarksRootId: string | undefined;
  browserState: BrowserStateApi;
  clearSelectedTabs(): void;
  favourites: readonly BookmarkNode[];
  nodeMap: ReadonlyMap<string, BookmarkNode>;
  searchTriggerRef: RefObject<HTMLButtonElement | null>;
  setCollapsedIds: Dispatch<SetStateAction<Set<string>>>;
  setSearchOpen(open: boolean): void;
  showNotice: Notify;
  tabFoldersPending: boolean;
}) {
  // Created nodes are held until the projection carries them; after that the editor reads the model's node.
  const [editingSnapshot, setEditingNode] = useState<Browser.bookmarks.BookmarkTreeNode>();
  const editingNode = editingSnapshot && (nodeMap.get(editingSnapshot.id) ?? editingSnapshot);
  const editorReturnFocus = useRef<HTMLElement | null>(null);
  const provisionalCreation = useRef<{
    id: string;
    kind: 'folder' | 'space' | 'tab-folder';
    parentId?: string;
    title: string;
  } | undefined>(undefined);
  /** A space copy being named, which, unlike a new space, stays when the naming is cancelled. */
  const namingCopyId = useRef<string | undefined>(undefined);

  // Folders start closed, so whatever is made in one opens it and its parents to show.
  // Every creation that names a parent reveals it here, from the toolbar or a folder's row.
  const revealFolder = (folderId: string) => setCollapsedIds((current) =>
    openFolderPath(current, folderId, (id) => nodeMap.get(id)?.parentId));

  const addCurrentPage = async (
    parentId: string,
    destination: string,
    favouriteSlotIndex?: number,
  ) => {
    try {
      if (
        parentId === browserState.favouritesFolderId &&
        favourites.length >= MAX_FAVOURITES
      ) {
        showNotice('Favourites are full', 'warning');
        return;
      }
      const result = await browserState.addCurrentPage(
        parentId,
        parentId === browserState.favouritesFolderId ? favouriteSlotIndex : undefined,
      );
      revealFolder(parentId);
      if (!result.created) {
        showNotice(
          `${visibleBookmarkTitle(result.node) || 'Current page'} is already in ${destination}`,
          'warning',
        );
      }
    } catch (error) {
      showNotice(errorMessage(error, 'The page could not be added'));
    }
  };

  const renameNode = (node: Browser.bookmarks.BookmarkTreeNode) => {
    setSearchOpen(false);
    provisionalCreation.current = undefined;
    namingCopyId.current = undefined;
    editorReturnFocus.current = document.activeElement as HTMLElement | null;
    setEditingNode(node);
  };

  /** Renames a space from its dot's menu, which has closed by now, so focus goes back to the dot. */
  const renameSpace = (spaceId: string, returnFocus: HTMLElement) => {
    const node = nodeMap.get(spaceId);
    if (!node) return;
    renameNode(node);
    editorReturnFocus.current = returnFocus;
  };

  const duplicateSpace = async (spaceId: string, withTabs: boolean, returnFocus: HTMLElement) => {
    try {
      // Duplicating takes this window to the copy, which the model shows when it lands.
      const node = await browserState.duplicateSpace(spaceId, withTabs);
      provisionalCreation.current = undefined;
      namingCopyId.current = node.id;
      editorReturnFocus.current = returnFocus;
      setEditingNode(node);
      clearSelectedTabs();
    } catch (error) {
      showNotice(errorMessage(error, 'Space could not be duplicated'));
    }
  };

  const deleteNode = (
    node: Browser.bookmarks.BookmarkTreeNode,
    options: { unpin?: boolean } = {},
  ) => {
    const authoritativeNode = nodeMap.get(node.id) ?? node;
    const nodeControls = Array.from(
      document.querySelectorAll<HTMLElement>('[data-bookmark-node-id]'),
    );
    const currentIndex = nodeControls.findIndex(
      (control) => control.dataset.bookmarkNodeId === authoritativeNode.id,
    );
    const fallbackNodeId =
      nodeControls[currentIndex + 1]?.dataset.bookmarkNodeId ??
      nodeControls[currentIndex - 1]?.dataset.bookmarkNodeId;
    void browserState.removeBookmark(authoritativeNode, options).then(() => {
      requestAnimationFrame(() => {
        const fallback = fallbackNodeId
          ? document.querySelector<HTMLElement>(
            `[data-bookmark-node-id="${CSS.escape(fallbackNodeId)}"] button:not([disabled])`,
          )
          : null;
        (fallback ?? document.querySelector<HTMLButtonElement>('.workspace-view-add'))
          ?.focus();
      });
    }).catch((error) => {
      showNotice(errorMessage(error, 'Delete failed'));
    });
  };

  /** Makes a folder and opens it for naming, its parent shown so it can be seen. */
  const createAndName = async (
    kind: 'folder' | 'tab-folder',
    create: () => Promise<BookmarkNode>,
    parentId: string | undefined,
    failure: string,
  ) => {
    editorReturnFocus.current = document.activeElement as HTMLElement | null;
    try {
      const node = await create();
      if (parentId) revealFolder(parentId);
      provisionalCreation.current = { id: node.id, kind, parentId: node.parentId, title: 'New folder' };
      setEditingNode(node);
    } catch (error) {
      showNotice(errorMessage(error, failure));
    }
  };

  const createFolder = (parentId: string) => createAndName(
    'folder',
    () => browserState.createFolder(parentId),
    parentId,
    'Folder could not be created',
  );

  const createTabFolder = async (parentId?: string) => {
    if (!activeSpace || tabFoldersPending) return;
    const spaceId = activeSpace.id;
    await createAndName(
      'tab-folder',
      () => browserState.createTabFolder(spaceId, parentId),
      parentId,
      'Tab folder could not be created',
    );
  };

  const importBookmarkFolder = async (
    sourceFolderId: string,
    destinationId = bookmarksRootId,
  ) => {
    if (!destinationId) return;
    try {
      const imported = await browserState.importBookmarkFolder(
        sourceFolderId,
        destinationId,
      );
      setCollapsedIds((current) => new Set(current).add(imported.id));
    } catch (error) {
      showNotice(errorMessage(error, 'Bookmarks could not be imported'));
    }
  };

  const createSpace = async () => {
    editorReturnFocus.current = document.activeElement as HTMLElement | null;
    try {
      // Creating a space also takes this window there; the model shows it when it lands.
      const node = await browserState.createSpace();
      provisionalCreation.current = {
        id: node.id,
        kind: 'space',
        parentId: node.parentId,
        title: 'New space',
      };
      setEditingNode(node);
      clearSelectedTabs();
    } catch (error) {
      showNotice(errorMessage(error, 'Space could not be created'));
    }
  };

  const closeEditor = () => {
    const provisional = provisionalCreation.current;
    provisionalCreation.current = undefined;
    namingCopyId.current = undefined;
    setEditingNode(undefined);
    if (provisional) {
      if (provisional.kind === 'tab-folder') {
        void browserState.removeTabFolder(provisional.id).catch(() => undefined);
        requestAnimationFrame(() => editorReturnFocus.current?.focus());
        return;
      }
      void browserState.removeBookmark({
        id: provisional.id,
        parentId: provisional.parentId,
      }, {
        expectedProvisionalTitle: provisional.title,
        isSpace: provisional.kind === 'space',
      }).catch(() => undefined);
    }
    requestAnimationFrame(() => {
      const returnTarget = editorReturnFocus.current;
      if (returnTarget?.isConnected) returnTarget.focus();
      else searchTriggerRef.current?.focus();
    });
  };

  const moveNode = (
    node: Browser.bookmarks.BookmarkTreeNode,
    offset: -1 | 1,
  ) => {
    void browserState
      .moveBookmarkByOffset(node.id, offset)
      .catch((error) => showNotice(errorMessage(error, 'Move failed')));
  };

  const editor: BookmarkEditorProps | undefined = editingNode && {
    creating: provisionalCreation.current?.id === editingNode.id ? provisionalCreation.current.kind : undefined,
    node: editingNode,
    onClose: closeEditor,
    onSave: async (title, url) => {
      if (provisionalCreation.current?.kind === 'tab-folder' || isTabFolder(editingNode)) {
        await browserState.renameTabFolder(editingNode.id, title);
      } else {
        await browserState.updateBookmark(editingNode.id, title, url);
      }
      provisionalCreation.current = undefined;
    },
    space: editingNode.parentId !== browserState.spacesFolderId
      ? undefined
      : namingCopyId.current === editingNode.id ? 'copy' : 'rename',
  };

  return {
    addCurrentPage,
    closeEditor,
    createFolder,
    createSpace,
    createTabFolder,
    deleteNode,
    duplicateSpace,
    editingNode,
    editor,
    editorReturnFocus,
    importBookmarkFolder,
    moveNode,
    provisionalCreation,
    renameNode,
    renameSpace,
    setEditingNode,
  };
}
