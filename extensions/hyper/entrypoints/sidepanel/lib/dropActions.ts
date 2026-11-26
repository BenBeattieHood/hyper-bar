import {
  collectUniqueBookmarkUrls,
  MAX_FAVOURITES,
  type BookmarkNode,
  type BrowserTab,
  type Space,
} from '../../lib/bookmarks';
import type { IntentItemPayloads } from '../../lib/modelIntentPayloads';
import type { useBrowserState } from '../hooks/useBrowserState';
import type { DragItemData, SelectableDragItem } from '../types';
import {
  bookmarkRootScopeDestination,
  rootTreeDropDestination,
  targetsFavourites,
  targetsTabs,
  trashDropAction,
  treeDropDestinationUnchanged,
  type PointerTreeDrop,
} from './drag';
import { performExternalDrop, type ExternalDropSnapshot } from './externalDrop';
import { errorMessage, type Notify } from './notify';
import { asBookmarkCreationResult } from './intentSubmission';
import { sessionTabMoves, sessionTabsIn } from './otherSessions';
import { isSharedDragTab, sharedTabsDestination } from './sharedDragDrops';
import { performSpaceDrop, type SpaceDropDependencies } from './spaceDrops';
import type { SplitDrop } from './splitRows';

export type TreeDropIntent = PointerTreeDrop & {
  target: Extract<DragItemData, { kind: 'tree' }>;
  invalid: boolean;
};
export type TabTreeTarget = Extract<DragItemData, { kind: 'tab-folder' }> |
  (Extract<DragItemData, { kind: 'tab' }> & { nodeId: string });
export type TabTreeDropIntent = PointerTreeDrop & {
  target: TabTreeTarget;
  invalid: boolean;
};

/** A drop as the sidebar carries it out, whether a drag ended there or a paste or menu acts as one. */
export interface DropRequest {
  copiesBookmark: boolean;
  /** What a drag from outside Hyper dropped. */
  externalDrop?: ExternalDropSnapshot;
  modifierActive: boolean;
  selectedSources: readonly SelectableDragItem[];
  sharedToken?: string;
  source: DragItemData;
  /** Whether a space dropped on a pagination dot landed on its trailing half. */
  spaceDropAfter?: boolean;
  splitDrop?: SplitDrop;
  tabTreeDrop?: TabTreeDropIntent;
  target: DragItemData;
  treeDrop?: TreeDropIntent;
}

type BrowserStateApi = ReturnType<typeof useBrowserState>;

export interface DropActionDependencies extends SpaceDropDependencies {
  activeSpace?: Space;
  bookmarksRootId?: string;
  browserState: Pick<
    BrowserStateApi,
    | 'addTabBookmark'
    | 'closeTab'
    | 'closeTabs'
    | 'copyBookmark'
    | 'currentWindowId'
    | 'favouriteIds'
    | 'favouritesFolderId'
    | 'groupTabsInSpace'
    | 'moveBookmark'
    | 'moveTab'
    | 'moveTabs'
    | 'moveTabsIntoTree'
    | 'openBookmark'
    | 'removeBookmark'
    | 'removeTabFolder'
    | 'setFavouriteSlot'
    | 'setSpaceArchived'
    | 'spacesFolderId'
    | 'splitTab'
    | 'submitSelection'
    | 'tabs'
    | 'takeSharedDragTabs'
  >;
  favouriteSlots: readonly (BookmarkNode | undefined)[];
  favourites: readonly BookmarkNode[];
  /** The bookmarks kept outside every space, which the favourites bar's bookmarks button holds. */
  globalBookmarksRootId?: string | null;
  moveTabTreeNodes(
    nodeIds: readonly string[],
    destination: { parentId: string; index?: number },
  ): Promise<unknown>;
  nodeMap: ReadonlyMap<string, BookmarkNode>;
  realTabTreeDestination(destination: { parentId: string; index?: number }): {
    parentId: string;
    index?: number;
  };
  showNotice: Notify;
  spaceTabs: readonly BrowserTab[];
  tabIdsByFolderId: Readonly<Record<string, number[] | undefined>>;
  tabTreeRootId: string;
}

