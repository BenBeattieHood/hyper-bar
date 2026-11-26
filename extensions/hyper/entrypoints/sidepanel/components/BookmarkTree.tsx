import {
  AnimatePresence,
  motion,
  useReducedMotion,
} from 'motion/react';
import {
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
} from 'react';
import {
  Favicon,
  faviconLoadingForTabs,
  type FaviconAudioState,
} from '@hyper/ui';
import { pageIdentity } from '../../lib/urlIdentity';
import { shortcutLabel } from '../../lib/shortcuts';
import { InlineItemTitle } from '@hyper/ui';
import { BookmarkCreateActions, BookmarkImportMenu } from './BookmarkMenu';
import { BookmarkSyncButton } from './BookmarkSyncButton';
import { SpaceIndicatorGroup } from './SpaceIndicatorGroup';
import { shouldUseRemoteSpaceAction } from '../lib/spaceIndicatorActions';
import {
  bestTabFaviconUrl,
  bookmarkableTabUrl,
  bookmarkNodeIdForPage,
  bookmarkTabStatus,
  collectUniqueBookmarkUrls,
  descendantItemCount,
  pageIsForemostInSpace,
  spaceHasTabUrl,
  summariseBookmarkFolders,
  visibleBookmarkTitle,
  type BookmarkFolderSummary,
  type BookmarkNode,
  type BookmarkFolderOption,
  type TabIdentityIndex,
} from '../../lib/bookmarks';
import { tabVisibleBookmarkState } from '../../lib/tabs';
import type { FlattenedTreeItem } from '../lib/drag';
import { itemTooltip } from '../lib/itemTooltip';
import { clipboardEntries, ItemActionsContext, itemMenuEntries, openTabEntries, pasteEntries } from '../lib/itemActions';
import type { SelectableDragItem } from '../types';
import { dragSelectionId } from '../lib/dragSelection';
import { SortableTree, TREE_ITEM_TWEEN_DURATION_MS, TreeMotionItem } from './SortableTree';
import { FolderIcon, RowIconButton, TreeRowGuides, useTreeRow, useTreeSurface, type TreeSurfaceProps } from './TreeRow';
import { slideMotion, spaceSlideVariants } from './WorkspaceMotion';

interface BookmarkTreeProps extends TreeSurfaceProps {
  nodes: BookmarkNode[];
  items: FlattenedTreeItem[];
  slideDirection?: -1 | 1;
  rootId: string;
  tabsByPageIdentity: TabIdentityIndex;
  allTabsByPageIdentity: TabIdentityIndex;
  matchingTabsByBookmarkId: ReadonlyMap<string, readonly Browser.tabs.Tab[]>;
  audioStateByPageIdentity: ReadonlyMap<string, FaviconAudioState>;
  remoteSpaceIdsByBookmarkId: Readonly<Record<string, readonly string[]>>;
  onOpen: (url: string, forceNew: boolean) => void;
  onOpenInSpace: (url: string, spaceId: string) => void;
  onOpenRemoteInSpace: (
    bookmarkId: string,
    spaceId: string,
    moveToCurrentWindow: boolean,
  ) => void;
  /** Closes the bookmark's page wherever that space has it open. */
  onCloseInSpace: (bookmarkId: string, spaceId: string) => void;
  onAddFolder: (parentId: string) => void;
  onAddCurrentTab: (parentId: string) => void;
  importFolders: BookmarkFolderOption[];
  onImportFolder: (folderId: string) => void;
  onRenameTitle: (node: BookmarkNode, title: string) => Promise<void>;
  onCloseTabs: (tabIds: number[]) => void;
}

const bookmarkRowTitle = (node: BookmarkNode) => visibleBookmarkTitle(node) || node.url || 'Untitled folder';
const folderToggleSettleDelay = TREE_ITEM_TWEEN_DURATION_MS + 32;

interface PendingFolderToggle {
  queued: boolean;
  timeout: number;
}

