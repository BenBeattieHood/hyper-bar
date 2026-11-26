import { Broom, Columns2, FolderPlus, SquarePlus } from 'lucide-react';
import {
  createContext,
  useContext,
  useMemo,
  useState,
  type CSSProperties,
  type MouseEvent,
  type ReactNode,
} from 'react';
import {
  bookmarkableTabUrl,
  descendantCount,
  descendantItemCount,
  isTabSleeping,
  pageIsForemostInSpace,
  spaceHasTabUrl,
  visibleBookmarkTitle,
  type BrowserTab,
  type BookmarkNode,
} from '../../lib/bookmarks';
import type { FlattenedTreeItem } from '../lib/drag';
import type { SplitRows } from '../lib/splitRows';
import { isAutoTabFolderId } from '../../lib/autoTabFolders';
import { duplicateTabIdsByFolder, tabIdsByFolder } from '../lib/tabFolders';
import {
  tabDisplayTitle,
  tabDisplayUrl,
  tabVisibleBookmarkState,
} from '../../lib/tabs';
import type { SelectableDragItem, TreeDropIndicator } from '../types';
import { Favicon, type FaviconAudioStates } from '@hyper/ui';
import { InlineItemTitle } from '@hyper/ui';
import { CreateActionGroup } from './BookmarkMenu';
import { BookmarkSyncButton, type BookmarkSyncAction } from './BookmarkSyncButton';
import { SpaceIndicatorGroup } from './SpaceIndicatorGroup';
import { shouldUseRemoteSpaceAction } from '../lib/spaceIndicatorActions';
import { SortableTree, TreeMotionItem } from './SortableTree';
import { pageIdentity } from '../../lib/urlIdentity';
import type { TabName } from '../../lib/tabBookmarkLink';
import type { HyperRemoteSpacePresence } from '../../lib/modelPort';
import { itemTooltip } from '../lib/itemTooltip';
import { errorMessage } from '../lib/notify';
import {
  BOOKMARK_LABELS,
  clipboardEntries,
  ItemActionsContext,
  itemMenuEntries,
  openTabEntries,
  pasteEntries,
} from '../lib/itemActions';
import { FolderIcon, RowIconButton, TreeRowGuides, useTreeRow, useTreeSurface, type TreeRowDragProps, type TreeSurfaceProps } from './TreeRow';

export const TabActivationVisibilityContext = createContext(true);

/** Keys a tab's row by its tab, so the row stays as the tab gains a bookmark rather than closing while a copy opens. */
function tabRowKey(item: FlattenedTreeItem, tab: BrowserTab | undefined): string {
  return tab?.id === undefined ? item.nodeId : `tab:${tab.id}`;
}

interface TabsProps extends TreeSurfaceProps {
  items: FlattenedTreeItem[];
  nodes: BookmarkNode[];
  rootId: string;
  rootIndex: number;
  tabsByNodeId: Readonly<Record<string, BrowserTab | undefined>>;
  splitRows: SplitRows;
  tabBackingsByTabId: Readonly<Record<number, BookmarkNode | undefined>>;
  /** What the model calls each tab, and the names users gave them. */
  tabNaming: {
    tabNames: Readonly<Record<number, TabName>>;
    tabTitles: Readonly<Record<number, string>>;
  };
  audioStateByTabId: FaviconAudioStates;
  matchingBookmarksByTabId: ReadonlyMap<number, BookmarkNode>;
  /** Which spaces hold this window's pages elsewhere, and how many tabs each space lists in other windows. */
  remoteSpacePresence: Pick<HyperRemoteSpacePresence, 'otherWindowTabCounts' | 'tabSpaceIds'>;
  showDropHint: boolean;
  onCreateFolder: (parentId?: string) => void;
  onEditFolder: (node: BookmarkNode) => void;
  onFocus: (tab: BrowserTab) => void;
  onDuplicate: (tab: BrowserTab) => void;
  onRename: (tab: BrowserTab, title: string) => Promise<void>;
  onCreateBookmark: (tab: BrowserTab) => Promise<void>;
  onRemoveBookmark: (bookmark: BookmarkNode) => Promise<void>;
  onFocusInSpace: (url: string, spaceId: string) => void;
  onFocusRemoteTab: (tabId: number, spaceId: string, moveToCurrentWindow: boolean) => void;
  onCloseInSpace: (tabId: number, spaceId: string) => void;
  onClose: (tabId: number) => void;
  /** Closes tabs a folder holds; `folderTitle` names the folder when the user closed it whole. */
  onCloseFolder: (tabIds: number[], folderTitle?: string) => void;
  onCreate: () => void;
  /** The tabs other sessions keep in this space, below this window's. */
  otherSessions?: ReactNode;
}

