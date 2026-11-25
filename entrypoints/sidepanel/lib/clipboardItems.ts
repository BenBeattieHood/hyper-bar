import {
  bookmarkableTabUrl,
  descendantItemCount,
  isBookmarkFolder,
  isTabBackingBookmark,
  parseBookmarkTitle,
  tabBackingInstallationId,
  visibleBookmarkTitle,
  type BookmarkNode,
  type BrowserTab,
} from '../../lib/bookmarks';
import { tabDisplayTitle } from '../../lib/tabs';
import type { SearchItem } from '../../lib/search';
import type { DragItemData, SelectableDragItem } from '../types';
import {
  bookmarkDropCopies,
  flattenVisibleTree,
  isInvalidFolderDrop,
  treeDropDestinationUnchanged,
  type FlattenedTreeItem,
} from './drag';
import type { DropRequest, TabTreeTarget } from './dropActions';
import {
  clipboardPages,
  pastedPages,
  type ClipboardContents,
  type ClipboardEntry,
  type ClipboardPage,
  type HyperClipboard,
} from './itemClipboard';
import { isAutoTabFolderId } from '../../lib/autoTabFolders';
import type { PagePlan } from './pagePlans';
import { tabUrl } from '../../lib/urlIdentity';

/** What the sidebar knows that a copy records or a paste checks against. */
export interface ClipboardSurroundings {
  /** Every space's bookmarks, under the folder that holds them. */
  bookmarkTrees: ReadonlyArray<{ nodes: BookmarkNode[]; rootId: string }>;
  extensionOrigin: string;
  favouriteSlots: readonly (BookmarkNode | undefined)[];
  favouritesFolderId?: string | null;
  installationId?: string;
  nodeMap: ReadonlyMap<string, BookmarkNode>;
  tabBackingIds: Readonly<Record<number, string>>;
  /** The active space's tab tree as the sidebar draws it, autofolders and all. */
  tabTreeNodes: BookmarkNode[];
  tabTreeRootId: string;
  /** This window's tabs. */
  tabs: readonly BrowserTab[];
  windowId: number | null;
}

/** A folder a paste lands in, as a drop on its middle would, a favourites bar slot it pins to, or another session. */
export type PasteTarget =
  | { folder: FlattenedTreeItem; kind: 'bookmark-folder' | 'tab-folder' }
  | { index: number; kind: 'favourite-slot' }
  | { installationId: string; kind: 'session' };

export type PastePlan =
  /** `unpinAfter` holds cut favourites, which leave the favourites bar once they land. */
  | { kind: 'drop'; request: DropRequest; unpinAfter?: string[] }
  | { destination: { index: number; parentId: string }; kind: 'move-tabs'; tabIds: number[] }
  | PagePlan
  | { kind: 'notice'; message: string };

const everyNode = (nodes: BookmarkNode[], rootId: string) =>
  flattenVisibleTree(nodes, rootId, new Set(), true);

const withMetadata = (node: BookmarkNode | undefined) => {
  const metadata = node ? parseBookmarkTitle(node.title).metadata : {};
  return Object.keys(metadata).length > 0 ? { metadata } : {};
};

function tabEntry(tab: BrowserTab, title: string, backing: BookmarkNode | undefined): ClipboardEntry {
  const url = tabUrl(tab);
  return {
    kind: 'tab',
    title,
    ...(url ? { url } : {}),
    ...(tab.id === undefined ? {} : { tabId: tab.id }),
    ...(backing ? { nodeId: backing.id } : {}),
    ...withMetadata(backing),
  };
}

function bookmarkEntry(node: BookmarkNode, favourite = false): ClipboardEntry {
  if (!isBookmarkFolder(node)) {
    return {
      kind: 'bookmark',
      title: visibleBookmarkTitle(node) || node.url || '',
      ...(node.url ? { url: node.url } : {}),
      nodeId: node.id,
      ...withMetadata(node),
      ...(favourite ? { favourite: true } : {}),
    };
  }
  return {
    kind: 'folder',
    title: visibleBookmarkTitle(node) || 'Untitled folder',
    nodeId: node.id,
    ...withMetadata(node),
    children: (node.children ?? []).map((child) => bookmarkEntry(child)),
  };
}

