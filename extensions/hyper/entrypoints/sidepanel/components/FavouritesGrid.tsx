import { useDraggable, useDroppable } from '@dnd-kit/core';
import {
  rectSortingStrategy,
  SortableContext,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Bookmark, Pin, X } from 'lucide-react';
import { motion, useReducedMotion } from 'motion/react';
import {
  useContext,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
  type ReactNode,
} from 'react';
import {
  Favicon,
  faviconAudioStateForTabs,
  faviconLoadingForTabs,
  type FaviconAudioStates,
} from '@hyper/ui';
import {
  FavouriteGroupList,
  useFavouriteGroupList,
  type FavouriteGroupRowActions,
} from './FavouriteGroupList';
import { FavouriteHoverLabel, useFavouriteHover } from './FavouriteHoverLabel';
import { useFavouriteGroupPlacement } from '../hooks/useFavouriteGroupPlacement';
import { InlineItemTitle, useTitleDoubleClick } from '@hyper/ui';
import {
  bestTabFaviconUrl,
  bookmarkableTabUrl,
  bookmarkTabStatus,
  openSpaceForPage,
  visibleBookmarkTitle,
  type BookmarkNode,
  type BrowserTab,
  type Space,
  type SpaceIdentityIndex,
  type TabIdentityIndex,
} from '../../lib/bookmarks';
import { MAX_FAVOURITES } from '../../lib/bookmarks';
import { middleClickLabel, shortcutButtonProps } from '../../lib/shortcuts';
import { tabDisplayTitle } from '../../lib/tabs';
import { useFavouriteBar } from '../hooks/useFavouriteBar';
import { useFavouriteSlotCount } from '../hooks/useFavouriteSlotCount';
import {
  groupFavourites,
  groupTabs,
  type FavouriteBarSlot,
  type FavouriteGroup,
} from '../lib/favouriteBar';
import { useItemGesture } from '../lib/itemGesture';
import {
  clipboardEntries,
  ItemActionsContext,
  itemMenuEntries,
  pasteEntries,
  type ItemActions,
  type ItemMenu,
} from '../lib/itemActions';
import type { SelectableDragItem } from '../types';
import { tabUrl } from '../../lib/urlIdentity';

type OpenTab = BrowserTab & { id: number };

interface FavouriteActions {
  audioStateByTabId: FaviconAudioStates;
  dropDisabled?: boolean;
  onOpen: (url: string, forceNew: boolean) => void;
  onFocusTab: (tab: BrowserTab) => void;
  onCloseTabs: (tabIds: number[]) => void;
  onRenameTitle: (node: BookmarkNode, title: string) => Promise<void>;
  onInteractionError: (message: string) => void;
  /** Takes a favourite off the bar, leaving its tabs open. */
  onUnpin: (node: BookmarkNode) => void;
  /** Takes a grouped tile's favourites off the bar together. */
  onUnpinMany: (nodes: readonly BookmarkNode[]) => void;
  /** Pins a tab to a slot as a favourite. */
  onPin: (tabId: number, slot: number) => void;
}

/** What a tile needs to show the space its tab is in. */
interface TileSpaces {
  activeSpaceId: string;
  spaces: readonly Space[];
  spaceColours: Readonly<Record<string, string>>;
  /** Spaces each page is open in, across every window. */
  spaceIdsByPageIdentity: SpaceIdentityIndex;
  tabSpaceIds: Readonly<Record<number, string>>;
}

interface TabTileState {
  tabBookmarkLinks: Readonly<Record<number, { bookmarkId: string } | undefined>>;
  tabTitles: Readonly<Record<number, string>>;
}

/** A grouped tile's list: whether it is open, and the click that toggles it. */
interface TileGroup {
  group: FavouriteGroup;
  open: boolean;
  onToggle: () => void;
}

