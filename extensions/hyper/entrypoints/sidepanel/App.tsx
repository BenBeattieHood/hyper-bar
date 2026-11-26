import { dragSelectionId } from './lib/dragSelection';
import { DndContext, DragOverlay } from '@dnd-kit/core';
import { OtherSessions } from './components/OtherSessions';
import { DragItemPreview } from './components/DragItemPreview';
import { DragStandIns } from './components/DragStandIns';
import { centerOverlayOnPointer, dragCollisionDetection } from './lib/dragDetection';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useMemo, useRef, useState, type ComponentProps, type CSSProperties } from 'react';
import { BookmarkTree } from './components/BookmarkTree';
import { BookmarkEditor } from './components/BookmarkEditor';
import { SpaceDeletePrompt, useSpaceDeletion } from './components/SpaceDeletePrompt';
import type { RecentTabsMenuContent } from './components/BookmarkMenu';
import { FavouritesGrid } from './components/FavouritesGrid';
import { GlobalBookmarksStack } from './components/GlobalBookmarksPanel';
import { SpaceArchiveStack, SpaceDragOverlay } from './components/SpaceArchivePanel';
import { Tabs } from './components/Tabs';
import { SpacePaginationNav } from './components/SpacePaginationNav';
import { SettingsLayer } from './components/SettingsLayer';
import { SidebarTopbar } from './components/SidebarTopbar';
import {
  SpaceColourStrip,
  slideMotion,
  ViewTransitionItems,
  workspaceSlideVariants,
} from './components/WorkspaceMotion';
import { TabListActions, WorkspaceViewToolbar } from './components/WorkspaceViewToolbar';
import { useBrowserState } from './hooks/useBrowserState';
import { groupColourStyle } from './lib/groupColour';
import { createSpaceIndicatorActions } from './lib/spaceIndicatorActions';
import { createSpaceMenuOpener } from './lib/spaceMenu';
import { useSettingsPreferences } from './hooks/useSettingsPreferences';
import { useBookmarkPanelSplit } from './hooks/useBookmarkPanelSplit';
import { useItemActions } from './hooks/useItemActions';
import { useActiveTabReveal } from './hooks/useActiveTabReveal';
import { useDragSession } from './hooks/useDragSession';
import { useFolderCollapse } from './hooks/useFolderCollapse';
import { useGlobalBookmarkTree } from './hooks/useGlobalBookmarkTree';
import { useWorkspaceOverlay } from './hooks/useWorkspaceOverlay';
import { useSpaceArchivePanel } from './hooks/useSpaceArchivePanel';
import { useNodeEditing } from './hooks/useNodeEditing';
import { useNowPlaying } from './hooks/useNowPlaying';
import { useSidebarShortcuts } from './hooks/useSidebarShortcuts';
import { useSpaceNavigation } from './hooks/useSpaceNavigation';
import { useTabTree } from './hooks/useTabTree';
import { useWorkspaceDrop } from './hooks/useWorkspaceDrop';
import { useWorkspaceIndexes } from './hooks/useWorkspaceIndexes';
import { useWorkspaceLayout } from './hooks/useWorkspaceLayout';
import { ItemActionsContext } from './lib/itemActions';
import {
  bookmarkFolderIds,
  bookmarkFolderOptions,
  archivedSpaces as archivedSpacesOf,
  deriveBookmarkState,
  findHyperBookmarkStructure,
  foremostTabInWindow,
  shownSpaces,
  tabSpaceId,
  visibleBookmarkTitle,
  type BrowserTab,
} from '../lib/bookmarks';
import { pageIdentity, tabUrl } from '../lib/urlIdentity';
import { recentOpenTabs } from '../lib/tabs';
import { browserCommandActions } from '../lib/browserCommands';
import type { CommandAction } from '../lib/commandBar';
import { flattenVisibleTree } from './lib/drag';
import { toggleFolder } from './lib/folderReveal';
import { errorMessage, type Notify } from './lib/notify';
import { dragPresentation } from './lib/dragPresentation';
import { createDropActions } from './lib/dropActions';
import { createFavouriteBarActions } from './lib/favouriteBarActions';
import { hyperCommandActions } from './lib/hyperCommands';
import { extensionOrigin as readExtensionOrigin } from './lib/extensionOrigin';