function tabTreeEntry(
  node: BookmarkNode,
  surroundings: ClipboardSurroundings,
  tabsByNodeId: ReadonlyMap<string, BrowserTab>,
): ClipboardEntry {
  if (!isBookmarkFolder(node)) {
    const tab = tabsByNodeId.get(node.id);
    const backing = surroundings.nodeMap.get(node.id);
    const title = visibleBookmarkTitle(node);
    return tab
      ? tabEntry(tab, title || tabDisplayTitle(tab), backing)
      : { kind: 'tab', title, ...(node.url ? { url: node.url } : {}), nodeId: node.id, ...withMetadata(backing) };
  }
  return {
    kind: 'tab-folder',
    title: visibleBookmarkTitle(node) || 'Untitled folder',
    nodeId: node.id,
    ...withMetadata(surroundings.nodeMap.get(node.id)),
    children: (node.children ?? []).map((child) => tabTreeEntry(child, surroundings, tabsByNodeId)),
  };
}

/** What a copy of these rows records: titles, addresses, Hyper's metadata, and folders' contents. */
export function clipboardEntries(
  items: readonly SelectableDragItem[],
  surroundings: ClipboardSurroundings,
): ClipboardEntry[] {
  const tabNodes = new Map(everyNode(surroundings.tabTreeNodes, surroundings.tabTreeRootId)
    .map((item) => [item.nodeId, item.node]));
  const tabsByNodeId = new Map(surroundings.tabs.flatMap((tab) => {
    const backingId = tab.id === undefined ? undefined : surroundings.tabBackingIds[tab.id];
    return backingId ? [[backingId, tab] as const] : [];
  }));
  return items.flatMap((item): ClipboardEntry[] => {
    if (item.kind === 'tab') {
      const tab = surroundings.tabs.find((candidate) => candidate.id === item.tabId);
      const backingId = item.backingId ?? surroundings.tabBackingIds[item.tabId];
      return tab ? [tabEntry(tab, item.title, backingId ? surroundings.nodeMap.get(backingId) : undefined)] : [];
    }
    if (item.kind === 'tab-folder') {
      const node = tabNodes.get(item.nodeId);
      return node ? [tabTreeEntry(node, surroundings, tabsByNodeId)] : [];
    }
    if (item.kind === 'session-tab') {
      const backing = surroundings.nodeMap.get(item.nodeId);
      return backing?.url
        ? [{ kind: 'session-tab', title: item.title, url: backing.url, nodeId: backing.id, ...withMetadata(backing) }]
        : [];
    }
    const node = surroundings.nodeMap.get(item.nodeId);
    return node ? [bookmarkEntry(node, item.kind === 'favourite')] : [];
  });
}

export function hyperClipboard(
  operation: HyperClipboard['operation'],
  items: readonly SelectableDragItem[],
  surroundings: ClipboardSurroundings,
): HyperClipboard {
  return {
    hyper: 1,
    operation,
    ...(surroundings.installationId ? { installationId: surroundings.installationId } : {}),
    ...(surroundings.windowId === null ? {} : { windowId: surroundings.windowId }),
    items: clipboardEntries(items, surroundings),
  };
}

/**
 * The rows a copy names, if every one is still here as it was copied. Only a
 * copy this installation made is trusted to name its items, since any page can
 * write the clipboard. A tab must also be one of this window's: other windows'
 * tabs never reach a view (DECISIONS 16).
 */
export function resolveClipboard(
  clipboard: HyperClipboard,
  surroundings: ClipboardSurroundings,
): SelectableDragItem[] | undefined {
  if (!clipboard.installationId || clipboard.installationId !== surroundings.installationId) {
    return undefined;
  }
  const locate = itemLocator(surroundings);
  const items = clipboard.items.map(locate.item);
  return items.every((item): item is SelectableDragItem => item !== undefined) ? items : undefined;
}