interface FavouritesGridProps extends FavouriteActions {
  favourites: Array<BookmarkNode | undefined>;
  /** Shows one tile per domain, listing its favourites and tabs. */
  groupByDomain: boolean;
  /** The single column of a sidebar too narrow for its lists: never grouped, and tiles name themselves with a native tooltip. */
  column: boolean;
  tileSpaces: TileSpaces;
  tabs: readonly BrowserTab[];
  windowId: number | null;
  extensionOrigin: string;
  /** Each tab's bookmark link, and what the model calls it. */
  tabState: TabTileState;
  tabsByPageIdentity: TabIdentityIndex;
  dragging: boolean;
  backgroundMusicTabIds: readonly number[];
  globalBookmarksOpen: boolean;
  /** The bookmarks button is about to open its panel for a drag held over it. */
  globalBookmarksArming?: boolean;
  /** Folders cannot be pinned, but can still be dropped on the bookmarks button. */
  globalBookmarksDropDisabled?: boolean;
  onToggleGlobalBookmarks: () => void;
}

/** A favourites bar menu: Cut and Copy, Reload while it has open tabs, and Close. */
function openTileMenu(
  actions: ItemActions,
  event: MouseEvent<HTMLElement>,
  title: string,
  { close, items, tabIds, ...entries }: Pick<ItemMenu, 'dismiss' | 'paste' | 'pasteAvailability' | 'pin'> & {
    close: Omit<NonNullable<ItemMenu['close']>, 'label'>;
    items: readonly SelectableDragItem[];
    tabIds: readonly number[];
  },
) {
  actions.openMenu(event, `Actions for ${title}`, itemMenuEntries({
    count: items.length,
    ...entries,
    ...clipboardEntries(actions, items),
    reload: tabIds.length > 0 ? { label: 'Reload', run: () => actions.reloadTabs(tabIds) } : undefined,
    close: { label: 'Close', ...close },
  }));
}

/** Middle-click takes a tile off the bar; with Ctrl or Cmd it closes the tile's tabs too. */
const tileAuxClick = (close: () => void, remove: () => void) => (event: MouseEvent<HTMLElement>) => {
  if (event.button !== 1) return;
  event.preventDefault();
  if (event.ctrlKey || event.metaKey) close();
  else remove();
};

const favouriteTitle = (node: BookmarkNode) =>
  visibleBookmarkTitle(node) || node.url || 'Untitled bookmark';

const recentTitle = (tab: OpenTab, { tabTitles }: TabTileState) =>
  tabTitles[tab.id] ?? tabDisplayTitle(tab);

/** The address a tile's name may not show, for assistive technology. */
const addressDescription = (title: string, url?: string) => {
  const address = url?.trim();
  return address && address !== title ? address : undefined;
};

const tabItem = (tab: OpenTab, title: string, extensionOrigin: string) => ({
  kind: 'tab' as const,
  tabId: tab.id,
  title,
  windowId: tab.windowId,
  index: tab.index,
  bookmarkable: Boolean(bookmarkableTabUrl(tab, extensionOrigin)),
});

const favouriteItem = (node: BookmarkNode, index: number) => ({
  kind: 'favourite' as const,
  nodeId: node.id,
  title: favouriteTitle(node),
  index,
});

const uniqueIds = (ids: readonly number[]) => [...new Set(ids)];

const groupLabel = (group: FavouriteGroup, kind: string, current: boolean) =>
  `${group.domain}, ${group.entries.length} ${kind}${current ? ', current' : ''}, grouped`;

const groupTileProps = (tileGroup: TileGroup | undefined) => tileGroup
  ? { 'aria-haspopup': 'true' as const, 'aria-expanded': tileGroup.open }
  : {};

const tileSpaceStyle = (spaceId: string | undefined, { spaceColours }: TileSpaces) =>
  spaceId && spaceColours[spaceId]
    ? { '--tile-space-colour': spaceColours[spaceId] } as CSSProperties
    : undefined;

/** The space a slot's tile wears the colour of, as its tile works it out; none without a colour. */
const tileSpaceId = (slot: FavouriteBarSlot, { activeSpaceId, spaceColours, spaceIdsByPageIdentity, spaces, tabSpaceIds }: TileSpaces) => {
  const spaceId = slot.kind === 'favourite'
    ? openSpaceForPage(slot.node.url, activeSpaceId, spaces, spaceIdsByPageIdentity)
    : slot.kind === 'recent' ? tabSpaceIds[slot.tab.id] : undefined;
  return spaceId && spaceColours[spaceId] ? spaceId : undefined;
};

