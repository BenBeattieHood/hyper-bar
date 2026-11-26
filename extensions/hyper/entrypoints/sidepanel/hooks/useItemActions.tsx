import { useMemo, useRef, type ReactNode } from 'react';
import type { BookmarkNode, BrowserTab, Space } from '../../lib/bookmarks';
import type { SearchItem } from '../../lib/search';
import { contextMenuAnchor, useContextMenu, type ContextMenuEntry } from '../components/ContextMenu';
import type { useBrowserState } from './useBrowserState';
import {
  hyperClipboard,
  itemLocator,
  planPaste,
  searchItemEntry,
  type ClipboardSurroundings,
  type PastePlan,
  type PasteTarget,
} from '../lib/clipboardItems';
import { errorMessage, type Notify } from '../lib/notify';
import { dragSelectionId, topLevelDragSelection, type DragSelectionState } from '../lib/dragSelection';
import type { DropRequest } from '../lib/dropActions';
import { readClipboard, writeClipboard } from '../lib/itemClipboard';
import { carryOutPagePlan } from '../lib/pagePlans';
import {
  BOOKMARK_LABELS,
  clipboardEntries,
  itemMenuEntries,
  openTabEntries,
  pasteEntries,
  type ItemActions,
} from '../lib/itemActions';
import { splitBeside, type SplitRows } from '../lib/splitRows';
import type { DragItemData, SelectableDragItem } from '../types';

type BrowserStateApi = ReturnType<typeof useBrowserState>;

export interface ItemActionDependencies {
  activeSpace?: Space;
  /** The window's current tab, which a split shows a row beside. */
  activeTab?: BrowserTab;
  /** Bookmarks a tab in the active space, as its row's bookmark button does. */
  bookmarkTab(tab: BrowserTab): Promise<void>;
  browserState: Pick<
    BrowserStateApi,
    | 'closeTabs'
    | 'commandCapabilities'
    | 'copyBookmark'
    | 'currentWindowId'
    | 'duplicateTab'
    | 'favouritesFolderId'
    | 'installationId'
    | 'moveTabsIntoTree'
    | 'reloadTabs'
    | 'removeBookmark'
    | 'runBackingOperation'
    | 'splitTab'
    | 'submitSelection'
    | 'tabBackingIds'
    | 'tabs'
  >;
  deleteNode(node: BookmarkNode): void;
  dragSelection(): DragSelectionState;
  dropActions: { perform(request: DropRequest): Promise<void> };
  editNode(node: BookmarkNode): void;
  extensionOrigin: string;
  favouriteSlots: readonly (BookmarkNode | undefined)[];
  localBookmarksBySpaceId: Readonly<Record<string, BookmarkNode[]>>;
  nodeMap: ReadonlyMap<string, BookmarkNode>;
  realTabTreeDestination(destination: { index?: number; parentId: string }): {
    index?: number;
    parentId: string;
  };
  showNotice: Notify;
  spaceColours: Readonly<Record<string, string>>;
  spaceTabs: readonly BrowserTab[];
  spaces: readonly Space[];
  splitRows: SplitRows;
  tabIdsByFolderId: Readonly<Record<string, number[] | undefined>>;
  tabTreeNodes: BookmarkNode[];
  tabTreeRootId: string;
}

const described = (items: readonly SelectableDragItem[]) =>
  items.length === 1 && items[0] ? `“${items[0].title}”` : `${items.length} items`;

/**
 * Carries out what rows' context menus and clipboard keys ask for. Pasting and
 * moving to a space go through the drop actions, so each does exactly what the
 * matching drop does.
 */