/** Finds the rows entries name: the ones still here as they were described. */
export function itemLocator(surroundings: ClipboardSurroundings): {
  bookmarkItem(nodeId: string): FlattenedTreeItem | undefined;
  item(entry: ClipboardEntry): SelectableDragItem | undefined;
} {
  const bookmarkItems = new Map(surroundings.bookmarkTrees.flatMap(({ nodes, rootId }) =>
    everyNode(nodes, rootId)).map((item) => [item.nodeId, item]));
  const tabItems = new Map(everyNode(surroundings.tabTreeNodes, surroundings.tabTreeRootId)
    .map((item) => [item.nodeId, item]));
  const resolve = (entry: ClipboardEntry): SelectableDragItem | undefined => {
    if (entry.kind === 'tab') {
      const tab = surroundings.tabs.find((candidate) => candidate.id === entry.tabId);
      if (tab?.id === undefined || tabUrl(tab) !== entry.url) return undefined;
      const backingId = surroundings.tabBackingIds[tab.id];
      const placed = backingId ? tabItems.get(backingId) : undefined;
      return {
        kind: 'tab',
        tabId: tab.id,
        title: entry.title,
        windowId: tab.windowId,
        index: tab.index,
        bookmarkable: Boolean(bookmarkableTabUrl(tab, surroundings.extensionOrigin)),
        itemCount: 1,
        ...(backingId && surroundings.nodeMap.has(backingId) ? { backingId } : {}),
        ...(placed ? {
          ancestorIds: placed.ancestorIds,
          depth: placed.depth,
          nodeId: placed.nodeId,
          parentId: placed.parentId,
          treeIndex: placed.index,
        } : {}),
      };
    }
    if (!entry.nodeId) return undefined;
    if (entry.kind === 'session-tab') {
      // Still another session's tab, at the same address, as when it was copied.
      const backing = surroundings.nodeMap.get(entry.nodeId);
      const installationId = backing && isTabBackingBookmark(backing) ? tabBackingInstallationId(backing) ?? '' : undefined;
      if (!backing || installationId === undefined || installationId === surroundings.installationId) return undefined;
      return backing.url === entry.url
        ? { kind: 'session-tab', installationId, nodeId: backing.id, title: entry.title, url: backing.url, itemCount: 1 }
        : undefined;
    }
    if (entry.kind === 'tab-folder') {
      const placed = tabItems.get(entry.nodeId);
      if (!placed?.isFolder) return undefined;
      return {
        kind: 'tab-folder',
        ...placeOf(placed),
        title: entry.title,
        itemCount: 1 + descendantItemCount(placed.node),
        ...(isAutoTabFolderId(placed.nodeId) ? { virtual: true } : {}),
      };
    }
    if (entry.favourite) {
      const slot = surroundings.favouriteSlots.findIndex((node) => node?.id === entry.nodeId);
      const node = surroundings.favouriteSlots[slot];
      return node && node.url === entry.url
        ? { kind: 'favourite', nodeId: node.id, title: entry.title, index: slot, itemCount: 1 }
        : undefined;
    }
    const placed = bookmarkItems.get(entry.nodeId);
    if (!placed || (entry.kind === 'folder' ? !placed.isFolder : placed.node.url !== entry.url)) {
      return undefined;
    }
    return {
      kind: 'tree',
      ...placeOf(placed),
      title: entry.title,
      isFolder: placed.isFolder,
      itemCount: placed.isFolder ? 1 + descendantItemCount(placed.node) : 1,
    };
  };
  return { bookmarkItem: (nodeId) => bookmarkItems.get(nodeId), item: resolve };
}

/** A search result described as a clipboard entry, which can then find its row. */
export function searchItemEntry(item: SearchItem): ClipboardEntry {
  return {
    kind: item.kind === 'tab' ? 'tab' : item.kind === 'folder' ? 'folder' : 'bookmark',
    title: item.title,
    ...(item.url ? { url: item.url } : {}),
    ...(item.nodeId ? { nodeId: item.nodeId } : {}),
    ...(item.tabId === undefined ? {} : { tabId: item.tabId }),
    ...(item.source === 'favourite' ? { favourite: true } : {}),
  };
}

/** Where a row sits, as drag data names it. */
const placeOf = ({ ancestorIds, depth, index, nodeId, parentId }: FlattenedTreeItem) =>
  ({ ancestorIds, depth, index, nodeId, parentId });

const folderPlace = (folder: FlattenedTreeItem) =>
  ({ ...placeOf(folder), title: visibleBookmarkTitle(folder.node) || 'Untitled folder' });