function FavouriteTile({
  node,
  index,
  activeNodeId,
  onActivateNode,
  tabsByPageIdentity,
  audioStateByTabId,
  onOpen,
  onCloseTabs,
  onRenameTitle,
  onInteractionError,
  onUnpin,
  onUnpinMany,
  dropDisabled,
  column,
  tileGroup,
  tileSpaces,
  windowId,
}: FavouriteActions & {
  column: boolean;
  node: BookmarkNode;
  tileGroup?: TileGroup;
  tileSpaces: TileSpaces;
  windowId: number | null;
  index: number;
  activeNodeId?: string;
  onActivateNode: (nodeId: string) => void;
  tabsByPageIdentity: TabIdentityIndex;
}) {
  const actions = useContext(ItemActionsContext);
  const title = favouriteTitle(node);
  const [editingTitle, setEditingTitle] = useState(false);
  const gesture = useItemGesture();
  const titleDoubleClick = useTitleDoubleClick();
  const dragData = favouriteItem(node, index);
  const group = tileGroup?.group;
  const sortable = useSortable({
    id: `favourite:${node.id}`,
    disabled: dropDisabled,
    data: dragData,
  });
  const { openTabs, isSleeping } = bookmarkTabStatus(
    tabsByPageIdentity,
    node.url,
  );
  const groupNodes = group ? groupFavourites(group) : [node];
  // A group's favourites anywhere, and its other tabs in this window.
  const shownTabs = group
    ? [...groupNodes.flatMap((member) => bookmarkTabStatus(tabsByPageIdentity, member.url).openTabs), ...groupTabs(group)]
    : openTabs;
  const isCurrent = shownTabs.some((tab) => tab.active && tab.windowId === windowId);
  const openTabIds = uniqueIds(shownTabs.flatMap((tab) => tab.id === undefined ? [] : [tab.id]));
  // The space opening the favourite goes to, so the tile wears its colour.
  const { activeSpaceId, spaces, spaceIdsByPageIdentity } = tileSpaces;
  const openSpaceId = openSpaceForPage(node.url, activeSpaceId, spaces, spaceIdsByPageIdentity);
  const openSpace = spaces.find((space) => space.id === openSpaceId);
  const open = openTabs.length > 0 || openSpace !== undefined;
  const spaceStyle = tileSpaceStyle(openSpace?.id, tileSpaces);
  const style = {
    transform: CSS.Transform.toString(sortable.transform),
    transition: sortable.transition,
  };
  const unpin = () => group ? onUnpinMany(groupNodes) : onUnpin(node);
  const closeFavourite = () => {
    if (openTabIds.length > 0) onCloseTabs(openTabIds);
    unpin();
  };
  const openMenu = (event: MouseEvent<HTMLElement>) => {
    if (!actions) return;
    const items: SelectableDragItem[] = group
      ? group.entries.flatMap((entry) => entry.kind === 'favourite'
        ? [{ ...favouriteItem(entry.node, entry.index), itemCount: 1 }]
        : [])
      : [{ ...dragData, itemCount: 1 }];
    openTileMenu(actions, event, group?.domain ?? title, {
      close: { run: closeFavourite, shortcut: middleClickLabel(true) },
      items,
      pin: { kind: 'unpin', run: unpin, shortcut: middleClickLabel() },
      ...pasteEntries(actions, { kind: 'favourite-slot', index }),
      tabIds: openTabIds,
    });
  };

  return (
    <div
      ref={sortable.setNodeRef}
      className={`favourite-tile-wrap${sortable.isDragging ? ' is-dragging' : ''}`}
      style={style}
      data-bookmark-node-id={node.id}
    >
      <div
        className={`favourite-tile is-pinned${open ? ' is-open' : ''}${spaceStyle ? ' has-space' : ''}${isSleeping ? ' is-sleeping' : ''}${isCurrent || activeNodeId === node.id ? ' is-active' : ''}${editingTitle ? ' is-editing-title' : ''}${group ? ' is-group' : ''}`}
        onClick={(event) => {
          if (event.button !== 0) return;
          if (!gesture.isClick(event)) return;
          if (tileGroup) {
            tileGroup.onToggle();
            return;
          }
          const rename = titleDoubleClick(event, !event.altKey);
          if (activeNodeId === node.id && rename) {
            setEditingTitle(true);
            return;
          }
          onActivateNode(node.id);
          if (node.url) onOpen(node.url, event.altKey);
        }}
        onAuxClick={tileAuxClick(closeFavourite, unpin)}
        onMouseDown={(event) => event.button === 1 && event.preventDefault()}
        onContextMenu={openMenu}
        aria-label={group ? `${groupLabel(group, 'items', isCurrent)}, pinned` : `${title}, pinned${openTabs.length ? `, open in ${openTabs.length} tab${openTabs.length === 1 ? '' : 's'}${isSleeping ? ', sleeping' : ''}` : openSpace ? `, open in ${openSpace.title}` : ''}`}
        aria-description={addressDescription(title, node.url)}
        title={column && !editingTitle ? title : undefined}
        style={spaceStyle}
        data-space-id={openSpace?.id}
        data-url={node.url}
        data-group-domain={group?.domain}
        draggable={Boolean(sortable.listeners) && !editingTitle}
        {...sortable.attributes}
        {...groupTileProps(tileGroup)}
        {...sortable.listeners}
        onPointerDownCapture={gesture.onPointerDownCapture}
      >
        <Favicon
          audioState={faviconAudioStateForTabs(openTabs, audioStateByTabId)}
          loading={faviconLoadingForTabs(openTabs)}
          url={node.url ?? ''}
          title={title}
          size="large"
          sourceUrl={bestTabFaviconUrl(openTabs)}
        />
        {openTabs.length > 1 && (
          <span className="tab-count" aria-hidden="true">
            {openTabs.length}
          </span>
        )}
        <span className="favourite-pin" aria-hidden="true">
          <Pin size={7} strokeWidth={2.6} />
        </span>
        <InlineItemTitle
          allowBlank
          title={title}
          className="favourite-title"
          editing={editingTitle}
          onCancel={() => setEditingTitle(false)}
          onSave={(nextTitle) => onRenameTitle(node, nextTitle)}
          onError={onInteractionError}
        />
      </div>
    </div>
  );
}