type FolderRowProps = TreeRowDragProps & Pick<
  TabsProps,
  | 'collapsedIds'
  | 'dragArmingNodeId'
  | 'onToggleFolder'
  | 'onCreateFolder'
  | 'onCreate'
  | 'onEditFolder'
  | 'onCloseFolder'
> & {
  tabIds: number[];
  duplicateIds: number[];
  dragData: Extract<SelectableDragItem, { kind: 'tab-folder' }>;
};

function FolderRow(props: FolderRowProps) {
  const {
    item,
    collapsedIds,
    dropDisabled,
    dragArmingNodeId,
    dropIndicator,
    onToggleFolder,
    onCreateFolder,
    onCreate,
    onEditFolder,
    onCloseFolder,
    tabIds,
    duplicateIds,
    dragData,
    lifted,
  } = props;
  const { node, depth } = item;
  const title = visibleBookmarkTitle(node) || 'Untitled folder';
  const collapsed = collapsedIds.has(node.id);
  const folderTabCount = descendantCount(node);
  const virtual = isAutoTabFolderId(node.id);
  const [active, setActive] = useState(false);
  const actions = useContext(ItemActionsContext);
  const { dropPosition, handleProps, plainClick, selected, selectionId, sortable, sourceDragging } =
    useTreeRow(props, `tab-folder:${node.id}`, dragData);

  return (
    <TreeMotionItem dragging={sourceDragging} lifted={lifted}>
      <div
        ref={sortable.setNodeRef}
        className={`tree-row tab-folder-row${selected ? ' is-drag-selected' : ''}${sourceDragging ? ' is-dragging' : ''}${dragArmingNodeId === node.id ? ' is-drag-arming' : ''}${dropPosition ? ` drop-${dropPosition}` : ''}${dropPosition && dropIndicator?.invalid ? ' is-invalid-drop' : ''}`}
        style={{ '--tree-depth': depth } as CSSProperties}
        data-tab-node-id={node.id}
        data-drag-selection-id={selectionId}
      >
        <TreeRowGuides depth={depth} dropIndicator={dropIndicator} position={dropPosition} />
        <div className="tab-folder-content">
          <div
            className="tree-item-main folder-item"
            onClick={(event) => {
              const rename = plainClick(event, true);
              if (rename === undefined) return;
              if (!virtual && active && rename) {
                onEditFolder(node);
                return;
              }
              setActive(true);
              onToggleFolder(node.id);
            }}
            onAuxClick={(event) => {
              if (event.button !== 1) return;
              event.preventDefault();
              onCloseFolder(tabIds, title);
            }}
            onMouseDownCapture={(event) => event.button === 1 && event.preventDefault()}
            onContextMenu={(event) => {
              if (!actions) return;
              const items = actions.itemsFor(dragData);
              const single = items.length === 1;
              const closing = actions.tabIdsOf(items);
              actions.openMenu(event, `Actions for ${title}`, itemMenuEntries({
                count: items.length,
                rename: single && !virtual ? () => onEditFolder(node) : undefined,
                ...clipboardEntries(actions, items),
                ...pasteEntries(actions, { folder: item, kind: 'tab-folder' }),
                closeDuplicates: single && duplicateIds.length > 0 ? () => onCloseFolder(duplicateIds) : undefined,
                ...openTabEntries(actions, closing, single ? (ids) => onCloseFolder(ids, title) : undefined),
                remove: items.every((selected) => selected.kind === 'tab-folder' && !selected.virtual)
                  ? { label: single ? 'Remove folder' : `Remove ${items.length} folders`, run: () => actions.removeItems(items) }
                  : undefined,
                spaces: actions.spaceEntries(items),
              }));
            }}
            aria-expanded={!collapsed}
            aria-label={`${title}, ${folderTabCount} tabs`}
            draggable={Boolean(sortable.listeners)}
            {...handleProps}
          >
            <FolderIcon collapsed={collapsed} count={folderTabCount} />
            <span className="tree-title" data-item-title>{title}</span>
          </div>
          {!virtual && (
            <CreateActionGroup
              disabled={dropDisabled}
              buttonClassName="row-icon-button folder-add-button"
              groupLabel={`Create items in ${title}`}
              actions={[
                { icon: SquarePlus, label: `Open new tab in ${title}`, onClick: onCreate },
                { icon: FolderPlus, label: `Create subfolder in ${title}`, onClick: () => onCreateFolder(node.id) },
              ]}
            />
          )}
          {/* Close sits before dedupe so its hover reveal cannot shift the dedupe button. */}
          <RowIconButton
            className="tab-folder-close"
            onClick={() => onCloseFolder(tabIds, title)}
            aria-label={`Close tabs in ${title}`}
            title="Close folder tabs"
          />
          {duplicateIds.length > 0 && (
            <RowIconButton
              className="tab-folder-dedupe"
              onClick={() => onCloseFolder(duplicateIds)}
              aria-label={`Dedupe tabs in ${title}`}
              title="Close duplicate tabs"
            >
              <Broom size={14} aria-hidden="true" />
            </RowIconButton>
          )}
        </div>
      </div>
    </TreeMotionItem>
  );
}