/** Dropping `items` on the middle of `folder`, first inside it, unless `from` is already there. */
function folderDrop<Target extends DragItemData>(
  items: readonly [SelectableDragItem, ...SelectableDragItem[]],
  folder: FlattenedTreeItem,
  modifierActive: boolean,
  target: Target,
  from: Parameters<typeof treeDropDestinationUnchanged>[0] | undefined,
  invalid: (destination: { parentId: string; index: number }) => boolean,
) {
  const [source] = items;
  const destination = { parentId: folder.nodeId, index: 0 };
  const unchanged = items.length === 1 && from !== undefined && treeDropDestinationUnchanged(from, destination);
  return {
    request: {
      copiesBookmark: bookmarkDropCopies(source, target, modifierActive),
      modifierActive,
      selectedSources: items,
      source,
      target,
    },
    drop: {
      destination,
      depth: folder.depth + 1,
      indicatorNodeId: folder.nodeId,
      invalid: invalid(destination),
      position: 'inside' as const,
      target,
      ...(unchanged ? { unchanged: true } : {}),
    },
  };
}

function bookmarkFolderDrop(
  items: readonly [SelectableDragItem, ...SelectableDragItem[]],
  folder: FlattenedTreeItem,
  modifierActive: boolean,
  nodeMap: ReadonlyMap<string, BookmarkNode>,
): DropRequest {
  const [source] = items;
  const target = { kind: 'tree' as const, ...folderPlace(folder), isFolder: true };
  const { drop, request } = folderDrop(items, folder, modifierActive, target, source.kind === 'tree' ? source : undefined,
    (destination) => source.kind === 'tree'
      ? isInvalidFolderDrop(source, nodeMap.get(source.nodeId), destination)
      : source.kind === 'tab' && !source.bookmarkable);
  return { ...request, treeDrop: drop };
}

function tabFolderDrop(
  items: readonly [SelectableDragItem, ...SelectableDragItem[]],
  folder: FlattenedTreeItem,
  modifierActive: boolean,
): DropRequest {
  const [source] = items;
  const target: TabTreeTarget = {
    kind: 'tab-folder',
    ...folderPlace(folder),
    ...(isAutoTabFolderId(folder.nodeId) ? { virtual: true } : {}),
  };
  const location = source.kind === 'tab-folder'
    ? source
    : source.kind === 'tab' && source.parentId !== undefined && source.treeIndex !== undefined
      ? { parentId: source.parentId, index: source.treeIndex }
      : undefined;
  const { drop, request } = folderDrop(items, folder, modifierActive, target, location, () =>
    source.kind === 'tab-folder' && (folder.nodeId === source.nodeId || folder.ancestorIds.includes(source.nodeId)));
  return { ...request, tabTreeDrop: drop };
}

/**
 * What pasting does on a folder: what dropping the copied rows on its middle
 * would, holding the copy modifier when they were copied rather than cut.
 * Where a drop would move the original even so, a copy pastes copies instead:
 * tabs open again as new tabs, and folders, which Hyper cannot duplicate,
 * paste only when cut. Rows no longer here as they were copied, another
 * window's tabs, and plain addresses paste as new bookmarks or tabs.
 */