/** One of the window's recent tabs, shown in a slot no favourite is pinned to. */
function RecentTabTile({
  tab,
  index,
  pinSlot,
  extensionOrigin,
  audioStateByTabId,
  dropDisabled,
  onFocusTab,
  onPin,
  onCloseTabs,
  onDismiss,
  column,
  tileGroup,
  tileSpaces,
  tabState,
}: FavouriteActions & {
  column: boolean;
  tab: OpenTab;
  tileGroup?: TileGroup;
  tileSpaces: TileSpaces;
  tabState: TabTileState;
  /** The favourite slot this tile stands in; none for a slot past the favourites' own. */
  index: number | undefined;
  /** Where pinning or pasting on this tile puts the favourite, if anywhere is free. */
  pinSlot: number | undefined;
  extensionOrigin: string;
  /** Takes the tabs off the bar, leaving them open. */
  onDismiss: (tabs: readonly OpenTab[]) => void;
}) {
  const actions = useContext(ItemActionsContext);
  const gesture = useItemGesture();
  const group = tileGroup?.group;
  const tabs = group ? groupTabs(group) : [tab];
  const tabIds = tabs.map((member) => member.id);
  const title = recentTitle(tab, tabState);
  const url = tabUrl(tab);
  const spaceId = tileSpaces.tabSpaceIds[tab.id];
  const spaceStyle = tileSpaceStyle(spaceId, tileSpaces);
  const dragData = tabItem(tab, title, extensionOrigin);
  const { bookmarkable } = dragData;
  const active = tabs.some((member) => member.active);
  const draggable = useDraggable({
    id: `recent-tab:${tab.id}`,
    disabled: dropDisabled,
    data: dragData,
  });
  const droppable = useDroppable({
    id: index === undefined ? `recent-tab-slot:${tab.id}` : `favourite-slot:${index}`,
    disabled: dropDisabled || draggable.isDragging || index === undefined,
    data: { kind: 'favourite-slot', index: index ?? -1 },
  });
  const openMenu = (event: MouseEvent<HTMLElement>) => {
    if (!actions) return;
    const items: SelectableDragItem[] = tabs.map((member) => ({
      ...tabItem(member, recentTitle(member, tabState), extensionOrigin),
      itemCount: 1,
    }));
    openTileMenu(actions, event, group?.domain ?? title, {
      close: { run: () => onCloseTabs(tabIds), shortcut: middleClickLabel(true) },
      dismiss: { label: 'Remove', run: () => onDismiss(tabs), shortcut: middleClickLabel() },
      items,
      pin: bookmarkable && pinSlot !== undefined ? { kind: 'pin', run: () => onPin(tab.id, pinSlot) } : undefined,
      ...(pinSlot === undefined ? {} : pasteEntries(actions, { kind: 'favourite-slot', index: pinSlot })),
      tabIds,
    });
  };

  return (
    <div
      ref={(element) => {
        draggable.setNodeRef(element);
        droppable.setNodeRef(element);
      }}
      className={`favourite-tile-wrap is-recent${draggable.isDragging ? ' is-dragging' : ''}${droppable.isOver ? ' is-over' : ''}`}
      data-recent-tab-id={tab.id}
    >
      <div
        className={`favourite-tile is-recent${spaceStyle ? ' has-space' : ''}${active ? ' is-active' : ''}${tab.discarded ? ' is-sleeping' : ''}${group ? ' is-group' : ''}`}
        onClick={(event) => {
          if (event.button !== 0) return;
          if (!gesture.isClick(event)) return;
          if (tileGroup) tileGroup.onToggle();
          else onFocusTab(tab);
        }}
        onAuxClick={tileAuxClick(() => onCloseTabs(tabIds), () => onDismiss(tabs))}
        onMouseDown={(event) => event.button === 1 && event.preventDefault()}
        onContextMenu={openMenu}
        aria-label={group ? groupLabel(group, 'recent tabs', active) : `${title}, recent tab${tab.active ? ', current' : ''}`}
        aria-description={group ? undefined : addressDescription(title, url)}
        title={column ? title : undefined}
        style={spaceStyle}
        data-space-id={spaceStyle ? spaceId : undefined}
        data-url={url}
        data-group-domain={group?.domain}
        {...draggable.attributes}
        {...groupTileProps(tileGroup)}
        {...draggable.listeners}
        onPointerDownCapture={gesture.onPointerDownCapture}
      >
        <Favicon
          audioState={faviconAudioStateForTabs([tab], audioStateByTabId)}
          loading={faviconLoadingForTabs([tab])}
          url={url ?? ''}
          title={title}
          size="large"
          sourceUrl={bestTabFaviconUrl([tab])}
        />
        <span className="favourite-title">{title}</span>
      </div>
    </div>
  );
}