type TabRowProps = TreeRowDragProps & Omit<
  TabsProps,
  | 'items'
  | 'nodes'
  | 'rootId'
  | 'rootIndex'
  | 'tabsByNodeId'
  | 'splitRows'
  | 'collapsedIds'
  | 'showDropHint'
  | 'dragArmingNodeId'
  | 'onToggleFolder'
  | 'onCreateFolder'
  | 'onEditFolder'
  | 'onCloseFolder'
  | 'onCreate'
  | 'onDragSelectionChange'
  | 'dropDisabled'
  | 'draggedNodeId'
  | 'dropIndicator'
  | 'selectedDragItemIds'
  | 'onDragSelectionPointerDown'
> & {
  tab: BrowserTab;
  dragData: Extract<SelectableDragItem, { kind: 'tab' }>;
  /** One pane of a split view's row, which draws the depth and drop lines for both. */
  pane?: boolean;
};

function TabRow(props: TabRowProps) {
  const {
    item,
    tab,
    tabBackingsByTabId,
    tabNaming: { tabNames, tabTitles },
    audioStateByTabId,
    matchingBookmarksByTabId,
    spaces,
    localSpaceIdsByPageIdentity,
    remoteSpacePresence,
    spaceIdsByPageIdentity,
    activeSpaceId,
    foremostPageIdentity,
    foremostSpaceId,
    spaceColours,
    extensionOrigin,
    onFocus,
    onDuplicate,
    onRename,
    onUpdateBookmarkUrl,
    onRevertBookmark,
    onCreateBookmark,
    onRemoveBookmark,
    onInteractionError,
    onFocusInSpace,
    onFocusRemoteTab,
    onCloseInSpace,
    onClose,
    dropIndicator,
    dragData,
    pane = false,
    lifted,
  } = props;
  const showActiveTab = useContext(TabActivationVisibilityContext);
  const actions = useContext(ItemActionsContext);
  const backing = tab.id === undefined ? undefined : tabBackingsByTabId[tab.id];
  const name = tab.id === undefined ? undefined : tabNames[tab.id];
  const title = (tab.id === undefined ? undefined : tabTitles[tab.id]) ?? tabDisplayTitle(tab);
  const rawUrl = tabDisplayUrl(tab);
  const [editingTitle, setEditingTitle] = useState(false);
  const [spacePickerExpanded, setSpacePickerExpanded] = useState(false);
  const url = bookmarkableTabUrl(tab, extensionOrigin) ?? '';
  const matchingBookmark = tab.id === undefined
    ? undefined
    : matchingBookmarksByTabId.get(tab.id);
  const bookmarkState = tabVisibleBookmarkState(matchingBookmark, url);
  const bookmarkAction = bookmarkState === 'bookmarked'
    ? 'remove'
    : bookmarkState === 'update'
      ? 'update'
      : 'create';
  const otherOpenSpaces = spaces.filter(
    (space) => space.id !== activeSpaceId &&
      spaceHasTabUrl(space, rawUrl, spaceIdsByPageIdentity),
  );
  const remoteSpaceIds = tab.id === undefined ? [] : remoteSpacePresence.tabSpaceIds[tab.id] ?? [];
  const localSpaceIds = localSpaceIdsByPageIdentity.get(pageIdentity(rawUrl) ?? '');
  const { dropPosition, handleProps, plainClick, selected, selectionId, sortable, sourceDragging } =
    useTreeRow(props, `tab:${tab.id}`, dragData, { pane });
  const syncBookmark = (action: BookmarkSyncAction) => matchingBookmark?.url && tab.id !== undefined &&
      action === 'revert'
    ? onRevertBookmark(tab.id, matchingBookmark.url)
    : matchingBookmark && action === 'update'
      ? onUpdateBookmarkUrl(matchingBookmark, url)
      : matchingBookmark && action === 'remove'
        ? onRemoveBookmark(matchingBookmark)
        : onCreateBookmark(tab);
  const openMenu = (event: MouseEvent<HTMLElement>) => {
    if (!actions || tab.id === undefined) return;
    const items = actions.itemsFor(dragData);
    const single = items.length === 1;
    const closing = actions.tabIdsOf(items);
    const split = single ? actions.splitBesideCurrentTab(dragData) : undefined;
    actions.openMenu(event, `Actions for ${title}`, itemMenuEntries({
      count: items.length,
      rename: single && backing ? () => setEditingTitle(true) : undefined,
      duplicate: single ? () => onDuplicate(tab) : undefined,
      bookmark: single && url ? {
        kind: bookmarkAction,
        label: BOOKMARK_LABELS[bookmarkAction],
        run: () => void syncBookmark(bookmarkAction).catch((error: unknown) => onInteractionError(
          errorMessage(error, 'The bookmark could not be changed'),
        )),
      } : undefined,
      split: split ? { label: 'Split with current tab', run: split } : undefined,
      ...clipboardEntries(actions, items),
      ...openTabEntries(actions, closing),
      spaces: actions.spaceEntries(items),
    }));
  };

  const row = (
      <div
        ref={sortable.setNodeRef}
        className={`tab-row${pane ? ' is-split-pane' : ''}${showActiveTab && tab.active ? ' is-active' : ''}${selected ? ' is-drag-selected' : ''}${isTabSleeping(tab) ? ' is-sleeping' : ''}${spacePickerExpanded ? ' is-space-picker-expanded' : ''}${sourceDragging ? ' is-dragging' : ''}${lifted ? ' is-lifted' : ''}${dropPosition ? ` drop-${dropPosition}` : ''}`}
        style={pane ? undefined : { '--tree-depth': item.depth } as CSSProperties}
        data-tab-id={tab.id}
        data-tab-node-id={item.nodeId}
        data-drag-selection-id={selectionId}
      >
        <TreeRowGuides depth={item.depth} dropIndicator={dropIndicator} guides={!pane} position={dropPosition} />
        <div className="tab-content">
          <div
            className="tab-main"
            onClick={(event) => {
              const rename = plainClick(event);
              if (rename === undefined) return;
              if (event.altKey) onDuplicate(tab);
              else if (
                backing && tab.active && rename
              ) setEditingTitle(true);
              else onFocus(tab);
            }}
            onAuxClick={(event) => {
              if (event.button !== 1 || tab.id === undefined) return;
              event.preventDefault();
              onClose(tab.id);
            }}
            onMouseDownCapture={(event) => event.button === 1 && event.preventDefault()}
            onContextMenu={openMenu}
            aria-label={`${title}${bookmarkState === 'bookmarked' ? ', bookmarked' : ''}${isTabSleeping(tab) ? ', sleeping' : ''}${tab.audible ? ', playing audio' : ''}`}
            title={itemTooltip(title, rawUrl)}
            data-url={rawUrl || undefined}
            draggable={Boolean(sortable.listeners) && !editingTitle}
            {...handleProps}
          >
            <Favicon
              audioState={tab.id === undefined ? undefined : audioStateByTabId[tab.id]}
              loading={tab.status === 'loading'}
              url={rawUrl}
              title={title}
              sourceUrl={tab.favIconUrl}
            />
            <InlineItemTitle
              allowBlank
              title={editingTitle && name ? name.title : title}
              className="tab-title"
              editing={editingTitle}
              onCancel={() => setEditingTitle(false)}
              onSave={(nextTitle) => onRename(tab, nextTitle)}
              onError={onInteractionError}
            />
          </div>
          {tab.id !== undefined && (
            <RowIconButton
              className="tab-close"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={() => onClose(tab.id as number)}
              aria-label={`Close ${title}`}
              title="Close tab"
            />
          )}
        </div>
        {dropPosition === 'split' && (
          <span className="tab-split-dropzone" aria-hidden="true">
            <Columns2 size={14} />
          </span>
        )}
        {!pane && <SpaceIndicatorGroup
          layoutGroupId={`tab-spaces-${tab.id ?? item.nodeId}`}
          spaces={otherOpenSpaces}
          spaceColours={spaceColours}
          groupLabel="Switch to tab in another space"
          summaryLabel={`Show spaces where ${title} is open`}
          actionLabel={(space) => `Switch to ${title} in ${space.title}`}
          isForemost={(space) => pageIsForemostInSpace(
            rawUrl,
            space.id,
            foremostPageIdentity,
            foremostSpaceId,
          )}
          onExpandedChange={setSpacePickerExpanded}
          onClose={(space) => {
            if (tab.id !== undefined) onCloseInSpace(tab.id, space.id);
          }}
          onSelect={(space, { moveToCurrentWindow }) => {
            if (
              tab.id !== undefined &&
              shouldUseRemoteSpaceAction(remoteSpaceIds, localSpaceIds, space.id)
            ) {
              onFocusRemoteTab(tab.id, space.id, moveToCurrentWindow);
              return;
            }
            onFocusInSpace(rawUrl, space.id);
          }}
        />}
        {!pane && url && !spacePickerExpanded && (
          <BookmarkSyncButton
            action={bookmarkAction}
            itemTitle={title}
            onAction={syncBookmark}
            onError={onInteractionError}
          />
        )}
      </div>
  );
  return pane ? row : <TreeMotionItem dragging={sourceDragging} lifted={lifted}>{row}</TreeMotionItem>;
}

