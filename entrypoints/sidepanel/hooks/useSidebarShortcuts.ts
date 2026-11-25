import { useEffect, useRef, type Dispatch, type RefObject, type SetStateAction } from 'react';
import {
  isBookmarkFolder,
  visibleBookmarkTitle,
  type BookmarkNode,
  type Space,
} from '../../lib/bookmarks';
import { userNewTabShownMessageType } from '../../lib/pageShortcut';
import {
  matchesShortcut,
  sidebarShortcutFor,
  spaceShortcutId,
  type ShortcutId,
} from '../../lib/shortcuts';
import { isInPageSidebar } from '../lib/sidebarPlacement';
import type { useBrowserState } from './useBrowserState';
import { listen } from '../lib/listen';

type BrowserStateApi = ReturnType<typeof useBrowserState>;

/** What each sidebar shortcut does; Search runs the same functions. */
export type SidebarShortcutActions = Partial<Record<ShortcutId, () => void>>;

const TEXT_FIELD = 'input, textarea, [contenteditable="true"]';

function focusedBookmark(nodeMap: ReadonlyMap<string, BookmarkNode>): BookmarkNode | undefined {
  const focusedNodeId = (document.activeElement as HTMLElement | null)
    ?.closest<HTMLElement>('[data-bookmark-node-id]')
    ?.getAttribute('data-bookmark-node-id');
  return focusedNodeId ? nodeMap.get(focusedNodeId) : undefined;
}

/** Opens the recent tabs menu on show, as a click on its button would. */
function openRecentTabsMenu() {
  const trigger = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-shortcut="recentTabs"]'))
    .find((button) => !button.disabled && button.checkVisibility?.() !== false);
  trigger?.focus();
  trigger?.click();
}