function FavouritePlaceholder({
  index,
  dropDisabled,
}: {
  index: number;
  dropDisabled?: boolean;
}) {
  const actions = useContext(ItemActionsContext);
  // A slot past the favourites' own holds recent tabs only, so nothing pins into it.
  const extra = index >= MAX_FAVOURITES;
  const dropZone = useDroppable({
    id: `favourite-slot:${index}`,
    disabled: dropDisabled || extra,
    data: { kind: 'favourite-slot', index },
  });
  const pasteTarget = { kind: 'favourite-slot' as const, index };

  if (extra) return <div className="favourite-placeholder" aria-label={`Empty recent tab slot ${index + 1}`} />;
  return (
    <div
      ref={dropZone.setNodeRef}
      className={`favourite-placeholder${dropZone.isOver ? ' is-over' : ''}`}
      aria-label={`Empty favourite slot ${index + 1}`}
      onContextMenu={(event) => actions?.openMenu(event, `Favourite slot ${index + 1}`, itemMenuEntries({
        count: 1,
        ...pasteEntries(actions, pasteTarget),
      }))}
    />
  );
}

/** Opens the bookmarks kept outside every space, and takes what is dropped on it. */
export function GlobalBookmarksButton({
  open,
  arming,
  dropDisabled,
  onToggle,
}: {
  open: boolean;
  arming?: boolean;
  dropDisabled?: boolean;
  onToggle: () => void;
}) {
  const dropZone = useDroppable({
    id: 'global-bookmarks',
    disabled: dropDisabled,
    data: { kind: 'global-bookmarks' },
  });
  return (
    <button
      ref={dropZone.setNodeRef}
      type="button"
      className={`favourite-tile global-bookmarks-button${open ? ' is-active' : ''}${dropZone.isOver ? ' is-over' : ''}${arming ? ' is-drag-arming' : ''}`}
      aria-label="Global bookmarks"
      aria-expanded={open}
      aria-controls="global-bookmarks-panel"
      {...shortcutButtonProps('globalBookmarks', open ? 'Close global bookmarks' : 'Global bookmarks')}
      onClick={onToggle}
    >
      {open
        ? <X size={17} strokeWidth={2} aria-hidden="true" />
        : <Bookmark size={17} strokeWidth={2} aria-hidden="true" />}
    </button>
  );
}