interface TreeNodeProps extends Omit<BookmarkTreeProps, 'nodes' | 'items'> {
  item: FlattenedTreeItem;
  activeNodeId?: string;
  selectedNodeId?: string;
  onActivateNode: (nodeId: string) => void;
  dragData: Extract<SelectableDragItem, { kind: 'tree' }>;
  orderedDragItems: readonly SelectableDragItem[];
  lifted: boolean;
  folderSummary: BookmarkFolderSummary | undefined;
}

function TreeNode(props: TreeNodeProps) {
  const {
    item,
    folderSummary,
    activeNodeId,
    selectedNodeId,
    onActivateNode,
    tabsByPageIdentity,
    allTabsByPageIdentity,
    matchingTabsByBookmarkId,
    audioStateByPageIdentity,
    spaces,
    localSpaceIdsByPageIdentity,
    remoteSpaceIdsByBookmarkId,
    spaceIdsByPageIdentity,
    activeSpaceId,
    extensionOrigin,
    foremostPageIdentity,
    foremostSpaceId,
    spaceColours,
    collapsedIds,
    dropDisabled,
    dragArmingNodeId,
    dropIndicator,
    onToggleFolder,
    onOpen,
    onOpenInSpace,
    onOpenRemoteInSpace,
    onCloseInSpace,
    onAddFolder,
    onAddCurrentTab,
    onRenameTitle,
    onUpdateBookmarkUrl,
    onRevertBookmark,
    onCloseTabs,
    onInteractionError,
    dragData,
    lifted,
  } = props;
  const { node, depth, isFolder } = item;
  const title = bookmarkRowTitle(node);
  const collapsed = collapsedIds.has(node.id);
  const [editingTitle, setEditingTitle] = useState(false);
  const [spacePickerExpanded, setSpacePickerExpanded] = useState(false);
  const actions = useContext(ItemActionsContext);
  const { dropPosition, plainClick, handleProps, selected, selectionId, sortable, sourceDragging } = useTreeRow(
    props,
    `tree:${node.id}`,
    dragData,
    { locked: node.unmodifiable === 'managed' },
  );
  const { openTabs, isSleeping } = isFolder
    ? { openTabs: [], isSleeping: false }
    : bookmarkTabStatus(tabsByPageIdentity, node.url);
  const allOpenTabs = isFolder
    ? []
    : bookmarkTabStatus(allTabsByPageIdentity, node.url).openTabs;
  const matchingTabs = isFolder
    ? []
    : matchingTabsByBookmarkId.get(node.id) ?? [];
  const matchingTab = matchingTabs.find((tab) => tab.active) ?? matchingTabs[0];
  const matchingTabUrl = matchingTab
    ? bookmarkableTabUrl(matchingTab, extensionOrigin)
    : null;
  const matchingState = isFolder || !matchingTab
    ? 'none'
    : tabVisibleBookmarkState(node, matchingTabUrl ?? undefined);
  const bookmarkSyncAction = matchingState === 'update'
    ? 'update'
    : openTabs.length > 0
      ? 'open'
      : undefined;
  const folderHasOpenTab = folderSummary?.hasOpenTab ?? false;
  const identity = isFolder ? undefined : pageIdentity(node.url);
  const audioState = identity
    ? audioStateByPageIdentity.get(identity)
    : undefined;
  const isForemost = node.id === selectedNodeId || (
    !isFolder && node.id === activeNodeId && openTabs.some((tab) => tab.active)
  );
  const openSpaces = isFolder
    ? []
    : spaces.filter((space) => spaceHasTabUrl(
        space,
        node.url,
        spaceIdsByPageIdentity,
      ));
  const openInCurrentSpace = openTabs.length > 0 || openSpaces.some(
    (space) => space.id === activeSpaceId,
  );
  const otherOpenSpaces = openSpaces.filter((space) => space.id !== activeSpaceId);
  const remoteSpaceIds = remoteSpaceIdsByBookmarkId[node.id] ?? [];
  const style = {
    '--tree-depth': depth,
    '--bookmark-open-colour': spaceColours[activeSpaceId],
  } as CSSProperties;
  const open = (event: MouseEvent<HTMLElement>) => {
    if (node.url) onOpen(node.url, event.altKey);
  };
  const openMenu = (event: MouseEvent<HTMLElement>) => {
    if (!actions) return;
    const items = actions.itemsFor(dragData);
    const single = items.length === 1;
    const split = single ? actions.splitBesideCurrentTab(dragData) : undefined;
    const closing = !single ? [] : (isFolder
      ? collectUniqueBookmarkUrls(node).flatMap((url) => tabsByPageIdentity.get(pageIdentity(url) ?? '') ?? [])
      : allOpenTabs).flatMap((tab) => tab.id === undefined ? [] : [tab.id]);
    actions.openMenu(event, `Actions for ${title}`, itemMenuEntries({
      count: items.length,
      rename: !single ? undefined : isFolder ? () => actions.editBookmark(node.id) : () => setEditingTitle(true),
      renameKey: shortcutLabel('renameItem'),
      duplicate: single && !isFolder ? () => actions.duplicateBookmark(node.id) : undefined,
      split: split ? { label: 'Open beside current tab', run: split } : undefined,
      ...clipboardEntries(actions, items),
      ...(isFolder ? pasteEntries(actions, { folder: item, kind: 'bookmark-folder' }) : {}),
      ...openTabEntries(actions, closing, onCloseTabs),
      remove: {
        label: !single ? `Remove ${items.length} items` : isFolder ? 'Remove folder' : 'Remove bookmark',
        run: () => single ? actions.deleteBookmark(node.id) : actions.removeItems(items),
      },
      spaces: actions.spaceEntries(items),
    }));
  };
  const activate = (event: MouseEvent<HTMLElement>) => {
    const rename = plainClick(event);
    if (rename === undefined) return;
    if (!isFolder && (activeNodeId === node.id || isForemost) && rename) {
      setEditingTitle(true);
      return;
    }
    onActivateNode(node.id);
    if (isFolder) {
      onToggleFolder(node.id);
    } else {
      open(event);
    }
  };

  return (
    <TreeMotionItem dragging={sourceDragging} lifted={lifted} exitDisabled={depth === 0}>
      <div
        ref={sortable.setNodeRef}
        className={`tree-row${openInCurrentSpace ? ' is-open' : ''}${isForemost ? ' is-foremost' : ''}${selected ? ' is-drag-selected' : ''}${sourceDragging ? ' is-dragging' : ''}${dragArmingNodeId === node.id ? ' is-drag-arming' : ''}${dropPosition ? ` drop-${dropPosition}` : ''}${dropPosition && dropIndicator?.invalid ? ' is-invalid-drop' : ''}`}
        style={style}
        data-bookmark-node-id={node.id}
        data-drag-selection-id={selectionId}
      >
        <TreeRowGuides depth={depth} dropIndicator={dropIndicator} position={dropPosition} />
        <div className="tree-item-surface">
          <div
            className={`tree-item-main ${isFolder ? 'folder-item' : 'bookmark-item'}`}
            onClick={activate}
            onContextMenu={openMenu}
            aria-expanded={isFolder ? !collapsed : undefined}
            aria-label={`${title}${folderHasOpenTab ? ', contains bookmarks open as tabs' : ''}${openInCurrentSpace ? ', open in current space' : ''}${openTabs.length > 1 ? ` in ${openTabs.length} tabs` : ''}${isSleeping ? ', sleeping' : ''}`}
            title={isFolder ? undefined : itemTooltip(title, node.url)}
            data-url={node.url}
            draggable={Boolean(sortable.listeners) && !editingTitle}
            {...handleProps}
          >
          {isFolder ? (
            <FolderIcon collapsed={collapsed} count={folderSummary?.bookmarkCount ?? 0} />
          ) : (
            <Favicon
              audioState={audioState}
              loading={faviconLoadingForTabs(openTabs)}
              url={node.url ?? ''}
              title={title}
              sourceUrl={bestTabFaviconUrl(openTabs)}
            />
          )}
          <InlineItemTitle
            allowBlank
            title={title}
            className="tree-title"
            editing={!isFolder && editingTitle}
            onCancel={() => setEditingTitle(false)}
            onSave={(nextTitle) => onRenameTitle(node, nextTitle)}
            onError={onInteractionError}
          />
          {isFolder && collapsed && folderHasOpenTab && (
            <span
              className="folder-open-tab-indicator"
              title="Contains bookmarks open as tabs"
              aria-hidden="true"
            >
              <span className="bookmark-space-indicator" />
            </span>
          )}
          </div>
          {!isFolder && allOpenTabs.length > 0 && (
            <RowIconButton
              className="bookmark-close"
              onPointerDown={(event) => event.stopPropagation()}
              onKeyDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                onCloseTabs(allOpenTabs.flatMap((tab) =>
                  tab.id === undefined ? [] : [tab.id]));
              }}
              aria-label={`${allOpenTabs.length === 1 ? 'Close tab for' : 'Close tabs for'} ${title}`}
              title={allOpenTabs.length === 1 ? 'Close tab' : 'Close tabs'}
            />
          )}
        </div>
        {!isFolder && (
          <SpaceIndicatorGroup
            spaces={otherOpenSpaces}
            spaceColours={spaceColours}
            groupLabel="Open in other spaces"
            summaryLabel={`Show spaces where ${title} is open`}
            actionLabel={(space) => `Open ${title} in ${space.title}`}
            isForemost={(space) => pageIsForemostInSpace(
              node.url,
              space.id,
              foremostPageIdentity,
              foremostSpaceId,
            )}
            onSelect={(space, { moveToCurrentWindow }) => {
              if (!node.url) return;
              if (
                shouldUseRemoteSpaceAction(
                  remoteSpaceIds,
                  localSpaceIdsByPageIdentity.get(pageIdentity(node.url) ?? ''),
                  space.id,
                )
              ) {
                onOpenRemoteInSpace(node.id, space.id, moveToCurrentWindow);
                return;
              }
              onOpenInSpace(node.url, space.id);
            }}
            onClose={(space) => onCloseInSpace(node.id, space.id)}
            onExpandedChange={setSpacePickerExpanded}
          />
        )}
        {!isFolder && bookmarkSyncAction && !spacePickerExpanded && (
          <BookmarkSyncButton
            action={bookmarkSyncAction}
            itemTitle={title}
            onAction={(action) => {
              if (action === 'open' && node.url) {
                onOpen(node.url, false);
                return;
              }
              if (action === 'update' && matchingTabUrl) {
                return onUpdateBookmarkUrl(node, matchingTabUrl);
              }
              if (
                action === 'revert' &&
                matchingTab?.id !== undefined &&
                node.url
              ) {
                return onRevertBookmark(matchingTab.id, node.url);
              }
            }}
            onError={onInteractionError}
          />
        )}
        {isFolder && (
          <BookmarkCreateActions
            disabled={dropDisabled}
            buttonClassName="row-icon-button folder-add-button"
            groupLabel={`Create items in ${title}`}
            bookmarkLabel={`Bookmark current tab in ${title}`}
            folderLabel={`Create subfolder in ${title}`}
            folderFirst
            onCreateFolder={() => onAddFolder(node.id)}
            onAddCurrentTab={() => onAddCurrentTab(node.id)}
            showFolder={!collapsed}
          />
        )}
      </div>
    </TreeMotionItem>
  );
}