export function planPaste(
  contents: ClipboardContents,
  target: PasteTarget,
  surroundings: ClipboardSurroundings,
): PastePlan {
  const clipboard = contents.hyper;
  const copying = clipboard?.operation !== 'cut';
  const [first, ...rest] = clipboard ? resolveClipboard(clipboard, surroundings) ?? [] : [];
  const pages = clipboard ? clipboardPages(clipboard.items) : pastedPages(contents.text);
  if (target.kind === 'session') {
    return planSessionPaste(first ? [first, ...rest] : [], target.installationId, copying);
  }
  if (target.kind === 'favourite-slot') {
    // Another session's tabs pin as the pages they show.
    const items = first && ![first, ...rest].some((item) => item.kind === 'session-tab') ? [first, ...rest] : [];
    return planFavouritePaste(items, pages, target.index, copying, surroundings);
  }
  if (first) {
    const items = [first, ...rest] as const;
    if (target.kind === 'bookmark-folder') {
      if (copying && items.some((item) => item.kind === 'tree' && item.isFolder)) {
        return { kind: 'notice', message: 'Folders can be cut and pasted, but not copied' };
      }
      const unpinAfter = copying ? [] : items.flatMap((item) => item.kind === 'favourite' ? [item.nodeId] : []);
      return {
        kind: 'drop',
        request: bookmarkFolderDrop(items, target.folder, copying, surroundings.nodeMap),
        ...(unpinAfter.length > 0 ? { unpinAfter } : {}),
      };
    }
    const tabs = items.filter((item) => item.kind === 'tab' || item.kind === 'tab-folder');
    if (tabs.length > 0 && copying) {
      return pages.length > 0
        ? { kind: 'open-pages', pages }
        : { kind: 'notice', message: 'Those tabs have no pages to open here' };
    }
    if (
      tabs.length === items.length &&
      items.every((item) => item.kind === 'tab') &&
      items.some((item) => item.kind === 'tab' && !item.nodeId)
    ) {
      // Tabs in another of this window's spaces have no place in this space's tree yet.
      return {
        kind: 'move-tabs',
        tabIds: items.flatMap((item) => item.kind === 'tab' ? [item.tabId] : []),
        destination: { index: 0, parentId: target.folder.nodeId },
      };
    }
    return { kind: 'drop', request: tabFolderDrop(items, target.folder, copying) };
  }
  if (pages.length === 0) {
    return {
      kind: 'notice',
      message: clipboard ? 'What was copied is no longer here to paste' : 'There is nothing here to paste',
    };
  }
  const notice = clipboard && !copying
    ? 'Pasted as copies: what was cut stays where it was'
    : undefined;
  return target.kind === 'bookmark-folder'
    ? { index: 0, kind: 'bookmark-pages', pages, parentId: target.folder.nodeId, ...(notice ? { notice } : {}) }
    : { kind: 'open-pages', pages, ...(notice ? { notice } : {}) };
}

/**
 * Pasting on another session gives it the tabs copied or cut, as dropping
 * them on its section would: this window's tabs that Hyper keeps, and other
 * sessions' tabs. A session keeps only tabs, so bookmarks and addresses stay
 * where they are.
 */
function planSessionPaste(
  items: readonly SelectableDragItem[],
  installationId: string,
  copying: boolean,
): PastePlan {
  if (!installationId) {
    return { kind: 'notice', message: 'Tabs kept before Hyper named its installations cannot take more' };
  }
  const [source] = items;
  const tabs = items.every((item) =>
    item.kind === 'tab' ? Boolean(item.backingId) : item.kind === 'session-tab');
  if (!source || !tabs) return { kind: 'notice', message: 'Only tabs can be given to another session' };
  if (items.some((item) => item.kind !== source.kind)) {
    return { kind: 'notice', message: 'Paste this window\'s tabs and other sessions\' tabs separately' };
  }
  if (items.every((item) => item.kind === 'session-tab' && item.installationId === installationId)) {
    return { kind: 'notice', message: 'That session already keeps those tabs' };
  }
  return {
    kind: 'drop',
    request: {
      copiesBookmark: false,
      modifierActive: copying,
      selectedSources: items,
      source,
      target: { installationId, kind: 'session-zone' },
    },
  };
}

/**
 * Pasting on a favourites bar slot pins what was copied there, as dropping it
 * on the slot would. An address pins as a new favourite.
 */
function planFavouritePaste(
  items: readonly SelectableDragItem[],
  pages: readonly ClipboardPage[],
  index: number,
  copying: boolean,
  surroundings: ClipboardSurroundings,
): PastePlan {
  const [source] = items;
  if (source) {
    if (items.some((item) => item.kind === 'tab-folder' || item.kind === 'tree' && item.isFolder)) {
      return { kind: 'notice', message: 'Only bookmarks and tabs can be pinned' };
    }
    const target = { kind: 'favourite-slot' as const, index };
    return {
      kind: 'drop',
      request: {
        copiesBookmark: bookmarkDropCopies(source, target, copying),
        modifierActive: copying,
        selectedSources: items,
        source,
        target,
      },
    };
  }
  const [page] = pages;
  if (!page || !surroundings.favouritesFolderId) {
    return { kind: 'notice', message: 'There is nothing here to pin' };
  }
  return {
    favouriteSlots: [index],
    index: 0,
    kind: 'bookmark-pages',
    pages: [page],
    parentId: surroundings.favouritesFolderId,
  };
}