/**
 * One slot of the bar. In the single column too narrow for the lists, a tile
 * in the same space as the one above or below joins it into one block.
 */
function SlotCell({ children, hovered, id, joins }: {
  children: ReactNode;
  hovered: boolean;
  id: string;
  joins: { previous: boolean; next: boolean };
}) {
  const reduceMotion = useReducedMotion();
  return (
    <motion.div
      layout={reduceMotion ? false : 'position'}
      transition={{ type: 'tween', duration: 0.22, ease: [0.2, 0, 0, 1] }}
      className={`favourite-slot${hovered ? ' is-hovered' : ''}${joins.previous ? ' joins-previous' : ''}${joins.next ? ' joins-next' : ''}`}
      role="listitem"
      data-slot-id={id}
    >
      {children}
    </motion.div>
  );
}

const slotKey = (slot: FavouriteBarSlot) => slot.kind === 'favourite'
  ? `favourite:${slot.node.id}`
  : slot.kind === 'recent'
    ? `recent:${slot.group ? slot.group.key : slot.tab.id}`
    : `empty:${slot.index}`;

const slotGroup = (slot: FavouriteBarSlot | undefined) =>
  slot && slot.kind !== 'empty' ? slot.group : undefined;

/** The lowest favourite slot with no favourite in it, if any. */
const firstFreeFavouriteSlot = (favourites: FavouritesGridProps['favourites']) =>
  Array.from({ length: MAX_FAVOURITES }, (_, index) => index).find((index) => !favourites[index]);

/** What a grouped tile's list rows do, each as its tile would do for one item. */
function useGroupRowActions(
  props: FavouritesGridProps,
  dismiss: (tabs: readonly OpenTab[]) => void,
): FavouriteGroupRowActions {
  const actions = useContext(ItemActionsContext);
  const freeSlot = firstFreeFavouriteSlot(props.favourites);
  const entryTitle: FavouriteGroupRowActions['entryTitle'] = (entry) => entry.kind === 'tab'
    ? recentTitle(entry.tab, props.tabState)
    : favouriteTitle(entry.node);
  const { activeSpaceId, spaces, spaceColours, spaceIdsByPageIdentity, tabSpaceIds } = props.tileSpaces;
  return {
    audioStateByTabId: props.audioStateByTabId,
    entryTitle,
    // A tab's own space; a favourite's is its most recent tab's here, else where opening it goes.
    entrySpace: (entry) => {
      const lead = entry.kind === 'tab' ? entry.tab : entry.tabs[0];
      const id = lead
        ? tabSpaceIds[lead.id]
        : entry.kind === 'favourite' ? openSpaceForPage(entry.node.url, activeSpaceId, spaces, spaceIdsByPageIdentity) : undefined;
      const space = spaces.find((candidate) => candidate.id === id);
      return space && { id: space.id, colour: spaceColours[space.id], title: space.title };
    },
    onActivate: (entry) => {
      if (entry.kind === 'tab') props.onFocusTab(entry.tab);
      else if (entry.node.url) props.onOpen(entry.node.url, false);
    },
    closeEntry: (entry) => {
      const tabIds = entry.kind === 'tab' ? [entry.tab.id] : entry.tabs.map((tab) => tab.id);
      return tabIds.length > 0 ? () => props.onCloseTabs(tabIds) : undefined;
    },
    onMenu: (event, entry) => {
      if (!actions) return;
      const title = entryTitle(entry);
      if (entry.kind === 'tab') {
        const item = tabItem(entry.tab, title, props.extensionOrigin);
        openTileMenu(actions, event, title, {
          close: { run: () => props.onCloseTabs([entry.tab.id]), shortcut: middleClickLabel() },
          dismiss: { label: 'Remove', run: () => dismiss([entry.tab]) },
          items: [{ ...item, itemCount: 1 }],
          pin: item.bookmarkable && freeSlot !== undefined
            ? { kind: 'pin', run: () => props.onPin(entry.tab.id, freeSlot) }
            : undefined,
          tabIds: [entry.tab.id],
        });
        return;
      }
      const openTabIds = bookmarkTabStatus(props.tabsByPageIdentity, entry.node.url).openTabs
        .flatMap((tab) => tab.id === undefined ? [] : [tab.id]);
      const tabIds = uniqueIds([...openTabIds, ...entry.tabs.map((tab) => tab.id)]);
      openTileMenu(actions, event, title, {
        close: {
          run: () => {
            if (tabIds.length > 0) props.onCloseTabs(tabIds);
            props.onUnpin(entry.node);
          },
        },
        items: [{ ...favouriteItem(entry.node, entry.index), itemCount: 1 }],
        pin: { kind: 'unpin', run: () => props.onUnpin(entry.node) },
        tabIds,
      });
    },
  };
}