export function BookmarkTree(props: BookmarkTreeProps) {
  const [activeNodeId, setActiveNodeId] = useState<string>();
  const pendingFolderToggles = useRef(new Map<string, PendingFolderToggle>());
  const reduceMotion = useReducedMotion();
  const {
    items,
    nodes,
    slideDirection = 1,
    ...treeProps
  } = props;
  const orderedDragItems = useMemo(() => items.map((item) => ({
    kind: 'tree' as const,
    nodeId: item.node.id,
    title: bookmarkRowTitle(item.node),
    parentId: item.parentId,
    index: item.index,
    depth: item.depth,
    isFolder: item.isFolder,
    ancestorIds: item.ancestorIds,
    itemCount: item.isFolder ? 1 + descendantItemCount(item.node) : 1,
  })), [items]);
  const folderSummaries = useMemo(() => summariseBookmarkFolders(
    items.flatMap((item) => item.isFolder ? [item.node] : []),
    props.tabsByPageIdentity,
  ), [items, props.tabsByPageIdentity]);
  const selectedDragItems = orderedDragItems.filter((item) =>
    props.selectedDragItemIds.has(dragSelectionId(item)));
  const preferredNodeId = activeNodeId ?? (
    selectedDragItems.length === 1 ? selectedDragItems[0]?.nodeId : undefined
  );
  const matchingNodeId = bookmarkNodeIdForPage(
    nodes,
    props.foremostPageIdentity,
    preferredNodeId,
  );
  const selectedNodeId = props.foremostPageIdentity === undefined
    ? activeNodeId
    : props.foremostSpaceId === props.activeSpaceId
      ? matchingNodeId
      : matchingNodeId === preferredNodeId
        ? preferredNodeId
        : undefined;
  useEffect(() => () => {
    for (const pending of pendingFolderToggles.current.values()) {
      window.clearTimeout(pending.timeout);
    }
    pendingFolderToggles.current.clear();
  }, []);
  const finishFolderToggle = (id: string, pending: PendingFolderToggle) => {
    if (!pending.queued) {
      pendingFolderToggles.current.delete(id);
      return;
    }
    pending.queued = false;
    props.onToggleFolder(id);
    pending.timeout = window.setTimeout(
      () => finishFolderToggle(id, pending),
      folderToggleSettleDelay,
    );
  };
  const toggleFolder = (id: string) => {
    if (reduceMotion) {
      props.onToggleFolder(id);
      return;
    }
    const pending = pendingFolderToggles.current.get(id);
    if (pending) {
      pending.queued = !pending.queued;
      return;
    }
    const nextPending: PendingFolderToggle = { queued: false, timeout: 0 };
    pendingFolderToggles.current.set(id, nextPending);
    props.onToggleFolder(id);
    nextPending.timeout = window.setTimeout(
      () => finishFolderToggle(id, nextPending),
      folderToggleSettleDelay,
    );
  };
  const surface = useTreeSurface({
    collapsedIds: props.collapsedIds,
    draggedNodeId: props.draggedNodeId,
    listedItems: items,
    nodeAttribute: 'data-bookmark-node-id',
    onDragSelectionChange: props.onDragSelectionChange,
    onToggle: toggleFolder,
    orderedDragItems,
    pasteKind: 'bookmark-folder',
    selectedDragItemIds: props.selectedDragItemIds,
  });

  const empty = (
    <div className="empty-tree">
      <span className="empty-tree-message" role="status">No bookmarks found</span>
      <BookmarkImportMenu
        disabled={props.dropDisabled}
        folders={props.importFolders}
        onImport={props.onImportFolder}
        variant="empty"
      />
    </div>
  );
  const renderItems = (treeItems: FlattenedTreeItem[]) => treeItems.map((item) => (
    <TreeNode
      key={item.nodeId}
      {...treeProps}
      item={item}
      folderSummary={folderSummaries.get(item.nodeId)}
      dragData={surface.dragItemsByNodeId.get(item.nodeId) as Extract<SelectableDragItem, { kind: 'tree' }>}
      orderedDragItems={orderedDragItems}
      activeNodeId={preferredNodeId}
      selectedNodeId={selectedNodeId}
      onActivateNode={setActiveNodeId}
      onToggleFolder={toggleFolder}
      lifted={surface.lifted(item)}
    />
  ));

  return (
    <div {...surface.surfaceProps('bookmark-tree-stack')}>
      <AnimatePresence initial={false} custom={slideDirection} mode="popLayout">
        <motion.div
          key={props.rootId}
          className="space-bookmarks-layer"
          custom={slideDirection}
          variants={spaceSlideVariants}
          animate="center"
          {...slideMotion(reduceMotion)}
          data-space-bookmarks-root-id={props.rootId}
        >
          <SortableTree
            disabled={props.dropDisabled}
            itemIds={items.map((item) => `tree:${item.nodeId}`)}
            motionDisabled={Boolean(props.draggedNodeId)}
            rootId={props.rootId}
            rootIndex={nodes.length}
            empty={items.length === 0 ? empty : null}
          >
            {renderItems(items)}
          </SortableTree>
        </motion.div>
      </AnimatePresence>
      {surface.marqueeOverlay}
    </div>
  );
}