export function useSidebarShortcuts(options: {
  activeSpace: Space | undefined;
  /** The header's create buttons are disabled, so their keys do nothing. */
  actionsDisabled: boolean;
  addCurrentPage(parentId: string, destination: string): Promise<void>;
  bookmarksOpen: boolean;
  browserState: BrowserStateApi;
  closeBookmarks(): void;
  createFolder(parentId: string): Promise<unknown>;
  createSpace(): Promise<void>;
  createTabFolder(): Promise<unknown>;
  deleteNode(node: BookmarkNode): void;
  editingNode: BookmarkNode | undefined;
  globalPanel: { close(): void; toggle(): void };
  moveNode(node: BookmarkNode, offset: -1 | 1): void;
  nodeMap: ReadonlyMap<string, BookmarkNode>;
  openBookmarks(): void;
  renameNode(node: BookmarkNode): void;
  requireLocalRoot(): string | undefined;
  searchRef: RefObject<HTMLInputElement | null>;
  selectSpace(spaceId: string): Promise<boolean>;
  setBookmarksOpen(open: boolean): void;
  setSearchOpen(open: boolean): void;
  setSettingsOpen: Dispatch<SetStateAction<boolean>>;
  settingsOpen: boolean;
  spaces: readonly Space[];
  stepSpace(offset: number): void;
}): SidebarShortcutActions {
  const {
    activeSpace,
    browserState,
    nodeMap,
    searchRef,
    setBookmarksOpen,
    setSearchOpen,
    setSettingsOpen,
  } = options;
  const showList = (show: () => void) => {
    setSettingsOpen(false);
    options.globalPanel.close();
    show();
  };
  const actions: SidebarShortcutActions = {
    search: () => {
      setSettingsOpen(false);
      setSearchOpen(true);
      requestAnimationFrame(() => searchRef.current?.focus());
    },
    settings: () => {
      setSearchOpen(false);
      setSettingsOpen((open) => !open);
    },
    showTabs: () => showList(options.closeBookmarks),
    showBookmarks: () => showList(options.openBookmarks),
    // A focused bookmark folder takes the page; otherwise the space's bookmarks do.
    addBookmark: () => {
      const selected = focusedBookmark(nodeMap);
      const folder = selected && isBookmarkFolder(selected) ? selected : undefined;
      const parentId = folder?.id ?? options.requireLocalRoot();
      if (!parentId || !activeSpace) return;
      void options.addCurrentPage(parentId, (folder && visibleBookmarkTitle(folder)) || activeSpace.title);
    },
    addFavourite: () => {
      if (browserState.favouritesFolderId) void options.addCurrentPage(browserState.favouritesFolderId, 'favourites');
    },
    createTabFolder: () => {
      if (options.actionsDisabled) return;
      showList(options.closeBookmarks);
      void options.createTabFolder();
    },
    createBookmarkFolder: () => {
      const rootId = options.actionsDisabled ? undefined : options.requireLocalRoot();
      if (!rootId) return;
      showList(options.openBookmarks);
      void options.createFolder(rootId);
    },
    recentTabs: openRecentTabsMenu,
    globalBookmarks: () => {
      setSettingsOpen(false);
      options.globalPanel.toggle();
    },
    newSpace: () => void options.createSpace(),
    previousSpace: () => options.stepSpace(-1),
    nextSpace: () => options.stepSpace(1),
    ...Object.fromEntries(options.spaces.flatMap((space, index) => {
      const id = spaceShortcutId(index);
      return id ? [[id, () => void options.selectSpace(space.id)]] : [];
    })),
  };
  const latest = useRef({ actions, options });
  latest.current = { actions, options };
  useEffect(() => {
    const focusSearchInput = async (): Promise<boolean> => {
      for (let attempt = 0; attempt < 30; attempt += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        window.focus();
        const input = searchRef.current;
        input?.focus({ preventScroll: true });
        if (input && document.activeElement === input && document.hasFocus()) {
          return true;
        }
      }
      return false;
    };
    const onMessage = (message: unknown) => {
      const { type, windowId } = (message ?? {}) as { type?: unknown; windowId?: unknown };
      if (windowId !== browserState.currentWindowId) return;
      // The background alone can tell a user's new tab from Hyper's own.
      if (type === userNewTabShownMessageType) return void setSearchOpen(false);
      // The toolbar button opens the browser's sidebar, which must be the one to answer.
      if ((type !== 'hyper:show-tabs' && type !== 'hyper:show-search') || isInPageSidebar()) return;
      setSettingsOpen(false);
      const shown = (destination: 'search' | 'tabs') =>
        ({ type: 'hyper:destination-shown', destination, windowId: browserState.currentWindowId });
      if (type === 'hyper:show-search') {
        setSearchOpen(true);
        return focusSearchInput().then((focused) => focused ? shown('search') : undefined);
      }
      setSearchOpen(false);
      setBookmarksOpen(false);
      return shown('tabs');
    };
    browser.runtime.onMessage.addListener(onMessage);
    return () => browser.runtime.onMessage.removeListener(onMessage);
  }, [browserState.currentWindowId]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const { actions: run, options: current } = latest.current;
      const inTextField = (event.target as HTMLElement).matches(TEXT_FIELD);
      const commandKey = event.metaKey || event.ctrlKey;
      if (current.editingNode) {
        // The editor keeps Search shut, and the browser's Print with it.
        if (commandKey && matchesShortcut(event, 'search')) event.preventDefault();
        return;
      }
      if (event.key === 'Escape') {
        const close = current.bookmarksOpen
          ? current.closeBookmarks
          : current.settingsOpen ? () => current.setSettingsOpen(false) : undefined;
        if (!close) return;
        event.preventDefault();
        close();
        return;
      }
      const shortcut = sidebarShortcutFor(event);
      // Alt and bare keys type text, so only Command and Ctrl chords reach past a text field.
      if (shortcut && (commandKey || !inTextField)) {
        event.preventDefault();
        run[shortcut]?.();
        return;
      }
      if (inTextField) return;
      const selectedNode = focusedBookmark(current.nodeMap);
      if (!selectedNode) return;
      if (matchesShortcut(event, 'renameItem')) {
        event.preventDefault();
        current.renameNode(selectedNode);
      } else if (matchesShortcut(event, 'deleteItem')) {
        event.preventDefault();
        current.deleteNode(selectedNode);
      } else if (matchesShortcut(event, 'moveItemUp') || matchesShortcut(event, 'moveItemDown')) {
        event.preventDefault();
        current.moveNode(selectedNode, matchesShortcut(event, 'moveItemUp') ? -1 : 1);
      }
    };
    return listen([window, 'keydown', onKeyDown]);
  }, []);

  return actions;
}