export function SidebarApp({ browserState }: { browserState: ReturnType<typeof useBrowserState> }) {
  const reduceMotion = useReducedMotion();
  const searchTriggerRef = useRef<HTMLButtonElement>(null);
  const {
    armWorkspaceView,
    bookmarksOpen,
    bookmarksOpenRef,
    clearViewSwitchTimer,
    closeBookmarks,
    dragArmingView,
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
  } = useWorkspaceLayout({ dragging: () => Boolean(activeDragRef.current) });
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set());
  const toggleCollapsedId = (id: string) => setCollapsedIds((current) => toggleFolder(current, id));
  const searchRef = useRef<HTMLInputElement>(null);
  const showNotice: Notify = (message, tone = 'error') => void browserState.showMessage(message, tone);
  const settingsPreferences = useSettingsPreferences({ ...browserState, onNotice: showNotice });
  const { combineTabsAndBookmarks, favouriteGrouping, tabFolders } = settingsPreferences;
  const bookmarkPanelSplit = useBookmarkPanelSplit(browserState.preferences.bookmarkPanelPercent, (percent) => void browserState.setPreference('bookmarkPanelPercent', percent));

  const {
    spaces: allSpaces,
    favourites,
    favouriteSlots,
    globalBookmarks,
    localBookmarksBySpaceId,
    nodeMap,
  } = useMemo(
    () => deriveBookmarkState(browserState.bookmarkTree, browserState.spaceColours),
    [browserState.bookmarkTree, browserState.spaceColours],
  );
  // Archived spaces leave the pagination, and everything that picks a space, for their own list.
  const [spaces, archivedSpaces] = useMemo(() => [shownSpaces(allSpaces), archivedSpacesOf(allSpaces)], [allSpaces]);
  const dragSession = useDragSession({
    browserState,
    clearViewSwitchTimer,
    collapsedIds,
    favouriteSlots,
    nodeMap,
    setCollapsedIds,
  });
  const {
    activeDrag,
    activeDragItems,
    activeDragRef,
    clearSelectedTabs,
    clearSelectedTabsAfter,
    copyModifierActive,
    dragOverTarget,
    dragSelection,
    dragSelectionRef,
    dropForbidden,
    replaceSelectedDragItems,
    sensors,
    sharedDrag,
    spaceDragPreview,
    treeDropIndicator,
    treeExpandingNodeId,
    updateSelectedDragItems,
  } = dragSession;
  const openBookmarkWithNotice = (url: string, forceNew = false) => {
    void clearSelectedTabsAfter(browserState.openBookmark(url, { forceNew }))
      .catch(noticeOnFailure('The bookmark could not be opened'));
  };
  const activeSpace =
    spaces.find((space) => space.id === browserState.activeSpaceId) ?? spaces[0];
  const bookmarksRootId = activeSpace?.rootId;
  const {
    bookmarksSlideIntent,
    onSwipeEnd,
    onSwipeStart,
    selectSpace,
    spaceSlideDirection,
    stepSpace,
    swipeStart,
    tabsSlideIntent,
  } = useSpaceNavigation({
    activeSpace,
    browserState,
    clearSelectedTabs,
    setWorkspaceTransitionKind,
    showNotice,
    spaces,
    workspaceTransitionKind,
  });
  const spaceDeletion = useSpaceDeletion({
    bookmarksBySpaceId: localBookmarksBySpaceId,
    // A space the user keeps opens on the bookmarks they nearly lost.
    onCancel: (spaceId) => {
      setSettingsOpen(false);
      openBookmarks();
      void selectSpace(spaceId);
    },
    onDelete: browserState.removeBookmark,
    onNotice: showNotice,
  });
  // Local writes need the space's marked bookmarks root, which repair creates.
  const requireLocalRoot = (): string | undefined => {
    if (activeSpace?.rootId) return activeSpace.rootId;
    showNotice('This space has no bookmarks folder yet.', 'warning');
    return undefined;
  };
  const activeSpaceColour = activeSpace?.colour;
  const visibleTree = useMemo(
    () => localBookmarksBySpaceId[activeSpace?.id ?? ''] ?? [],
    [activeSpace?.id, localBookmarksBySpaceId],
  );
  const bookmarkFolderIdList = useMemo(
    () => bookmarkFolderIds(visibleTree),
    [visibleTree],
  );
  const compactCombinedWorkspace = combineTabsAndBookmarks.enabled && !wideWorkspace;
  const bookmarksVisible = !settingsOpen && (
    wideWorkspace || compactCombinedWorkspace || bookmarksOpen
  );
  const workspacePanesVisible = !listsHidden;
  const tabsPaneVisible = !settingsOpen && workspacePanesVisible && (
    wideWorkspace || compactCombinedWorkspace || !bookmarksOpen
  );
  const bookmarksPaneVisible = bookmarksVisible && workspacePanesVisible;
  const importFolders = useMemo(() => {
    const hyperId = findHyperBookmarkStructure(browserState.bookmarkTree)?.hyper.id;
    return bookmarkFolderOptions(
      browserState.bookmarkTree,
      new Set(hyperId ? [hyperId] : []),
    );
  }, [browserState.bookmarkTree]);
  const visibleTreeItems = useMemo(
    () => flattenVisibleTree(visibleTree, bookmarksRootId ?? '', collapsedIds, false),
    [bookmarksRootId, collapsedIds, visibleTree],
  );
  const activeWindowTab = foremostTabInWindow(browserState.tabs, browserState.currentWindowId, true);
  const foremostWindowTab = foremostTabInWindow(
    browserState.tabs,
    browserState.currentWindowId,
    browserState.currentWindowFocused,
  );
  const {
    audioStateByTabId,
    focusAudibleTab,
    mediaControls,
    mediaReturnTab,
    toggleAudibleTabMuted,
  } = useNowPlaying({ activeWindowTab, browserState, clearSelectedTabsAfter, showNotice });
  const {
    audioStateByPageIdentity,
    localSpaceIdsByPageIdentity,
    openBookmarkFolderIds,
    spaceColours,
    spaceIdsByPageIdentity,
    tabBackingsByTabId,
    tabsByPageIdentity,
  } = useWorkspaceIndexes({ audioStateByTabId, browserState, nodeMap, spaces, visibleTree });
  const extensionOrigin = readExtensionOrigin();
  const recentTabs = useMemo(
    () => recentOpenTabs(
      browserState.tabs,
      browserState.currentWindowId,
      extensionOrigin,
    ),
    [browserState.currentWindowId, browserState.tabs, extensionOrigin],
  );
  function noticeOnFailure(fallback: string) {
    return (error: unknown) => showNotice(errorMessage(error, fallback));
  }
  const recentTabsMenu: RecentTabsMenuContent = {
    closedTabs: browserState.recentlyClosedTabs,
    tabs: recentTabs,
    onRestore: (sessionId) => void browserState.submitBrowserCommand({
      kind: 'restoreClosedTab',
      payload: { sessionId },
    }).catch(noticeOnFailure('The closed tab could not be restored')),
    onSelect: (tab) => void clearSelectedTabsAfter(browserState.focusTab(tab))
      .catch(noticeOnFailure('The recent tab could not be focused')),
    onToggleOtherSessions: () => void browserState.setPreference('showOtherSessions', !browserState.preferences.showOtherSessions),
    showOtherSessions: browserState.preferences.showOtherSessions,
  };
  const {
    activeSpaceTabsByPageIdentity,
    autoTabFolderTree,
    matchingBookmarksByTabId,
    matchingTabsByBookmarkId,
    moveTabTreeNodes,
    openTabFolderIds,
    realTabTreeDestination,
    spaceTabs,
    splitRows,
    tabIdsByFolderId,
    tabTree,
    tabTreeItems,
    tabTreeNodes,
    tabTreeRootId,
    tabsByNodeId,
  } = useTabTree({
    activeSpace,
    autofolders: tabFolders.enabled,
    browserState,
    collapsedIds,
    compactCombinedWorkspace,
    nodeMap,
    visibleTree,
  });
  const foremostPageIdentity = pageIdentity(
    tabUrl(foremostWindowTab),
  ) ?? undefined;
  const foremostSpaceId = tabSpaceId(
    foremostWindowTab,
    browserState.tabSpaceIds,
    browserState.spaceGroupIds,
    activeSpace?.id,
    browserState.activeGroupId,
  );
  const selectedDragItemIds = useMemo(
    () => new Set(dragSelection.items.map(dragSelectionId)),
    [dragSelection.items],
  );
  const {
    activeDragCount,
    activeDragSpace,
    activeDragTitle,
    activeDragTrashDisabled,
    activeDragTrashLabel,
    dragAction,
    mediaControlsDragDisabled,
  } = dragPresentation({
    activeDrag, activeDragItems, archivedSpaces, copyModifierActive, dragOverTarget, dropForbidden, spaces,
  });

  useFolderCollapse({
    activeSpace,
    bookmarkFolderIdList,
    bookmarksPaneVisible,
    bookmarksRootId,
    bookmarksVisible,
    isLoading: browserState.isLoading,
    openBookmarkFolderIds,
    openTabFolderIds,
    setCollapsedIds,
    tabFoldersPending: tabFolders.isPending,
    tabsPaneVisible,
  });

  useActiveTabReveal({
    activeTab: activeWindowTab,
    bookmarks: { nodes: visibleTree, rootId: bookmarksRootId ?? '', visible: bookmarksPaneVisible },
    collapsedIds,
    linkedBookmarkId: activeWindowTab?.id === undefined ? undefined : matchingBookmarksByTabId.get(activeWindowTab.id)?.id,
    setCollapsedIds,
    shownKey: `${activeSpace?.id}:${workspacePanesVisible}`,
    tabs: { nodes: tabTreeNodes, rootId: tabTreeRootId, tabsByNodeId, visible: tabsPaneVisible },
  });

  const {
    addCurrentPage,
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
  } = useNodeEditing({
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
    tabFoldersPending: tabFolders.isPending,
  });

  const globalPanel = useWorkspaceOverlay({ activeSpaceId: activeSpace?.id, dragActive: Boolean(activeDrag) });
  const archivePanel = useSpaceArchivePanel({ activeSpaceId: activeSpace?.id, archivedCount: archivedSpaces.length, dragActive: Boolean(activeDrag), globalPanel });
  const showTabsList = () => { globalPanel.close(); archivePanel.close(); if (bookmarksOpenRef.current && !tabsPaneVisible) closeBookmarks(); };
  const headerActionsDisabled = browserState.isBackingOperationPending || tabFolders.isPending;
  const shortcutActions = useSidebarShortcuts({
    activeSpace, actionsDisabled: headerActionsDisabled, addCurrentPage, bookmarksOpen, browserState, closeBookmarks,
    createFolder, createSpace, createTabFolder, deleteNode, editingNode, moveNode,
    globalPanel: { close: () => { globalPanel.close(); archivePanel.close(); }, toggle: globalPanel.toggle },
    nodeMap, openBookmarks, renameNode, requireLocalRoot, searchRef, selectSpace, setBookmarksOpen,
    setSearchOpen, setSettingsOpen, settingsOpen, spaces, stepSpace,
  });
  const globalTree = useGlobalBookmarkTree({ browserState, collapsedIds, globalBookmarks });
  const globalRootId = globalTree.rootId;

  const spaceIndicatorActions = createSpaceIndicatorActions({
    clearSelectedAfter: clearSelectedTabsAfter,
    closeTabsInSpace: browserState.closeTabsInSpace,
    focusRemoteTab: browserState.focusRemoteTab,
    moveRemoteTabToWindow: browserState.moveRemoteTabToWindow,
    openBookmark: browserState.openBookmark,
    showNotice,
  });

  const dropActions = createDropActions({
    activeSpace, archivedSpaces, bookmarksRootId, browserState, favouriteSlots, favourites, globalBookmarksRootId: globalRootId, moveTabTreeNodes, nodeMap,
    realTabTreeDestination, showNotice, spaceDeletion, spaceTabs, spaces, tabIdsByFolderId, tabTreeRootId,
  });
  const bookmarkTab = async (tab: BrowserTab) => {
    if (tab.id === undefined) return;
    const rootId = requireLocalRoot();
    if (!rootId) return;
    const result = await browserState.addTabBookmark(rootId, tab.id);
    if (!result.created) {
      showNotice(
        `${visibleBookmarkTitle(result.node) || 'This page'} is already in ${activeSpace?.title ?? 'this space'}`,
        'warning',
      );
    }
  };
  const itemActions = useItemActions({
    activeSpace, activeTab: activeWindowTab, bookmarkTab, browserState, deleteNode,
    dragSelection: () => dragSelectionRef.current,
    dropActions, editNode: renameNode, extensionOrigin, favouriteSlots, localBookmarksBySpaceId, nodeMap,
    realTabTreeDestination, showNotice, spaceColours, spaceTabs, spaces, splitRows, tabIdsByFolderId, tabTreeNodes, tabTreeRootId,
  });
  const openSpaceMenu = createSpaceMenuOpener({
    browserState, duplicateSpace, extensionOrigin, nodeMap, openMenu: itemActions.actions.openMenu, renameSpace,
    requestDeletion: spaceDeletion.request, showNotice, spaces,
  });

  const { armingSpaceId, handleDragCancel, handleDragEnd, handleDragMove, handleDragOver, handleDragStart, spaceInsertion } = useWorkspaceDrop({
    activeSpace, archivePanel, armWorkspaceView, bookmarksOpenRef, browserState, clearViewSwitchTimer, collapsedIds, dragSession, dropActions,
    bookmarksRootId: globalPanel.open ? globalRootId : bookmarksRootId,
    globalPanel, listsSideBySide: wideWorkspace || compactCombinedWorkspace, nodeMap, selectSpace,
    showWorkspaceView: (view) => view === 'bookmarks' ? openBookmarks() : closeBookmarks(),
    splitRows, tabTreeItems, tabTreeRootId, tabsByNodeId, wideWorkspace,
    visibleTreeItems: globalPanel.open ? globalTree.items : visibleTreeItems,
  });

  if (browserState.isLoading) {
    return (
      <main className="loading-shell" aria-label="Loading Hyper">
        <div className="brand-mark" aria-hidden="true" />
        <div className="loading-lines" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <span className="sr-only">Loading bookmarks</span>
      </main>
    );
  }

  if (browserState.error || !activeSpace) {
    return (
      <main className="error-shell">
        <div className="brand-mark" aria-hidden="true" />
        <h1>Hyper</h1>
        <p>{browserState.error ?? 'No spaces are available.'}</p>
      </main>
    );
  }

  const commandActions: CommandAction[] = [
    ...hyperCommandActions({
      actions: shortcutActions, activeSpace, activeWindowTab, browserState, focusAudibleTab,
      selectSpace, showNotice, spaces,
    }),
    ...browserCommandActions({
      capabilities: browserState.commandCapabilities, currentTab: activeWindowTab,
      onError: showNotice, tabs: browserState.tabs,
      onActiveTabChange: clearSelectedTabs, submitIntent: browserState.submitBrowserCommand,
    }),
  ];

  const spaceTreeProps: ComponentProps<typeof BookmarkTree> = {
    activeSpaceId: activeSpace.id,
    allTabsByPageIdentity: tabsByPageIdentity,
    audioStateByPageIdentity,
    collapsedIds,
    dragArmingNodeId: treeExpandingNodeId,
    draggedNodeId: activeDrag?.kind === 'tree' ? activeDrag.nodeId : undefined,
    dropDisabled: browserState.isBackingOperationPending,
    dropIndicator: treeDropIndicator,
    extensionOrigin,
    foremostPageIdentity,
    foremostSpaceId,
    importFolders,
    items: visibleTreeItems,
    localSpaceIdsByPageIdentity,
    matchingTabsByBookmarkId,
    nodes: visibleTree,
    onAddCurrentTab: (parentId) => void addCurrentPage(parentId, 'bookmarks'),
    onAddFolder: (parentId) => void createFolder(parentId),
    onCloseInSpace: (bookmarkId, spaceId) => spaceIndicatorActions.closeInSpace(
      { bookmarkId, kind: 'bookmark' }, spaceId),
    onCloseTabs: (tabIds) => void browserState.closeTabs(tabIds)
      .catch(noticeOnFailure('The tabs could not be closed')),
    onDragSelectionChange: replaceSelectedDragItems,
    onDragSelectionPointerDown: updateSelectedDragItems,
    onImportFolder: (folderId) => void importBookmarkFolder(folderId),
    onInteractionError: showNotice,
    onOpen: (url, forceNew) => openBookmarkWithNotice(url, forceNew),
    onOpenInSpace: (url, spaceId) => spaceIndicatorActions.openLocal(url, spaceId),
    onOpenRemoteInSpace: (bookmarkId, spaceId, moveToCurrentWindow) => spaceIndicatorActions.openRemote(
      { bookmarkId, kind: 'bookmark' }, spaceId, moveToCurrentWindow),
    onRenameTitle: (node, title) => browserState.updateBookmark(node.id, title),
    onRevertBookmark: (tabId, url) => browserState.navigateTab(tabId, url),
    onToggleFolder: toggleCollapsedId,
    onUpdateBookmarkUrl: (bookmark, url) => browserState.updateBookmarkUrl(bookmark.id, url),
    remoteSpaceIdsByBookmarkId: browserState.remoteSpacePresence.bookmarkSpaceIds,
    rootId: bookmarksRootId ?? '',
    selectedDragItemIds,
    slideDirection: spaceSlideDirection,
    spaceColours,
    spaceIdsByPageIdentity,
    spaces,
    tabsByPageIdentity: activeSpaceTabsByPageIdentity,
  };

  return (
    <ItemActionsContext.Provider value={itemActions.actions}>
      <DndContext
        sensors={sensors}
        collisionDetection={dragCollisionDetection}
        onDragStart={handleDragStart}
        onDragMove={handleDragMove}
        onDragOver={handleDragOver}
        onDragCancel={handleDragCancel}
        onDragEnd={(event) => {
          void browserState.runBackingOperation(() => handleDragEnd(event))
            .catch(noticeOnFailure('That item could not be moved'));
        }}
        accessibility={{
          screenReaderInstructions: {
            draggable:
              'Press space to pick up an item. Use arrow keys to move it, then press space to drop or escape to cancel.',
          },
        }}
      >
        <div className="app-shell" data-space-colour={activeSpaceColour} style={groupColourStyle('--space-colour', activeSpaceColour)}>
          <SpaceColourStrip
            colour={activeSpaceColour}
            direction={spaceSlideDirection}
            spaceId={activeSpace.id}
          />
          <SidebarTopbar
            activeSpace={activeSpace}
            browserState={browserState}
            clearSelectedTabsAfter={clearSelectedTabsAfter}
            commandActions={commandActions}
            itemMenu={itemActions.actions.searchMenu}
            nodeMap={nodeMap}
            reduceMotion={reduceMotion}
            searchOpen={searchOpen}
            searchRef={searchRef}
            searchTriggerRef={searchTriggerRef}
            selectSpace={selectSpace}
            setCollapsedIds={setCollapsedIds}
            setSearchOpen={setSearchOpen}
            setSettingsOpen={setSettingsOpen}
            settingsOpen={settingsOpen}
            showGlobalBookmarks={globalPanel.show}
            showNotice={showNotice}
            spaceColours={spaceColours}
          />

          <div
            className="workspace-scroll"
            aria-hidden={searchOpen || settingsOpen || undefined}
            inert={searchOpen || settingsOpen || undefined}
          >
            <FavouritesGrid
              favourites={favouriteSlots}
              groupByDomain={favouriteGrouping.enabled}
              column={listsHidden}
              tabs={browserState.tabs}
              windowId={browserState.currentWindowId}
              extensionOrigin={extensionOrigin}
              tabState={browserState}
              dragging={Boolean(activeDrag)}
              backgroundMusicTabIds={browserState.backgroundMusicTabIds}
              tabsByPageIdentity={tabsByPageIdentity}
              tileSpaces={{ activeSpaceId: activeSpace.id, spaceColours, spaceIdsByPageIdentity, spaces, tabSpaceIds: browserState.tabSpaceIds }}
              audioStateByTabId={audioStateByTabId}
              dropDisabled={
                browserState.isBackingOperationPending ||
                activeDrag?.kind === 'tree' && activeDrag.isFolder
              }
              {...createFavouriteBarActions({ browserState, clearSelectedTabsAfter, onUnpin: (node) => deleteNode(node, { unpin: true }), showNotice, showTabs: showTabsList })}
              globalBookmarksOpen={globalPanel.open}
              globalBookmarksArming={globalPanel.arming}
              globalBookmarksDropDisabled={browserState.isBackingOperationPending || !globalRootId}
              onToggleGlobalBookmarks={globalPanel.toggle}
            />

            <div className="tree-workspace">
              <section className="tree-section" aria-labelledby="space-title">
              <div
                className="space-gesture-area"
                onPointerDown={onSwipeStart}
                onPointerUp={onSwipeEnd}
                onPointerCancel={() => {
                  swipeStart.current = undefined;
                }}
              >
                <SpaceArchiveStack activeDrag={activeDrag} archivedSpaces={archivedSpaces} onMenu={openSpaceMenu} open={archivePanel.open} reduceMotion={Boolean(reduceMotion)}>
                <GlobalBookmarksStack
                  actionsDisabled={browserState.isBackingOperationPending}
                  onCreateFolder={(rootId) => void createFolder(rootId)}
                  onImportFolder={(folderId, rootId) => void importBookmarkFolder(folderId, rootId)}
                  open={globalPanel.open}
                  reduceMotion={Boolean(reduceMotion)}
                  spaceTreeProps={spaceTreeProps}
                  tree={globalTree}
                >
                <div className="space-panel">
                  {compactCombinedWorkspace && (
                    <>
                      <span id="workspace-tab-tabs" className="sr-only">Tabs</span>
                      <span id="workspace-tab-bookmarks" className="sr-only">Bookmarks</span>
                      <div className="workspace-view-toolbar is-combined">
                        <TabListActions
                          disabled={headerActionsDisabled}
                          onCreateFolder={() => void createTabFolder()}
                          recentTabsMenu={recentTabsMenu}
                        />
                      </div>
                    </>
                  )}
                  {(wideWorkspace || !combineTabsAndBookmarks.enabled) && (
                    <WorkspaceViewToolbar
                      view={bookmarksOpen ? 'bookmarks' : 'tabs'}
                      wide={wideWorkspace}
                      sidebarSide={sidebarSide}
                      dragArmingView={dragArmingView}
                      onSelectTabs={closeBookmarks}
                      onSelectBookmarks={() => openBookmarks()}
                      onDragHover={armWorkspaceView}
                      onDragHoverEnd={clearViewSwitchTimer}
                      onCreateTabFolder={() => void createTabFolder()}
                      onCreateBookmarkFolder={() => {
                        const rootId = requireLocalRoot();
                        if (rootId) void createFolder(rootId);
                      }}
                      recentTabsMenu={recentTabsMenu}
                      bookmarkActionsDisabled={headerActionsDisabled}
                    />
                  )}
                  <div
                    className={`workspace-view-content${wideWorkspace ? ` is-split is-sidebar-${sidebarSide}` : compactCombinedWorkspace ? ' is-combined' : ''}`}
                    style={compactCombinedWorkspace
                      ? {
                          '--compact-bookmark-panel-size': `${bookmarkPanelSplit.percent}%`,
                        } as CSSProperties
                      : undefined}
                  >
                    <AnimatePresence
                      initial={false}
                      custom={tabsSlideIntent}
                      mode="popLayout"
                    >
                      {(wideWorkspace || compactCombinedWorkspace || !bookmarksOpen) && (
                        <motion.div
                          key={activeSpace.id}
                          className="tabs-space-layer workspace-view-panel"
                          custom={tabsSlideIntent}
                          variants={workspaceSlideVariants}
                          animate="center"
                          {...slideMotion(reduceMotion)}
                          data-space-id={activeSpace.id}
                        >
                          <ViewTransitionItems
                            enabled={
                              !wideWorkspace && !compactCombinedWorkspace && !reduceMotion
                            }
                            view="tabs"
                          >
                            <Tabs
                        items={tabTreeItems}
                        nodes={tabTreeNodes}
                        rootId={tabTreeRootId}
                        rootIndex={
                          autoTabFolderTree
                            ? tabTreeNodes.length
                            : nodeMap.get(tabTreeRootId)?.children?.length ??
                              tabTree.nodes.length
                        }
                        tabsByNodeId={tabsByNodeId}
                        splitRows={splitRows}
                        tabBackingsByTabId={tabBackingsByTabId}
                        tabNaming={browserState}
                        audioStateByTabId={audioStateByTabId}
                        matchingBookmarksByTabId={matchingBookmarksByTabId}
                        spaces={spaces}
                        localSpaceIdsByPageIdentity={localSpaceIdsByPageIdentity}
                        remoteSpacePresence={browserState.remoteSpacePresence}
                        spaceIdsByPageIdentity={spaceIdsByPageIdentity}
                        activeSpaceId={activeSpace.id}
                        foremostPageIdentity={foremostPageIdentity}
                        foremostSpaceId={foremostSpaceId}
                        spaceColours={spaceColours}
                        extensionOrigin={extensionOrigin}
                        collapsedIds={collapsedIds}
                        showDropHint={false}
                        dropDisabled={
                          browserState.isBackingOperationPending || tabFolders.isPending
                        }
                        draggedNodeId={activeDrag?.kind === 'tab-folder'
                          ? activeDrag.nodeId
                          : activeDrag?.kind === 'tab'
                            ? activeDrag.nodeId
                            : undefined}
                        dragArmingNodeId={treeExpandingNodeId}
                        dropIndicator={treeDropIndicator}
                        selectedDragItemIds={selectedDragItemIds}
                        onDragSelectionPointerDown={updateSelectedDragItems}
                        onDragSelectionChange={replaceSelectedDragItems}
                        onToggleFolder={toggleCollapsedId}
                        onCreateFolder={(parentId) => void createTabFolder(parentId)}
                        onEditFolder={(node) => {
                          provisionalCreation.current = undefined;
                          editorReturnFocus.current = document.activeElement as HTMLElement | null;
                          setEditingNode(node);
                        }}
                        onFocus={(tab) => {
                          void clearSelectedTabsAfter(browserState.focusTab(tab))
                            .catch(noticeOnFailure('The tab could not be focused'));
                        }}
                        onDuplicate={(tab) => {
                          void clearSelectedTabsAfter(browserState.duplicateTab(tab))
                            .catch(noticeOnFailure('The tab could not be duplicated'));
                        }}
                        onRename={(tab, title) => browserState.renameTab(tab, title)}
                        onUpdateBookmarkUrl={(bookmark, url) =>
                          browserState.updateBookmarkUrl(bookmark.id, url)}
                        onRevertBookmark={(tabId, url) =>
                          browserState.navigateTab(tabId, url)}
                        onRemoveBookmark={(bookmark) =>
                          browserState.removeBookmark(bookmark)}
                        onCreateBookmark={bookmarkTab}
                        onInteractionError={showNotice}
                        onFocusInSpace={(url, spaceId) => spaceIndicatorActions.openLocal(url, spaceId)}
                        onFocusRemoteTab={(tabId, spaceId, moveToCurrentWindow) =>
                          spaceIndicatorActions.openRemote(
                            { kind: 'tab', tabId }, spaceId, moveToCurrentWindow)}
                        onCloseInSpace={(tabId, spaceId) => spaceIndicatorActions.closeInSpace({ kind: 'tab', tabId }, spaceId)}
                        onClose={(tabId) => void browserState.closeTab(tabId).catch(noticeOnFailure('The tab could not be closed'))}
                        onCloseFolder={(tabIds, folderTitle) => void browserState.closeTabs(tabIds, folderTitle).catch(noticeOnFailure('The tabs could not be closed'))}
                        onCreate={() => {
                          void clearSelectedTabsAfter(browserState.createTab())
                            .catch(noticeOnFailure('A new tab could not be opened'));
                        }}
                        otherSessions={browserState.preferences.showOtherSessions && (
                          <OtherSessions
                            autofolders={tabFolders.enabled}
                            dropDisabled={browserState.isBackingOperationPending}
                            installationId={browserState.installationId}
                            onDragSelectionPointerDown={updateSelectedDragItems}
                            onOpen={(node) => node.url && spaceIndicatorActions.openLocal(node.url, activeSpace.id)}
                            selectedDragItemIds={selectedDragItemIds}
                            spaceId={activeSpace.id}
                            tree={browserState.bookmarkTree}
                          />
                        )}
                            />
                          </ViewTransitionItems>
                        </motion.div>
                      )}
                    </AnimatePresence>
                    {compactCombinedWorkspace && bookmarksRootId && (
                      <div className="workspace-panel-splitter" {...bookmarkPanelSplit.splitterProps} />
                    )}
                    <AnimatePresence
                      initial={false}
                      custom={bookmarksSlideIntent}
                      mode="popLayout"
                    >
                      {(wideWorkspace || compactCombinedWorkspace || bookmarksOpen) &&
                        bookmarksRootId && (
                      <motion.section
                        key="bookmarks"
                        id="workspace-panel-bookmarks"
                        className="bookmarks-section workspace-view-panel"
                        role="tabpanel"
                        aria-labelledby="workspace-tab-bookmarks"
                        custom={bookmarksSlideIntent}
                        variants={workspaceSlideVariants}
                        animate="center"
                        {...slideMotion(reduceMotion)}
                        initial={reduceMotion || wideWorkspace ? false : 'enter'}
                      >
                        <ViewTransitionItems
                          enabled={
                            !wideWorkspace && !compactCombinedWorkspace && !reduceMotion
                          }
                          view="bookmarks"
                        >
                          <BookmarkTree {...spaceTreeProps} />
                        </ViewTransitionItems>
                      </motion.section>
                      )}
                    </AnimatePresence>
                  </div>
                </div>
                </GlobalBookmarksStack>
                </SpaceArchiveStack>
              </div>
              </section>

              <SpacePaginationNav
                activeDrag={activeDrag}
                activeDragTrashDisabled={activeDragTrashDisabled}
                activeDragTrashLabel={activeDragTrashLabel}
                activeSpace={activeSpace}
                archivePanel={archivePanel}
                archivedSpaces={archivedSpaces}
                armingSpaceId={armingSpaceId}
                browserState={browserState}
                createSpace={createSpace}
                dragOverTarget={dragOverTarget}
                extensionOrigin={extensionOrigin}
                focusAudibleTab={focusAudibleTab}
                mediaControls={mediaControls}
                mediaControlsDragDisabled={mediaControlsDragDisabled}
                mediaReturnTab={mediaReturnTab}
                noticeOnFailure={noticeOnFailure}
                openSpaceMenu={openSpaceMenu}
                reduceMotion={reduceMotion}
                selectSpace={selectSpace}
                spaces={spaces}
                toggleAudibleTabMuted={toggleAudibleTabMuted}
                spaceInsertion={spaceInsertion}
              />
            </div>
          </div>
          <SettingsLayer
            bookmarkActionsDisabled={browserState.isBackingOperationPending}
            globalBookmarksRootId={globalRootId}
            importBookmarkFolder={importBookmarkFolder}
            importFolders={importFolders}
            reduceMotion={reduceMotion}
            setSettingsOpen={setSettingsOpen}
            settingsOpen={settingsOpen}
            spaces={spaces}
            timedMessages={browserState}
            {...settingsPreferences}
          />
        </div>
        <DragStandIns external={dragSession.externalDrag} shared={sharedDrag} />
        <DragOverlay dropAnimation={null} modifiers={[centerOverlayOnPointer]}>
          {activeDrag?.kind === 'space' && activeDragSpace ? (
            <SpaceDragOverlay active={activeDragSpace.id === activeSpace.id} archived={Boolean(activeDrag.archived)} overDot={Boolean(spaceInsertion)} preview={spaceDragPreview} space={activeDragSpace} />
          ) : activeDrag ? (
            <DragItemPreview
              action={dragAction}
              audioStateByTabId={audioStateByTabId}
              count={activeDragCount}
              drag={activeDrag}
              nodes={nodeMap}
              tabs={browserState.tabs}
              tabsByPageIdentity={tabsByPageIdentity}
              title={activeDragTitle}
            />
          ) : null}
        </DragOverlay>
      </DndContext>

      {editor && <BookmarkEditor {...editor} />}
      <SpaceDeletePrompt deletion={spaceDeletion} />
      {itemActions.menu}
    </ItemActionsContext.Provider>
  );
}