/** Turns a drop into the intents it stands for. */
export function createDropActions(dependencies: DropActionDependencies) {
  const perform = async ({
    copiesBookmark,
    externalDrop,
    modifierActive,
    selectedSources,
    sharedToken,
    source,
    spaceDropAfter,
    splitDrop,
    tabTreeDrop,
    target,
    treeDrop,
  }: DropRequest): Promise<void> => {
    const {
      activeSpace,
      bookmarksRootId,
      browserState,
      favouriteSlots,
      favourites,
      globalBookmarksRootId,
      moveTabTreeNodes,
      nodeMap,
      realTabTreeDestination,
      showNotice,
      spaceTabs,
      spaces,
      tabIdsByFolderId,
      tabTreeRootId,
    } = dependencies;

    try {
      if (source.kind === 'external') {
        await performExternalDrop(externalDrop, { target, ...(treeDrop ? { treeDrop } : {}) }, {
          activeSpaceId: activeSpace?.id,
          browserState,
          places: {
            ...(bookmarksRootId ? { bookmarksRootId } : {}),
            favouriteSlots,
            favouritesFolderId: browserState.favouritesFolderId,
            globalBookmarksRootId,
          },
          showNotice,
        });
        return;
      }
      // Where tabs land in this window's tab list, wherever they come from.
      const windowDestination = activeSpace && sharedTabsDestination({
        realDestination: realTabTreeDestination,
        rootId: tabTreeRootId,
        spaceId: activeSpace.id,
        spaceTabs,
        tabTreeDrop,
        target,
      });
      if (sharedToken !== undefined && selectedSources.some(isSharedDragTab)) {
        const destination = windowDestination;
        if (!destination || browserState.currentWindowId === null) {
          showNotice('Tabs from another window can only join this window\'s tabs', 'warning');
          return;
        }
        await browserState.takeSharedDragTabs(sharedToken, browserState.currentWindowId, destination.index, destination.tree);
        return;
      }
      const bookmarkDestination = (): { index?: number; parentId: string } | undefined => {
        const parentId = target.kind === 'bookmarks-trigger'
          ? bookmarksRootId
          : target.kind === 'global-bookmarks'
            ? globalBookmarksRootId ?? undefined
            : target.kind === 'tree-zone'
              ? target.parentId
              : target.kind === 'tree' ? treeDrop?.destination.parentId : undefined;
        const index = target.kind === 'tree-zone'
          ? target.index
          : target.kind === 'tree' ? treeDrop?.destination.index : undefined;
        return parentId ? { parentId, ...(index === undefined ? {} : { index }) } : undefined;
      };
      const firstEmptyFavouriteSlot = () => favouriteSlots.findIndex((node) => !node);
      /** The slot a single item dropped on the favourites takes. */
      const favouriteTargetIndex = () => target.kind === 'favourite' || target.kind === 'favourite-slot'
        ? target.index
        : firstEmptyFavouriteSlot();
      const tabsZoneDestination = (zone: Extract<DragItemData, { kind: 'tabs-zone' }>) =>
        zone.parentId ? { parentId: zone.parentId, index: zone.index } : undefined;
      const openSelectedBookmarks = (urls: readonly string[], destinationSpaceId: string) =>
        browserState.submitSelection('openBookmark', urls.map((url) => ({
          active: false,
          destinationSpaceId,
          forceNew: selectedSources.every((item) => item.kind === 'tree') || modifierActive,
          reuse: 'browser' as const,
          url,
        })));
      const bookmarkTabs = async (
        items: IntentItemPayloads['createBookmark'][],
        alreadyBookmarkedNotice: string,
      ) => {
        const results = await browserState.submitSelection('createBookmark', items);
        if (!results.some((result) => asBookmarkCreationResult(result)?.created)) {
          showNotice(alreadyBookmarkedNotice, 'warning');
        }
      };
      const sessionMoves = activeSpace && sessionTabMoves({
        bookmarkDestination: bookmarkDestination(),
        copy: modifierActive, selected: selectedSources, source, target, windowDestination,
      });
      if (sessionMoves) {
        if (sessionMoves.length > 0) await browserState.submitSelection('moveSessionTab', sessionMoves);
        return;
      }
      if (splitDrop) {
        await browserState.splitTab(splitDrop);
        return;
      }
      // A held drag over a space opens it mid-drag, so this window's tabs can land in another space's list.
      if (
        activeSpace && browserState.currentWindowId !== null &&
        selectedSources.length > 0 &&
        selectedSources.every((item) => item.kind === 'tab') &&
        selectedSources.some((item) => item.kind === 'tab' &&
          !spaceTabs.some((tab) => tab.id === item.tabId)) &&
        target.kind !== 'space'
      ) {
        if (windowDestination) {
          await browserState.moveTabsIntoTree(
            selectedSources.flatMap((item) => item.kind === 'tab' ? [item.tabId] : []),
            browserState.currentWindowId,
            windowDestination.index,
            windowDestination.tree,
          );
          return;
        }
      }
      if (source.kind === 'space') {
        await performSpaceDrop(source, target, Boolean(spaceDropAfter), dependencies);
        return;
      }
      // Only a space can go into the archive, and nothing can go into an archived space.
      if (target.kind === 'space-archive' || target.kind === 'space' && target.archived) return;

      if (target.kind === 'trash') {
        // Another session's tabs close by forgetting their backings, which Undo brings back.
        const closing = sessionTabsIn(source, selectedSources);
        if (closing.length > 0) {
          await browserState.submitSelection('deleteBookmark', closing.map((item) => ({ bookmarkId: item.nodeId })));
          return;
        }
        if (selectedSources.length > 1) {
          if (selectedSources.every((item) => item.kind === 'tab')) {
            await browserState.closeTabs(selectedSources.map((item) => item.tabId));
            return;
          }
          if (selectedSources.every((item) => item.kind === 'tree')) {
            await browserState.submitSelection('deleteBookmark', selectedSources.flatMap(
              (item) => nodeMap.has(item.nodeId) ? [{ bookmarkId: item.nodeId }] : [],
            ));
            return;
          }
          if (selectedSources.every((item) => item.kind === 'tab-folder' && !item.virtual)) {
            await browserState.submitSelection('setTabFolder', selectedSources.flatMap((item) =>
              item.kind === 'tab-folder'
                ? [{ folderId: item.nodeId, operation: 'remove' as const, withTabs: true as const }]
                : []));
            return;
          }
        }
        if (source.kind === 'tab-folder') {
          if (source.virtual) return;
          await browserState.removeTabFolder(source.nodeId, true);
          return;
        }
        const action = trashDropAction(source);
        if (action?.kind === 'close-tab') {
          await browserState.closeTab(action.tabId);
        } else if (action?.kind === 'remove-bookmark') {
          const node = nodeMap.get(action.nodeId);
          if (!node) return;
          await browserState.removeBookmark(node);
        }
        return;
      }

      const selectedTabIds = [...new Set(selectedSources.flatMap((item) => {
        if (item.kind === 'tab') return [item.tabId];
        return item.kind === 'tab-folder'
          ? tabIdsByFolderId[item.nodeId] ?? []
          : [];
      }))];
      const selectedBookmarkEntries = selectedSources.flatMap((item) => {
        if (item.kind !== 'tree' && item.kind !== 'favourite') return [];
        const node = nodeMap.get(item.nodeId);
        return node ? [{ item, node }] : [];
      });
      const selectedBookmarkUrls = [...new Set(selectedBookmarkEntries.flatMap(
        ({ node }) => collectUniqueBookmarkUrls(node),
      ))];

      if (target.kind === 'global-bookmarks') {
        const parentId = globalBookmarksRootId;
        if (!parentId) return;
        if (selectedTabIds.length > 0) {
          await bookmarkTabs(
            selectedTabIds.map((tabId) => ({ parentId, tabId })),
            'Those tabs are already in global bookmarks',
          );
          return;
        }
        const favouriteIds = selectedSources.flatMap((item) => item.kind === 'favourite' ? [item.nodeId] : []);
        if (favouriteIds.length > 0) {
          const results = await browserState.submitSelection('copyBookmark', favouriteIds.map(
            (bookmarkId) => ({ bookmarkId, parentId, skipExisting: !modifierActive }),
          ));
          if (results.every((result) => !result)) {
            showNotice('Already in global bookmarks', 'warning');
          }
          return;
        }
        const treeItems = selectedSources.flatMap((item) => item.kind === 'tree' ? [item] : []);
        if (treeItems.length === 0) return;
        // Bookmarks move into global bookmarks as they move between folders; the copy modifier copies them.
        if (modifierActive && treeItems.every((item) => !item.isFolder)) {
          await browserState.submitSelection('copyBookmark', treeItems.map(
            (item) => ({ bookmarkId: item.nodeId, parentId }),
          ));
          return;
        }
        const moving = treeItems.filter((item) => item.parentId !== parentId);
        if (moving.length > 0) {
          await browserState.submitSelection('moveBookmark', moving.map(
            (item) => ({ bookmarkId: item.nodeId, parentId }),
          ));
        }
        return;
      }

      if (target.kind === 'space') {
        const destination = spaces.find((space) => space.id === target.spaceId);
        if (!destination) return;
        if (
          selectedSources.length > 0 &&
          selectedSources.every((item) => item.kind === 'tree')
        ) {
          await browserState.submitSelection('moveBookmark', selectedSources.flatMap((item) => {
            const scopeDestination = bookmarkRootScopeDestination(item, target);
            return scopeDestination ? [{ bookmarkId: item.nodeId, ...scopeDestination }] : [];
          }));
          return;
        }
        if (selectedTabIds.length > 0) {
          await browserState.groupTabsInSpace(selectedTabIds, target.spaceId);
          return;
        }
        if (selectedBookmarkUrls.length > 0) {
          await openSelectedBookmarks(selectedBookmarkUrls, target.spaceId);
          return;
        }
      }

      if ((targetsTabs(target) || target.kind === 'tab-folder') && selectedBookmarkUrls.length > 0) {
        if (!activeSpace) return;
        await openSelectedBookmarks(selectedBookmarkUrls, activeSpace.id);
        return;
      }

      const bookmarkTreeTarget = target.kind === 'bookmarks-trigger' ||
        target.kind === 'tree-zone' || target.kind === 'tree' && treeDrop;
      if (bookmarkTreeTarget && selectedTabIds.length > 0) {
        const destination = bookmarkDestination();
        if (!destination) return;
        const { index, parentId } = destination;
        // Each tab is placed after the last; the background closes up past any already here.
        await bookmarkTabs(
          selectedTabIds.map((tabId, offset) => ({ parentId, tabId, ...(index === undefined ? {} : { index: index + offset }) })),
          'Those tabs are already bookmarked here',
        );
        return;
      }

      if (
        selectedSources.length > 1 &&
        selectedSources.every((item) => item.kind === 'tree') &&
        (target.kind === 'tree-zone' || target.kind === 'tree' && treeDrop)
      ) {
        const [primarySource] = selectedSources;
        if (!primarySource) return;
        const destination = target.kind === 'tree-zone'
          ? rootTreeDropDestination(primarySource, {
              parentId: target.parentId,
              index: target.index,
            })
          : treeDrop?.destination;
        if (!destination) return;
        const selectedNodeIds = new Set(selectedSources.map((item) => item.nodeId));
        if (
          target.kind === 'tree' &&
          (selectedNodeIds.has(target.nodeId) ||
            selectedSources.some((item) =>
              item.isFolder && target.ancestorIds?.includes(item.nodeId)))
        ) {
          showNotice('A selection cannot be moved inside itself', 'warning');
          return;
        }
        const copiesSelection = modifierActive &&
          selectedSources.every((item) => !item.isFolder);
        let index = destination.index;
        const placements = selectedSources.map((item) => {
          const indexedDestination = { ...destination, index };
          const itemDestination = (
            target.kind === 'tree-zone' || treeDrop?.depth === 0
          )
            ? rootTreeDropDestination(item, indexedDestination)
            : indexedDestination;
          if (itemDestination.index !== undefined) {
            index = itemDestination.index + 1;
          }
          return { bookmarkId: item.nodeId, ...itemDestination };
        });
        await browserState.submitSelection(
          copiesSelection ? 'copyBookmark' : 'moveBookmark',
          placements,
        );
        return;
      }

      const movesTreeNodes = selectedSources.every((item) => item.kind === 'tab-folder' ||
        item.kind === 'tab' && Boolean(item.backingId)) &&
        (target.kind === 'tab-folder' || target.kind === 'tab' && target.backingId ||
          target.kind === 'tabs-zone');

      // Unbacked tabs have no place in the tree yet, so they move in the strip and the list adopts it.
      if (
        selectedSources.length > 1 &&
        !movesTreeNodes &&
        selectedSources.every((item) => item.kind === 'tab') &&
        (target.kind === 'tab' || target.kind === 'tabs-zone')
      ) {
        const targetTab = target.kind === 'tab'
          ? browserState.tabs.find((tab) => tab.id === target.tabId)
          : spaceTabs.at(-1);
        if (!targetTab) return;
        await browserState.moveTabs(
          selectedTabIds,
          targetTab.windowId,
          target.kind === 'tab' ? target.index : targetTab.index + 1,
        );
        return;
      }

      if (selectedSources.length > 1 && targetsFavourites(target)) {
        if (!browserState.favouritesFolderId) return;
        if (selectedSources.some((item) =>
          item.kind === 'tree' && item.isFolder ||
          item.kind === 'tab-folder' ||
          item.kind === 'tab' && !item.bookmarkable)) {
          showNotice('Only bookmarks and bookmarkable tabs can be added to favourites', 'warning');
          return;
        }
        const preferredIndex = target.kind === 'favourite' ||
          target.kind === 'favourite-slot' ? target.index : undefined;
        const availableIndexes = [
          ...(preferredIndex === undefined ? [] : [preferredIndex]),
          ...favouriteSlots.flatMap((node, index) =>
            !node && index !== preferredIndex ? [index] : []),
        ];
        if (availableIndexes.length < selectedSources.length) {
          showNotice('There are not enough favourite slots', 'warning');
          return;
        }
        const favouritesFolderId = browserState.favouritesFolderId;
        const slotted = selectedSources.flatMap((item, selectionIndex) => {
          const favouriteSlot = availableIndexes[selectionIndex];
          return favouriteSlot === undefined ? [] : [{ favouriteSlot, item }];
        });
        // A selection holds one scope (tabs or bookmarks), so only one of these sends anything.
        await browserState.submitSelection('createBookmark', slotted.flatMap(
          ({ favouriteSlot, item }) => item.kind === 'tab'
            ? [{ favouriteSlot, parentId: favouritesFolderId, tabId: item.tabId }]
            : [],
        ));
        await browserState.submitSelection('copyBookmark', slotted.flatMap(
          ({ favouriteSlot, item }) => item.kind === 'tree'
            ? [{ bookmarkId: item.nodeId, favouriteSlot, parentId: favouritesFolderId }]
            : [],
        ));
        return;
      }

      if (selectedSources.length > 1 && movesTreeNodes) {
        if (!activeSpace) return;
        const destination = target.kind === 'tabs-zone'
          ? tabsZoneDestination(target)
          : tabTreeDrop?.destination;
        if (!destination) return;
        const selectedNodeIds = new Set(selectedSources.flatMap((item) => {
          if (item.kind === 'tab-folder') return [item.nodeId];
          return item.kind === 'tab' && item.backingId ? [item.backingId] : [];
        }));
        if (
          target.kind !== 'tabs-zone' &&
          ('nodeId' in target && target.nodeId && selectedNodeIds.has(target.nodeId) ||
            selectedSources.some((item) =>
              item.kind === 'tab-folder' && target.ancestorIds?.includes(item.nodeId)))
        ) {
          showNotice('A selection cannot be moved inside itself', 'warning');
          return;
        }
        await moveTabTreeNodes([...selectedNodeIds], destination);
        return;
      }

      if (
        (source.kind === 'tab-folder' ||
          source.kind === 'tab' && source.backingId && source.nodeId) &&
        (target.kind === 'tab-folder' || target.kind === 'tab' && target.backingId ||
          target.kind === 'tabs-zone')
      ) {
        if (!activeSpace) return;
        const nodeId = source.kind === 'tab-folder'
          ? source.nodeId
          : source.backingId as string;
        if (target.kind === 'tabs-zone') {
          const destination = tabsZoneDestination(target);
          if (!destination) return;
          const sourceLocation = source.kind === 'tab-folder'
            ? source
            : source.parentId !== undefined && source.treeIndex !== undefined
              ? { parentId: source.parentId, index: source.treeIndex }
              : undefined;
          if (sourceLocation && treeDropDestinationUnchanged(sourceLocation, destination)) {
            return;
          }
          await moveTabTreeNodes([nodeId], destination);
          return;
        }
        if (!tabTreeDrop) return;
        if (tabTreeDrop.unchanged) return;
        if (tabTreeDrop.invalid) {
          showNotice('A folder cannot be moved inside itself', 'warning');
          return;
        }
        await moveTabTreeNodes([nodeId], tabTreeDrop.destination);
        return;
      }

      if (
        (source.kind === 'tree' && !source.isFolder || source.kind === 'favourite') &&
        (target.kind === 'space' || targetsTabs(target) || target.kind === 'tab-folder')
      ) {
        if (!activeSpace) return;
        const node = nodeMap.get(source.nodeId);
        const destinationSpaceId = target.kind === 'space'
          ? target.spaceId
          : activeSpace.id;
        if (!node?.url) return;
        await browserState.openBookmark(node.url, {
          destinationSpaceId,
          forceNew: source.kind !== 'favourite' || modifierActive,
        });
        return;
      }

      if (source.kind === 'tab') {
        if (target.kind === 'tab') {
          if (source.tabId !== target.tabId) {
            await browserState.moveTab(source.tabId, target.windowId, target.index);
          }
          return;
        }
        if (target.kind === 'tabs-zone') {
          const lastTab = spaceTabs.at(-1);
          if (lastTab?.id !== undefined && source.tabId !== lastTab.id) {
            await browserState.moveTab(source.tabId, lastTab.windowId, lastTab.index);
          }
          return;
        }
        if (target.kind === 'space') {
          const destination = spaces.find((space) => space.id === target.spaceId);
          if (!destination) return;
          await browserState.groupTabsInSpace([source.tabId], target.spaceId);
          return;
        }
        if (!source.bookmarkable) {
          showNotice('This tab cannot be bookmarked', 'warning');
          return;
        }
        if (targetsFavourites(target)) {
          if (!browserState.favouritesFolderId) return;
          const index = favouriteTargetIndex();
          const replacesFavourite = index >= 0 && Boolean(favouriteSlots[index]);
          if (favourites.length >= MAX_FAVOURITES && !replacesFavourite) {
            showNotice('Favourites are full', 'warning');
            return;
          }
          const result = await browserState.addTabBookmark(
            browserState.favouritesFolderId,
            source.tabId,
            undefined,
            index >= 0 ? index : undefined,
          );
          if (!result.created) {
            showNotice('That tab is already a favourite', 'warning');
          }
          return;
        }
        if (target.kind === 'tree-zone' || (target.kind === 'tree' && treeDrop)) {
          const destination = bookmarkDestination();
          if (!destination) return;
          const result = await browserState.addTabBookmark(destination.parentId, source.tabId, destination.index);
          if (!result.created) {
            showNotice('That tab is already bookmarked here', 'warning');
          }
        }
        return;
      }

      if (source.kind === 'favourite') {
        if (target.kind === 'favourite' || target.kind === 'favourite-slot') {
          await browserState.setFavouriteSlot(source.nodeId, target.index);
        } else if (target.kind === 'favourite-zone') {
          const slot = firstEmptyFavouriteSlot();
          if (slot >= 0) await browserState.setFavouriteSlot(source.nodeId, slot);
        } else if (target.kind === 'tree-zone' || (target.kind === 'tree' && treeDrop)) {
          const destination = bookmarkDestination();
          if (!destination) return;
          const copy = await browserState.copyBookmark(source.nodeId, destination, {
            skipExisting: !modifierActive,
          });
          if (!copy) {
            showNotice(`${source.title} is already bookmarked here`, 'warning');
          }
        }
        return;
      }

      if (source.kind !== 'tree') return;

      if (targetsFavourites(target)) {
        const favouritesFolderId = browserState.favouritesFolderId;
        if (!favouritesFolderId) return;
        if (source.isFolder) {
          showNotice('Only bookmarks can be added to favourites', 'warning');
          return;
        }
        const targetIndex = favouriteTargetIndex();
        const replacesFavourite = targetIndex >= 0 && Boolean(favouriteSlots[targetIndex]);
        const existing = browserState.favouriteIds.filter((id) => id !== source.nodeId);
        if (
          !browserState.favouriteIds.includes(source.nodeId) &&
          existing.length >= MAX_FAVOURITES &&
          !replacesFavourite
        ) {
          showNotice('Favourites are full', 'warning');
          return;
        }
        if (targetIndex >= 0) {
          await browserState.copyBookmark(source.nodeId, {
            parentId: favouritesFolderId,
          }, { favouriteSlot: targetIndex });
        }
        return;
      }

      if (target.kind === 'tree-zone') {
        const destination = rootTreeDropDestination(source, {
          parentId: target.parentId,
          index: target.index,
        });
        if (copiesBookmark) {
          await browserState.copyBookmark(source.nodeId, destination);
        } else if (!treeDropDestinationUnchanged(source, destination)) {
          await browserState.moveBookmark(source.nodeId, destination);
        }
        return;
      }

      if (target.kind !== 'tree' || !treeDrop) return;
      const sourceNode = nodeMap.get(source.nodeId);
      if (!sourceNode) return;
      if (!copiesBookmark && treeDrop.unchanged) return;
      if (treeDrop.invalid) {
        showNotice('A folder cannot be moved inside itself', 'warning');
        return;
      }
      if (copiesBookmark) {
        await browserState.copyBookmark(source.nodeId, treeDrop.destination);
      } else {
        await browserState.moveBookmark(source.nodeId, treeDrop.destination);
      }
    } catch (error) {
      showNotice(errorMessage(
        error,
        target.kind === 'trash' ? 'That item could not be deleted' : 'That item could not be moved',
      ));
    }
  };
  return { perform };
}