export function FavouritesGrid(props: FavouritesGridProps) {
  const [activeNodeId, setActiveNodeId] = useState<string>();
  useEffect(() => {
    if (!activeNodeId) return;
    const timeout = window.setTimeout(() => {
      setActiveNodeId((current) => current === activeNodeId ? undefined : current);
    }, 1200);
    return () => window.clearTimeout(timeout);
  }, [activeNodeId]);
  const dropZone = useDroppable({
    id: 'favourite-zone',
    disabled: props.dropDisabled,
    data: { kind: 'favourite-zone' },
  });
  const hover = useFavouriteHover();
  const listPlacement = useFavouriteGroupPlacement();
  const hoveredSlotId = props.dragging ? undefined : hover.slotId;
  const groupList = useFavouriteGroupList({
    gridRef: hover.gridRef,
    hoverSlotId: hoveredSlotId,
    listRef: hover.listRef,
  });
  const groupByDomain = props.groupByDomain && !props.column;
  const { columns, slotCount } = useFavouriteSlotCount(hover.gridRef);
  const { dismiss, slots } = useFavouriteBar({
    barRef: hover.gridRef,
    dragging: props.dragging,
    extensionOrigin: props.extensionOrigin,
    favourites: props.favourites,
    groupByDomain,
    hold: groupList.openSlotId !== undefined,
    backgroundMusicTabIds: props.backgroundMusicTabIds,
    column: props.column,
    slotCount,
    tabBookmarkLinks: props.tabState.tabBookmarkLinks,
    tabs: props.tabs,
    windowId: props.windowId,
  });
  const rowActions = useGroupRowActions(props, dismiss);
  const slotById = (id: string | undefined) => slots.find((slot) => slotKey(slot) === id);
  // The pointer's tile wins, unless only a click opens lists; otherwise a list kept open by a click or keyboard focus.
  const openSlotId = props.dragging ? undefined : groupList.openSlotId;
  const shownSlotId = listPlacement.clickOnly ? openSlotId : hoveredSlotId ?? openSlotId;
  const shownGroup = shownSlotId === groupList.closedSlotId ? undefined : slotGroup(slotById(shownSlotId));
  const hoveredSlot = shownGroup && hoveredSlotId === shownSlotId ? undefined : slotById(hoveredSlotId);
  const hoveredTitle = slotGroup(hoveredSlot)?.domain ?? (hoveredSlot?.kind === 'favourite'
    ? favouriteTitle(hoveredSlot.node)
    : hoveredSlot?.kind === 'recent' ? recentTitle(hoveredSlot.tab, props.tabState) : undefined);
  const highlightedSlotId = shownGroup ? shownSlotId : hoveredTitle === undefined ? undefined : hoveredSlotId;
  const listGridHandlers = groupList.gridHandlers((id) => Boolean(slotGroup(slotById(id))));
  const openGroup = slotGroup(slotById(groupList.openSlotId));
  const lastOpenGroup = useRef<FavouriteGroup>(undefined);
  useEffect(() => {
    if (openGroup) lastOpenGroup.current = openGroup;
    if (!groupList.openSlotId || openGroup) return;
    const active = document.activeElement;
    const focusWasInList = !active || active === document.body || Boolean(hover.listRef.current?.contains(active));
    groupList.close(groupList.openSlotId, false);
    // A list that shrinks to one entry under the keyboard hands focus to the tile that entry now has.
    const keys = lastOpenGroup.current?.entries.map((entry) => entry.kind === 'tab' ? `recent:${entry.tab.id}` : `favourite:${entry.node.id}`) ?? [];
    const target = focusWasInList ? slots.find((slot) => keys.includes(slotKey(slot))) : undefined;
    if (target) hover.gridRef.current?.querySelector<HTMLElement>(`[data-slot-id="${globalThis.CSS.escape(slotKey(target))}"] .favourite-tile`)?.focus();
  });
  const slotSpaceIds = slots.map((slot) => tileSpaceId(slot, props.tileSpaces));
  const joins = (index: number) => {
    const spaceId = slotSpaceIds[index];
    return {
      previous: spaceId !== undefined && slotSpaceIds[index - 1] === spaceId,
      next: spaceId !== undefined && slotSpaceIds[index + 1] === spaceId,
    };
  };
  const tileGroup = (slot: FavouriteBarSlot): TileGroup | undefined => {
    const group = slotGroup(slot);
    const id = slotKey(slot);
    return group
      ? { group, open: shownGroup === group, onToggle: () => groupList.toggle(id) }
      : undefined;
  };

  return (
    <section className="favourites-section" aria-label="Favourites">
      <SortableContext
        items={slots.flatMap((slot) => slot.kind === 'favourite' ? [`favourite:${slot.node.id}`] : [])}
        strategy={rectSortingStrategy}
      >
        <div
          ref={(element) => {
            dropZone.setNodeRef(element);
            hover.gridRef.current = element;
          }}
          {...hover.gridHandlers}
          {...listGridHandlers}
          className={`favourites-grid${dropZone.isOver ? ' is-over' : ''}`}
          style={{ '--favourite-columns': columns } as CSSProperties}
          role="list"
          aria-label="Favourite bookmarks"
        >
          {slots.map((slot, index) => (
            <SlotCell
              key={slotKey(slot)}
              id={slotKey(slot)}
              hovered={slotKey(slot) === highlightedSlotId}
              joins={joins(index)}
            >
              {slot.kind === 'favourite' ? (
                <FavouriteTile
                  {...props}
                  node={slot.node}
                  index={slot.index}
                  activeNodeId={activeNodeId}
                  onActivateNode={setActiveNodeId}
                  tileGroup={tileGroup(slot)}
                />
              ) : slot.kind === 'recent' ? (
                <RecentTabTile
                  {...props}
                  tab={slot.tab}
                  index={slot.index < MAX_FAVOURITES ? slot.index : undefined}
                  pinSlot={slot.index < MAX_FAVOURITES ? slot.index : firstFreeFavouriteSlot(props.favourites)}
                  onDismiss={dismiss}
                  tileGroup={tileGroup(slot)}
                />
              ) : (
                <FavouritePlaceholder index={slot.index} dropDisabled={props.dropDisabled} />
              )}
            </SlotCell>
          ))}
          <div className="favourite-slot global-bookmarks-slot" role="listitem">
            <GlobalBookmarksButton
              open={props.globalBookmarksOpen}
              arming={props.globalBookmarksArming}
              dropDisabled={props.globalBookmarksDropDisabled}
              onToggle={props.onToggleGlobalBookmarks}
            />
          </div>
        </div>
      </SortableContext>
      {!props.column && (
        <FavouriteHoverLabel
          grid={hover.gridRef}
          labelRef={hover.labelRef}
          onPointerLeave={hover.onLabelPointerLeave}
          slotId={hoveredTitle === undefined ? undefined : hoveredSlotId}
          text={hoveredTitle}
        />
      )}
      <FavouriteGroupList
        group={shownGroup}
        gridRef={hover.gridRef}
        listRef={hover.listRef}
        onBlur={groupList.onListBlur}
        onClose={(refocusTile) => shownSlotId && groupList.close(shownSlotId, refocusTile)}
        onFocusHandled={groupList.onFocusHandled}
        onPointerLeave={hover.onListPointerLeave}
        focusRequest={groupList.focusRequest}
        placement={listPlacement.placement}
        rowActions={rowActions}
        slotId={shownGroup ? shownSlotId : undefined}
        windowId={props.windowId}
      />
    </section>
  );
}