export function useItemActions(dependencies: ItemActionDependencies): {
  actions: ItemActions;
  menu: ReactNode;
} {
  const latest = useRef(dependencies);
  latest.current = dependencies;
  const { menu, open } = useContextMenu();

  const actions = useMemo<ItemActions>(() => {
    const run = (operation: () => Promise<unknown>) => {
      void operation().catch((error: unknown) => latest.current.showNotice(
        errorMessage(error, 'That could not be done'),
      ));
    };
    const surroundings = (): ClipboardSurroundings => {
      const current = latest.current;
      return {
        bookmarkTrees: current.spaces.flatMap((space) => space.rootId
          ? [{ nodes: current.localBookmarksBySpaceId[space.id] ?? [], rootId: space.rootId }]
          : []),
        extensionOrigin: current.extensionOrigin,
        favouriteSlots: current.favouriteSlots,
        favouritesFolderId: current.browserState.favouritesFolderId,
        ...(current.browserState.installationId
          ? { installationId: current.browserState.installationId }
          : {}),
        nodeMap: current.nodeMap,
        tabBackingIds: current.browserState.tabBackingIds,
        tabTreeNodes: current.tabTreeNodes,
        tabTreeRootId: current.tabTreeRootId,
        tabs: current.browserState.tabs,
        windowId: current.browserState.currentWindowId,
      };
    };
    // The space holding a bookmark, so moving it lists every space but that one.
    const spaceOf = (nodeId: string): string | undefined => {
      const { nodeMap, spaces } = latest.current;
      const spaceByRootId = new Map(spaces.flatMap((space) => space.rootId ? [[space.rootId, space.id] as const] : []));
      for (let node = nodeMap.get(nodeId); node?.parentId; node = nodeMap.get(node.parentId)) {
        const spaceId = spaceByRootId.get(node.parentId);
        if (spaceId) return spaceId;
      }
      return undefined;
    };
    const runPlan = async (plan: PastePlan) => {
      const current = latest.current;
      const { browserState } = current;
      if (plan.kind === 'notice') {
        current.showNotice(plan.message, 'warning');
      } else if (plan.kind === 'drop') {
        await browserState.runBackingOperation(() => current.dropActions.perform(plan.request));
        for (const nodeId of plan.unpinAfter ?? []) {
          const node = current.nodeMap.get(nodeId);
          if (node) await browserState.removeBookmark(node);
        }
      } else if (plan.kind === 'move-tabs') {
        if (!current.activeSpace || browserState.currentWindowId === null) return;
        const afterSpace = current.spaceTabs.length > 0
          ? Math.max(...current.spaceTabs.map((tab) => tab.index)) + 1
          : -1;
        await browserState.moveTabsIntoTree(plan.tabIds, browserState.currentWindowId, afterSpace, {
          spaceId: current.activeSpace.id,
          ...current.realTabTreeDestination(plan.destination),
        });
      } else {
        await carryOutPagePlan(plan, {
          activeSpaceId: current.activeSpace?.id,
          browserState,
          showNotice: current.showNotice,
        });
      }
    };
    const clipboard = (operation: 'copy' | 'cut', items: readonly SelectableDragItem[]) => {
      const contents = hyperClipboard(operation, items, surroundings());
      if (contents.items.length === 0) return;
      run(async () => {
        await writeClipboard(contents);
        latest.current.showNotice(operation === 'cut'
          ? `Cut ${described(items)}: paste into a folder to move it`
          : `Copied ${described(items)}`, 'info');
      });
    };
    const paste = (target: PasteTarget) => {
      // Reading starts before the first await, while the click or key still lets it.
      const contents = readClipboard();
      run(async () => {
        const read = await contents;
        if (!read) {
          latest.current.showNotice('Hyper could not read the clipboard');
          return;
        }
        await runPlan(planPaste(read, target, surroundings()));
      });
    };
    const canPaste = (target: PasteTarget) => {
      let available: Promise<boolean> | undefined;
      return () => {
        if (!available) {
          available = readClipboard().then((contents) =>
            contents !== undefined && planPaste(contents, target, surroundings()).kind !== 'notice',
          ).catch(() => false);
        }
        return available;
      };
    };
    /** Does what dropping `items` on `target` would, as a menu's move or remove does. */
    const dropOn = (items: readonly SelectableDragItem[], target: DragItemData) => {
      const [source] = items;
      if (!source) return;
      run(() => latest.current.browserState.runBackingOperation(() => latest.current.dropActions.perform({
        copiesBookmark: false,
        modifierActive: false,
        selectedSources: items,
        source,
        target,
      })));
    };
    const spaceEntries = (items: readonly SelectableDragItem[]): ContextMenuEntry[] => {
      const current = latest.current;
      const [source] = items;
      if (!source || source.kind === 'favourite' || source.kind === 'session-tab') return [];
      const ownSpaceId = source.kind === 'tree' ? spaceOf(source.nodeId) : current.activeSpace?.id;
      const destinations = current.spaces.filter((space) =>
        space.id !== ownSpaceId && (source.kind !== 'tree' || space.rootId));
      return destinations.map((space, index) => ({
        id: `space:${space.id}`,
        label: space.title || 'Untitled space',
        onSelect: () => dropOn(items, { kind: 'space', spaceId: space.id, ...(space.rootId ? { rootId: space.rootId } : {}) }),
        ...(index === 0 ? { section: 'Move to space' } : {}),
        ...(current.spaceColours[space.id] ? { swatch: current.spaceColours[space.id] } : {}),
      }));
    };
    const splitBesideCurrentTab = (item: SelectableDragItem) => {
      const current = latest.current;
      const tab = current.activeTab;
      if (tab?.id === undefined) return undefined;
      const split = splitBeside({
        capacity: current.browserState.commandCapabilities.splitViewTabs,
        nodeId: current.browserState.tabBackingIds[tab.id] ?? `unsupported-tab:${tab.id}`,
        rows: current.splitRows,
        sources: [item],
        tab,
        tabs: current.browserState.tabs,
        urlOf: (nodeId) => current.nodeMap.get(nodeId)?.url,
      });
      return split
        ? () => run(() => latest.current.browserState.splitTab(split))
        : undefined;
    };
    const closeTabs = (tabIds: readonly number[]) =>
      run(() => latest.current.browserState.closeTabs(tabIds));
    const reloadTabs = (tabIds: readonly number[]) =>
      run(() => latest.current.browserState.reloadTabs(tabIds));
    const removeItems = (items: readonly SelectableDragItem[]) => dropOn(items, { kind: 'trash' });
    const editBookmark = (nodeId: string) => {
      const node = latest.current.nodeMap.get(nodeId);
      if (node) latest.current.editNode(node);
    };
    const duplicateBookmark = (nodeId: string) => {
      const node = latest.current.nodeMap.get(nodeId);
      const parentId = node?.parentId;
      if (!node || !parentId) return;
      run(() => latest.current.browserState.copyBookmark(nodeId, {
        index: (node.index ?? 0) + 1,
        parentId,
      }));
    };
    // A result the sidebar also shows gets that row's menu; any other result can only be copied.
    const searchMenu = (result: SearchItem): ContextMenuEntry[] => {
      const current = latest.current;
      const located = itemLocator(surroundings());
      const entry = searchItemEntry(result);
      const item = located.item(entry);
      if (!item || item.kind === 'tab-folder') {
        return entry.url ? itemMenuEntries({
          count: 1,
          copy: () => run(async () => {
            await writeClipboard({
              hyper: 1,
              operation: 'copy',
              ...(current.browserState.installationId
                ? { installationId: current.browserState.installationId }
                : {}),
              items: [entry],
            });
            latest.current.showNotice(`Copied “${result.title}”`, 'info');
          }),
        }) : [];
      }
      const split = splitBesideCurrentTab(item);
      const own = { canPaste, clipboard, closeTabs, paste, reloadTabs };
      const copying = { count: 1, ...clipboardEntries(own, [item]) };
      if (item.kind === 'tab') {
        const tab = current.browserState.tabs.find((candidate) => candidate.id === item.tabId);
        return itemMenuEntries({
          ...copying,
          duplicate: tab ? () => run(() => latest.current.browserState.duplicateTab(tab)) : undefined,
          bookmark: tab && item.bookmarkable ? {
            kind: 'create',
            label: BOOKMARK_LABELS.create,
            run: () => run(() => latest.current.bookmarkTab(tab)),
          } : undefined,
          split: split ? { label: 'Split with current tab', run: split } : undefined,
          ...openTabEntries(own, [item.tabId]),
          spaces: spaceEntries([item]),
        });
      }
      const folder = item.kind === 'tree' && item.isFolder ? located.bookmarkItem(item.nodeId) : undefined;
      const pasteTarget = folder ? { folder, kind: 'bookmark-folder' as const } : undefined;
      return itemMenuEntries({
        ...copying,
        rename: () => editBookmark(item.nodeId),
        duplicate: item.kind === 'tree' && !item.isFolder ? () => duplicateBookmark(item.nodeId) : undefined,
        split: split ? { label: 'Open beside current tab', run: split } : undefined,
        ...(pasteTarget ? pasteEntries(own, pasteTarget) : {}),
        remove: { label: folder ? 'Remove folder' : 'Remove bookmark', run: () => removeItems([item]) },
        spaces: spaceEntries([item]),
      });
    };
    return {
      itemsFor: (item) => {
        const selection = latest.current.dragSelection().items;
        const id = dragSelectionId(item);
        return selection.some((selected) => dragSelectionId(selected) === id)
          ? topLevelDragSelection(selection)
          : [item];
      },
      canPaste,
      openMenu: (event, label, entries) => {
        event.preventDefault();
        event.stopPropagation();
        open({ entries, label, returnFocus: event.currentTarget, ...contextMenuAnchor(event) });
      },
      clipboard,
      paste,
      reloadTabs,
      spaceEntries,
      splitBesideCurrentTab,
      closeTabs,
      tabIdsOf: (items) => [...new Set(items.flatMap((item) => item.kind === 'tab'
        ? [item.tabId]
        : item.kind === 'tab-folder' ? latest.current.tabIdsByFolderId[item.nodeId] ?? [] : []))],
      removeItems,
      editBookmark,
      deleteBookmark: (nodeId) => {
        const node = latest.current.nodeMap.get(nodeId);
        if (node) latest.current.deleteNode(node);
      },
      duplicateBookmark,
      searchMenu,
    };
  }, [open]);

  return { actions, menu };
}
