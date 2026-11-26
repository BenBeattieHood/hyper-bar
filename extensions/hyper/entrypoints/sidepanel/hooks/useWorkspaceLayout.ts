import { useEffect, useRef, useState } from 'react';
import type { WorkspaceTransitionKind } from '../components/WorkspaceMotion';
import { detectSidebarSide, type SidebarSide } from '../lib/sidebarPlacement';
import { useHoldTimer } from './useHoldTimer';
import { listen } from '../lib/listen';

const WIDE_WORKSPACE_QUERY = '(min-width: 720px)';
/** Matches `sidepanel/style.css`, which hides the Tabs and Bookmarks lists below this width. */
export const LISTS_HIDDEN_QUERY = '(width < 150px)';
/** Match `sidepanel/style.css`, which hides the Search and Settings buttons below these widths. */
const SEARCH_BUTTON_HIDDEN_QUERY = '(width < 225px)';
const SETTINGS_BUTTON_HIDDEN_QUERY = '(width < 190px)';

export function useWorkspaceLayout({ dragging }: { dragging(): boolean }) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [listsHidden, setListsHidden] = useState(
    () => window.matchMedia(LISTS_HIDDEN_QUERY).matches,
  );
  const [bookmarksOpen, setBookmarksOpen] = useState(false);
  const [wideWorkspace, setWideWorkspace] = useState(
    () => window.matchMedia(WIDE_WORKSPACE_QUERY).matches,
  );
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

  useEffect(() => {
    const query = window.matchMedia(LISTS_HIDDEN_QUERY);
    return listen([query, 'change', () => setListsHidden(query.matches)]);
  }, []);

  // Narrowing past the point where a button hides closes what it opened; the shortcut can still reopen it.
  useEffect(() => {
    const search = window.matchMedia(SEARCH_BUTTON_HIDDEN_QUERY);
    const settings = window.matchMedia(SETTINGS_BUTTON_HIDDEN_QUERY);
    return listen(
      [search, 'change', () => { if (search.matches) setSearchOpen(false); }],
      [settings, 'change', () => { if (settings.matches) setSettingsOpen(false); }],
    );
  }, []);

  useEffect(() => {
    const query = window.matchMedia(WIDE_WORKSPACE_QUERY);
    const updateWideWorkspace = () => {
      setWideWorkspace(query.matches);
      if (query.matches) clearViewSwitchTimer();
    };
    return listen([query, 'change', updateWideWorkspace]);
  }, []);

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
