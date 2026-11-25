import { useDroppable } from '@dnd-kit/core';
import { BookmarkCreateActions, RecentTabsMenu, type RecentTabsMenuContent } from './BookmarkMenu';
import { shortcutButtonProps } from '../../lib/shortcuts';
import type { SidebarSide } from '../lib/sidebarPlacement';

/** The tab list header: a new tab folder and the recent tabs menu. */
export function TabListActions({ disabled, onCreateFolder, recentTabsMenu }: {
  disabled: boolean;
  onCreateFolder: () => void;
  recentTabsMenu: RecentTabsMenuContent;
}) {
  return (
    <BookmarkCreateActions
      disabled={disabled}
      buttonClassName="section-add-button workspace-view-add"
      groupLabel="Create tab-list items"
      folderLabel="Create tab folder"
      folderShortcut="createTabFolder"
      onCreateFolder={onCreateFolder}
      trailingAction={<RecentTabsMenu buttonClassName="section-add-button workspace-view-add" {...recentTabsMenu} />}
    />
  );
}

export function WorkspaceViewToolbar({
  view,
  wide,
  sidebarSide,
  dragArmingView,
  onSelectTabs,
  onSelectBookmarks,
  onDragHover,
  onDragHoverEnd,
  onCreateTabFolder,
  onCreateBookmarkFolder,
  bookmarkActionsDisabled,
  recentTabsMenu,
}: {
  view: 'tabs' | 'bookmarks';
  wide: boolean;
  sidebarSide: SidebarSide;
  dragArmingView?: 'tabs' | 'bookmarks';
  onSelectTabs: () => void;
  onSelectBookmarks: () => void;
  onDragHover: (view: 'tabs' | 'bookmarks') => void;
  onDragHoverEnd: () => void;
  onCreateTabFolder: () => void;
  onCreateBookmarkFolder: () => void;
  bookmarkActionsDisabled: boolean;
  recentTabsMenu: RecentTabsMenuContent;
}) {
  const tabsDropZone = useDroppable({
    id: 'tabs-trigger',
    data: { kind: 'tabs-trigger' },
  });
  const bookmarksDropZone = useDroppable({
    id: 'bookmarks-trigger',
    data: { kind: 'bookmarks-trigger' },
  });
  const viewingBookmarks = view === 'bookmarks';
  const tabListActions = (
    <TabListActions
      disabled={bookmarkActionsDisabled}
      onCreateFolder={onCreateTabFolder}
      recentTabsMenu={recentTabsMenu}
    />
  );
  const bookmarkActions = (
    <BookmarkCreateActions
      disabled={bookmarkActionsDisabled}
      buttonClassName="section-add-button workspace-view-add"
      groupLabel="Create bookmark items"
      folderLabel="Create bookmark folder"
      folderShortcut="createBookmarkFolder"
      onCreateFolder={onCreateBookmarkFolder}
    />
  );

  if (wide) {
    return (
      <div className={`workspace-view-toolbar is-wide is-sidebar-${sidebarSide}`}>
        <div className="workspace-pane-heading">
          <span id="workspace-tab-tabs">Tabs</span>
          {tabListActions}
        </div>
        <div className="workspace-pane-heading">
          <span id="workspace-tab-bookmarks">Bookmarks</span>
          {bookmarkActions}
        </div>
      </div>
    );
  }

  return (
    <div className="workspace-view-toolbar">
      <div className="workspace-view-tabs" role="tablist" aria-label="Workspace view">
        {([
          ['tabs', 'Tabs', tabsDropZone, view === 'tabs', onSelectTabs, 'showTabs'],
          ['bookmarks', 'Bookmarks', bookmarksDropZone, viewingBookmarks, onSelectBookmarks, 'showBookmarks'],
        ] as const).map(([id, label, dropZone, active, onSelect, shortcut]) => (
          <button
            key={id}
            ref={dropZone.setNodeRef}
            type="button"
            id={`workspace-tab-${id}`}
            className={`workspace-view-tab ${id}-trigger${active ? ' is-active' : ''}${dropZone.isOver ? ' is-over' : ''}${dragArmingView === id ? ' is-drag-arming' : ''}`}
            role="tab"
            aria-selected={active}
            aria-controls={`workspace-panel-${id}`}
            onClick={onSelect}
            onPointerEnter={() => onDragHover(id)}
            onPointerLeave={onDragHoverEnd}
            {...shortcutButtonProps(shortcut)}
          >
            {label}
          </button>
        ))}
      </div>
      {viewingBookmarks ? bookmarkActions : tabListActions}
    </div>
  );
}