/** A split view's tabs side by side in one row, as the browser shows them. */
function SplitTabRow({
  children,
  depth,
  dropIndicator,
  lifted,
  nodeIds,
}: {
  children: ReactNode;
  depth: number;
  dropIndicator?: TreeDropIndicator;
  lifted: boolean;
  /** The split view folder and its panes, any of which a drop line may name. */
  nodeIds: readonly string[];
}) {
  const position = dropIndicator && nodeIds.includes(dropIndicator.nodeId) &&
    (dropIndicator.position === 'before' || dropIndicator.position === 'after')
    ? dropIndicator.position
    : undefined;
  return (
    <TreeMotionItem lifted={lifted}>
      <div className="tab-split-row" style={{ '--tree-depth': depth } as CSSProperties}>
        <TreeRowGuides depth={depth} dropIndicator={dropIndicator} position={position} />
        <div className="tab-split-panes" role="group" aria-label="Split view">
          {children}
        </div>
      </div>
    </TreeMotionItem>
  );
}

/** The Tabs list's last line, at its very bottom: how many of the space's tabs other windows hold. */
function OtherWindowTabsLine({ count }: { count: number }) {
  if (count <= 0) return null;
  const tabs = count === 1 ? '1 tab' : `${count} tabs`;
  return (
    <p className="tabs-other-windows" title={`${tabs} from this space ${count === 1 ? 'is' : 'are'} open in other windows`}>
      +{count} open in other windows
    </p>
  );
}

