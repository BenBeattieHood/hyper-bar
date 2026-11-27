import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { WorkspaceTransitionKind } from '../components/WorkspaceMotion';
import { detectSidebarSide, type SidebarSide } from '../lib/sidebarPlacement';
import { useHoldTimer } from './useHoldTimer';
import { listen } from '../lib/listen';

export const WIDE_WORKSPACE_WIDTH = 720;
/** Matches `sidepanel/style.css`, which hides the Tabs and Bookmarks lists below this width. */
export const LISTS_HIDDEN_WIDTH = 150;
/** Match `sidepanel/style.css`, which hides the Search and Settings buttons below these widths. */
const SEARCH_BUTTON_HIDDEN_WIDTH = 225;
const SETTINGS_BUTTON_HIDDEN_WIDTH = 190;

export function useWorkspaceLayout({ dragging, shellRef }: {
  dragging(): boolean;
  shellRef: RefObject<HTMLElement | null>;
}) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [listsHidden, setListsHidden] = useState(false);
  const [bookmarksOpen, setBookmarksOpen] = useState(false);
  const [wideWorkspace, setWideWorkspace] = useState(false);
  const [sidebarSide, setSidebarSide] = useState<SidebarSide>('right');
  const bookmarksOpenRef = useRef(false);
  const viewSwitch = useHoldTimer<'tabs' | 'bookmarks'>(500);
  const clearViewSwitchTimer = viewSwitch.disarm;
  const [workspaceTransitionKind, setWorkspaceTransitionKind] =
    useState<WorkspaceTransitionKind>('space');
  const openBookmarks = () => {
    setWorkspaceTransitionKind('view');
    bookmarksOpenRef.current = true;
    setBookmarksOpen(true);
  };
  const closeBookmarks = () => {
    clearViewSwitchTimer();
    setWorkspaceTransitionKind('view');
    bookmarksOpenRef.current = false;
    setBookmarksOpen(false);
  };

  const armWorkspaceView = (nextView: 'tabs' | 'bookmarks') => {
    if (wideWorkspace) {
      clearViewSwitchTimer();
      return;
    }
    const currentView = bookmarksOpenRef.current ? 'bookmarks' : 'tabs';
    if (!dragging() || nextView === currentView) {
      clearViewSwitchTimer();
      return;
    }
    viewSwitch.arm(nextView, nextView, () => {
      setWorkspaceTransitionKind('view');
      bookmarksOpenRef.current = nextView === 'bookmarks';
      setBookmarksOpen(nextView === 'bookmarks');
    });
  };

  useLayoutEffect(() => {
    const shell = shellRef.current;
    if (!shell) return;
    const update = () => {
      const width = shell.getBoundingClientRect().width;
      setListsHidden(width < LISTS_HIDDEN_WIDTH);
      setWideWorkspace(width >= WIDE_WORKSPACE_WIDTH);
      if (width >= WIDE_WORKSPACE_WIDTH) clearViewSwitchTimer();
      if (width < SEARCH_BUTTON_HIDDEN_WIDTH) setSearchOpen(false);
      if (width < SETTINGS_BUTTON_HIDDEN_WIDTH) setSettingsOpen(false);
    };
    const observer = new ResizeObserver(update);
    observer.observe(shell);
    update();
    return () => observer.disconnect();
  }, [clearViewSwitchTimer, shellRef]);

  useEffect(() => {
    let latestRequest = 0;
    let cancelled = false;
    const updateSidebarSide = () => {
      const request = ++latestRequest;
      void detectSidebarSide().then((side) => {
        if (!cancelled && request === latestRequest) setSidebarSide(side);
      });
    };
    const updateVisibleSidebarSide = () => {
      if (!document.hidden) updateSidebarSide();
    };

    updateSidebarSide();
    const unlisten = listen(
      [window, 'focus', updateSidebarSide],
      [window, 'resize', updateSidebarSide],
      [document, 'visibilitychange', updateVisibleSidebarSide],
    );
    return () => {
      cancelled = true;
      unlisten();
    };
  }, []);

  return {
    armWorkspaceView,
    bookmarksOpen,
    bookmarksOpenRef,
    clearViewSwitchTimer,
    closeBookmarks,
    dragArmingView: viewSwitch.armed,
    listsHidden,
    openBookmarks,
    searchOpen,
    setBookmarksOpen,
    setSearchOpen,
    setSettingsOpen,
    setWorkspaceTransitionKind,
    settingsOpen,
    sidebarSide,
    wideWorkspace,
    workspaceTransitionKind,
  };
}
