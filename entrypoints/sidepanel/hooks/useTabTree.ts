import { useEffect, useMemo, useRef } from 'react';
import {
  deriveSpaceTabs,
  deriveWindowSpaceTabTree,
  findBookmarkPathByUrl,
  indexTabsByPageIdentity,
  type BookmarkNode,
  type BrowserTab,
  type Space,
} from '../../lib/bookmarks';
import { flattenVisibleTree } from '../lib/drag';
import { splitViewRows } from '../lib/splitRows';
import {
  autoTabFolderIdentity,
  projectAutoTabFolders,
  realAutoTabFolderDestination,
  settleAutoTabFolderIdentities,
  type AutoTabFolderIdentity,
} from '../../lib/autoTabFolders';
import { tabIdsByFolder } from '../lib/tabFolders';
import type { useBrowserState } from './useBrowserState';
import { tabUrl } from '../../lib/urlIdentity';

const EMPTY_AUTO_TAB_IDENTITIES = new Map<number, AutoTabFolderIdentity>();

type BrowserStateApi = ReturnType<typeof useBrowserState>;

export function useTabTree({
  activeSpace,
  autofolders,
  browserState,
  collapsedIds,
  compactCombinedWorkspace,
  nodeMap,
  visibleTree,
}: {
  activeSpace: Space | undefined;
  autofolders: boolean;
  browserState: BrowserStateApi;
  collapsedIds: Set<string>;
  compactCombinedWorkspace: boolean;
  nodeMap: ReadonlyMap<string, BookmarkNode>;
  visibleTree: BookmarkNode[];
}) {
  const settledAutoTabFolderIdentitiesRef = useRef(
    new Map<number, AutoTabFolderIdentity>(),
  );
  const spaceTabs = useMemo(
    () => deriveSpaceTabs(
      browserState.tabs,
      browserState.currentWindowId,
      browserState.activeGroupId,
      activeSpace?.id,
      browserState.tabSpaceIds,
    ),
    [
      activeSpace?.id,
      browserState.activeGroupId,
      browserState.currentWindowId,
      browserState.tabSpaceIds,
      browserState.tabs,
    ],
  );
  const displayedSpaceTabs = useMemo(
    () => compactCombinedWorkspace
      ? spaceTabs.filter((tab) => !findBookmarkPathByUrl(
          visibleTree,
          tabUrl(tab),
        ))
      : spaceTabs,
    [compactCombinedWorkspace, spaceTabs, visibleTree],
  );
  // The model decides which bookmark each tab shows, so the link outlives this view.
  const matchingBookmarksByTabId = useMemo(() => new Map(
    spaceTabs.flatMap((tab) => {
      const link = tab.id === undefined ? undefined : browserState.tabBookmarkLinks[tab.id];
      const bookmark = link && nodeMap.get(link.bookmarkId);
      return bookmark ? [[tab.id as number, bookmark] as const] : [];
    }),
  ), [browserState.tabBookmarkLinks, nodeMap, spaceTabs]);
  const matchingTabsByBookmarkId = useMemo(() => {
    const tabsByBookmarkId = new Map<string, BrowserTab[]>();
    for (const tab of spaceTabs) {
      if (tab.id === undefined) continue;
      const bookmark = matchingBookmarksByTabId.get(tab.id);
      if (!bookmark) continue;
      const matches = tabsByBookmarkId.get(bookmark.id);
      if (matches) matches.push(tab);
      else tabsByBookmarkId.set(bookmark.id, [tab]);
    }
    return tabsByBookmarkId;
  }, [matchingBookmarksByTabId, spaceTabs]);
  const settledAutoTabFolderIdentities = useMemo(
    () => autofolders
      ? settleAutoTabFolderIdentities(
          browserState.tabs,
          settledAutoTabFolderIdentitiesRef.current,
        )
      : EMPTY_AUTO_TAB_IDENTITIES,
    [browserState.tabs, autofolders],
  );
  useEffect(() => {
    settledAutoTabFolderIdentitiesRef.current = settledAutoTabFolderIdentities;
  }, [settledAutoTabFolderIdentities]);
  const tabTree = useMemo(() => deriveWindowSpaceTabTree(
    browserState.bookmarkTree,
    activeSpace?.id,
    new Set(displayedSpaceTabs.flatMap((tab) => {
      const backingId = tab.id === undefined
        ? undefined
        : browserState.tabBackingIds[tab.id];
      return backingId ? [backingId] : [];
    })),
  ), [
    activeSpace?.id,
    browserState.bookmarkTree,
    browserState.tabBackingIds,
    displayedSpaceTabs,
  ]);
  const tabTreeRootId = tabTree.rootId ?? `tabs:${activeSpace?.id ?? 'none'}`;
  const {
    autoTabFolderTree,
    tabTreeItems: treeItems,
    tabTreeNodes,
    tabsByNodeId,
  } = useMemo(() => {
    const byNodeId: Record<string, Browser.tabs.Tab> = {};
    const unsupportedNodes: Browser.bookmarks.BookmarkTreeNode[] = [];
    displayedSpaceTabs.forEach((tab, index) => {
      const backingId = tab.id === undefined
        ? undefined
        : browserState.tabBackingIds[tab.id];
      if (backingId) byNodeId[backingId] = tab;
      if (backingId && nodeMap.has(backingId)) return;
      const node = {
        id: `unsupported-tab:${tab.id ?? index}`,
        title: tab.title ?? tabUrl(tab) ?? 'Untitled tab',
        url: tabUrl(tab),
        parentId: tabTreeRootId,
        index,
        syncing: false,
      };
      byNodeId[node.id] = tab;
      unsupportedNodes.push(node);
    });
    if (autofolders) {
      const tree = projectAutoTabFolders(
        [...tabTree.nodes, ...unsupportedNodes],
        tabTreeRootId,
        (node) => {
          const tab = byNodeId[node.id];
          if (!tab) return undefined;
          return (tab.id === undefined ? undefined : settledAutoTabFolderIdentities.get(tab.id)) ??
            autoTabFolderIdentity(tab);
        },
      );
      return {
        autoTabFolderTree: tree,
        tabTreeNodes: tree.nodes,
        tabTreeItems: flattenVisibleTree(tree.nodes, tabTreeRootId, collapsedIds, false),
        tabsByNodeId: byNodeId,
      };
    }
    const visible = flattenVisibleTree(
      tabTree.nodes,
      tabTreeRootId,
      collapsedIds,
      false,
    );
    return {
      autoTabFolderTree: undefined,
      tabTreeNodes: [...tabTree.nodes, ...unsupportedNodes],
      tabTreeItems: [
        ...visible,
        ...unsupportedNodes.map((node, index) => ({
          node,
          nodeId: node.id,
          parentId: tabTreeRootId,
          index: tabTree.nodes.length + index,
          depth: 0,
          isFolder: false,
          ancestorIds: [],
        })),
      ],
      tabsByNodeId: byNodeId,
    };
  }, [
    browserState.tabBackingIds,
    collapsedIds,
    nodeMap,
    displayedSpaceTabs,
    settledAutoTabFolderIdentities,
    autofolders,
    tabTree.nodes,
    tabTreeRootId,
  ]);
  const { items: tabTreeItems, rows: splitRows } = useMemo(
    () => splitViewRows(treeItems, tabsByNodeId, browserState.commandCapabilities.splitViewTabs),
    [browserState.commandCapabilities.splitViewTabs, tabsByNodeId, treeItems],
  );
  const tabTreeRealIndexes = () => new Map(tabTree.nodes.flatMap((node) =>
    node.index === undefined ? [] : [[node.id, node.index] as const]));
  const realTabTreeDestination = (destination: { parentId: string; index?: number }) => autoTabFolderTree
    ? realAutoTabFolderDestination(autoTabFolderTree, tabTreeRootId, tabTreeRealIndexes(), destination)
    : destination;
  const moveTabTreeNodes = (
    nodeIds: readonly string[],
    destination: { parentId: string; index?: number },
  ) => {
    if (!activeSpace) return Promise.resolve();
    const realIndexById = tabTreeRealIndexes();
    const realNodeIds = nodeIds.flatMap((nodeId) =>
      autoTabFolderTree?.memberIdsByFolderId.get(nodeId)
        ?.filter((memberId) => realIndexById.has(memberId)) ?? [nodeId]);
    if (realNodeIds.length === 0) return Promise.resolve();
    return browserState.moveTabTreeNode(activeSpace.id, realNodeIds, realTabTreeDestination(destination));
  };
  const activeSpaceTabsByPageIdentity = useMemo(
    () => indexTabsByPageIdentity(spaceTabs),
    [spaceTabs],
  );
  const tabIdsByFolderId = useMemo(
    () => tabIdsByFolder(tabTreeNodes, tabsByNodeId),
    [tabTreeNodes, tabsByNodeId],
  );
  const openTabFolderIds = useMemo(
    () => Object.entries(tabIdsByFolderId).flatMap(([folderId, tabIds]) =>
      tabIds.length > 0 ? [folderId] : []),
    [tabIdsByFolderId],
  );

  return {
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
  };
}