export function Tabs(props: TabsProps) {
  const folderTabIds = useMemo(
    () => tabIdsByFolder(props.nodes, props.tabsByNodeId),
    [props.nodes, props.tabsByNodeId],
  );
  const folderDuplicateIds = useMemo(
    () => duplicateTabIdsByFolder(props.nodes, props.tabsByNodeId),
    [props.nodes, props.tabsByNodeId],
  );
  // A split view row's panes stand in for it when dragging and selecting.
  const listedItems = useMemo(
    () => props.items.flatMap((item) => props.splitRows.panesByRowId.get(item.nodeId) ?? [item]),
    [props.items, props.splitRows],
  );
  const orderedDragItems = useMemo<SelectableDragItem[]>(() => listedItems.flatMap(
    (item): SelectableDragItem[] => {
    if (item.isFolder) {
      const title = visibleBookmarkTitle(item.node) || 'Untitled folder';
      return [{
        kind: 'tab-folder' as const,
        nodeId: item.node.id,
        title,
        parentId: item.parentId,
        index: item.index,
        depth: item.depth,
        ancestorIds: item.ancestorIds,
        itemCount: 1 + descendantItemCount(item.node),
        ...(isAutoTabFolderId(item.node.id) ? { virtual: true } : {}),
      }];
    }
    const tab = props.tabsByNodeId[item.nodeId];
    if (tab?.id === undefined) return [];
    const backing = props.tabBackingsByTabId[tab.id];
    const title = props.tabNaming.tabTitles[tab.id] ?? tabDisplayTitle(tab);
    return [{
      kind: 'tab' as const,
      tabId: tab.id,
      title,
      windowId: tab.windowId,
      index: tab.index,
      bookmarkable: Boolean(bookmarkableTabUrl(tab, props.extensionOrigin)),
      nodeId: item.nodeId,
      ...(backing ? { backingId: backing.id } : {}),
      parentId: item.parentId,
      treeIndex: item.index,
      depth: item.depth,
      ancestorIds: item.ancestorIds,
      itemCount: 1,
    }];
    },
  ), [
    listedItems,
    props.extensionOrigin,
    props.tabBackingsByTabId,
    props.tabNaming,
    props.tabsByNodeId,
  ]);
  const surface = useTreeSurface({
    collapsedIds: props.collapsedIds,
    draggedNodeId: props.draggedNodeId,
    listedItems,
    nodeAttribute: 'data-tab-node-id',
    onDragSelectionChange: props.onDragSelectionChange,
    onToggle: props.onToggleFolder,
    orderedDragItems,
    pasteKind: 'tab-folder',
    selectedDragItemIds: props.selectedDragItemIds,
  });
  const { dragItemsByNodeId } = surface;
  const tabRow = (item: FlattenedTreeItem, pane = false) => (
    <TabRow
      {...props}
      key={tabRowKey(item, props.tabsByNodeId[item.nodeId])}
      item={item}
      pane={pane}
      tab={props.tabsByNodeId[item.nodeId] as BrowserTab}
      dragData={dragItemsByNodeId.get(item.nodeId) as Extract<SelectableDragItem, { kind: 'tab' }>}
      orderedDragItems={orderedDragItems}
      lifted={surface.lifted(item)}
    />
  );
  const splitRow = (item: FlattenedTreeItem, panes: readonly FlattenedTreeItem[]) => (
    <SplitTabRow
      key={`split:${item.nodeId}`}
      depth={item.depth}
      dropIndicator={props.dropIndicator}
      lifted={surface.lifted(item) || panes.every((pane) =>
        pane.nodeId === props.draggedNodeId || surface.lifted(pane))}
      nodeIds={[item.nodeId, ...panes.map((pane) => pane.nodeId)]}
    >
      {panes.map((pane) => tabRow(pane, true))}
    </SplitTabRow>
  );

  return (
    <section
      id="workspace-panel-tabs"
      className="tabs-section workspace-view-panel"
      role="tabpanel"
      aria-labelledby="workspace-tab-tabs"
    >
      <div
        {...surface.surfaceProps('tabs-tree-container')}
        onMouseDownCapture={(event) => {
          if (event.button === 1) event.preventDefault();
        }}
        onDoubleClick={(event) => {
          if (
            event.target instanceof Element &&
            event.target.closest('.tab-row, .tab-folder-row, .other-session, button')
          ) return;
          props.onCreate();
        }}
      >
        <SortableTree
          after={(
            <>
              {props.otherSessions}
              <OtherWindowTabsLine count={props.remoteSpacePresence.otherWindowTabCounts[props.activeSpaceId] ?? 0} />
            </>
          )}
          disabled={props.dropDisabled}
          itemIds={listedItems.flatMap((item) => {
            if (item.isFolder) return [`tab-folder:${item.nodeId}`];
            const tab = props.tabsByNodeId[item.nodeId];
            return tab?.id === undefined ? [] : [`tab:${tab.id}`];
          })}
          listClassName="tabs-list tree-list"
          motionDisabled={Boolean(props.draggedNodeId)}
          rootId={props.rootId}
          rootIndex={props.rootIndex}
          zoneClassName="tabs-drop-zone"
          zoneKind="tabs-zone"
          empty={props.showDropHint
            ? <div className="tabs-drop-hint">Drop to keep as an open tab</div>
            : null}
        >
          {props.items.map((item) => item.isFolder ? (
            <FolderRow
              {...props}
              key={item.nodeId}
              item={item}
              dragData={dragItemsByNodeId.get(item.nodeId) as Extract<SelectableDragItem, { kind: 'tab-folder' }>}
              orderedDragItems={orderedDragItems}
              tabIds={folderTabIds[item.nodeId] ?? []}
              duplicateIds={folderDuplicateIds[item.nodeId] ?? []}
              lifted={surface.lifted(item)}
            />
          ) : props.splitRows.panesByRowId.has(item.nodeId) ? (
            splitRow(item, props.splitRows.panesByRowId.get(item.nodeId) ?? [])
          ) : props.tabsByNodeId[item.nodeId] ? tabRow(item) : null)}
        </SortableTree>
        {surface.marqueeOverlay}
      </div>
    </section>
  );
}