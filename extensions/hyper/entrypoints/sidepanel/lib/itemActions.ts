import {
  BookmarkMinus,
  BookmarkPlus,
  Broom,
  CircleMinus,
  ClipboardPaste,
  Columns2,
  Copy,
  Pencil,
  Pin,
  PinOff,
  RefreshCw,
  Scissors,
  SquareStack,
  Trash2,
  X,
  type LucideIcon,
} from 'lucide-react';
import { createContext, type MouseEvent } from 'react';
import type { SearchItem } from '../../lib/search';
import { shortcutLabel } from '../../lib/shortcuts';
import { menuGroups, type ContextMenuEntry } from '../components/ContextMenu';
import type { SelectableDragItem } from '../types';
import type { PasteTarget } from './clipboardItems';

/** What a row's context menu and keys can ask of the sidebar beyond the row itself. */
export interface ItemActions {
  /** The rows an action on this one covers: the selection when it holds the row, else the row alone. */
  itemsFor(item: SelectableDragItem): SelectableDragItem[];
  /** Opens a row's menu at the pointer, or below the row when a key asked for it. */
  openMenu(event: MouseEvent<HTMLElement>, label: string, entries: ContextMenuEntry[]): void;
  clipboard(operation: 'copy' | 'cut', items: readonly SelectableDragItem[]): void;
  paste(target: PasteTarget): void;
  canPaste(target: PasteTarget): () => Promise<boolean>;
  reloadTabs(tabIds: readonly number[]): void;
  /** Moves the rows to each other space, as dropping them on its dot would. */
  spaceEntries(items: readonly SelectableDragItem[]): ContextMenuEntry[];
  /** Shows the row beside the window's current tab, when the browser's split view has room. */
  splitBesideCurrentTab(item: SelectableDragItem): (() => void) | undefined;
  closeTabs(tabIds: readonly number[]): void;
  /** The tabs the rows hold: tabs themselves, and the tabs inside tab folders. */
  tabIdsOf(items: readonly SelectableDragItem[]): number[];
  /** Removes bookmarks as dropping them on the bin does. */
  removeItems(items: readonly SelectableDragItem[]): void;
  /** Opens the editor F2 opens. */
  editBookmark(nodeId: string): void;
  /** Deletes as the Delete key does. */
  deleteBookmark(nodeId: string): void;
  duplicateBookmark(nodeId: string): void;
  /** A search result's menu: its row's, when the sidebar shows the result. */
  searchMenu(item: SearchItem): ContextMenuEntry[];
}

export const ItemActionsContext = createContext<ItemActions | undefined>(undefined);

/** A tab action's label: `single` for one tab, else the verb and how many. */
export const countedTabsLabel = (verb: string, single: string) => (count: number) =>
  count === 1 ? single : `${verb} ${count} tabs`;

export const closeTabsLabel = countedTabsLabel('Close', 'Close tab');
export const reloadTabsLabel = countedTabsLabel('Reload', 'Reload');

/** Cut and Copy for the rows a menu covers. */
export const clipboardEntries = (
  actions: Pick<ItemActions, 'clipboard'>,
  items: readonly SelectableDragItem[],
): Pick<ItemMenu, 'copy' | 'cut'> => ({
  cut: () => actions.clipboard('cut', items),
  copy: () => actions.clipboard('copy', items),
});

export const pasteEntries = (
  actions: Pick<ItemActions, 'canPaste' | 'paste'>,
  target: PasteTarget,
): Pick<ItemMenu, 'paste' | 'pasteAvailability'> => ({
  paste: () => actions.paste(target),
  pasteAvailability: actions.canPaste(target),
});

/** Reload and Close for the open tabs the rows hold, when they hold any. */
export const openTabEntries = (
  actions: Pick<ItemActions, 'closeTabs' | 'reloadTabs'>,
  tabIds: readonly number[],
  close: (tabIds: number[]) => void = actions.closeTabs,
): Pick<ItemMenu, 'close' | 'reload'> => tabIds.length === 0 ? {} : {
  reload: { label: reloadTabsLabel(tabIds.length), run: () => actions.reloadTabs(tabIds) },
  close: { label: closeTabsLabel(tabIds.length), run: () => close([...tabIds]) },
};

export const BOOKMARK_LABELS: Readonly<Record<'create' | 'remove' | 'update', string>> = {
  create: 'Bookmark',
  remove: 'Remove bookmark',
  update: 'Update bookmark',
};

interface MenuAction {
  label: string;
  run: () => void;
  /** A tooltip saying what the action does beyond its label. */
  hint?: string;
  /** Why the action cannot be done here: shown disabled, with this as its tooltip. */
  unavailable?: string;
  /** The key or click that does the same, shown beside the label. */
  shortcut?: string;
}

/** The menu entry fields a `MenuAction` sets beyond its label and icon. */
const actionState = (action: MenuAction) => ({
  onSelect: action.run,
  ...(action.shortcut ? { shortcut: action.shortcut } : {}),
  ...(action.unavailable ? { disabled: true, hint: action.unavailable } : action.hint ? { hint: action.hint } : {}),
});

export interface ItemMenu {
  /** How many rows the selection-wide actions cover. */
  count: number;
  rename?: () => void;
  /** The key that renames the row too, where there is one. */
  renameKey?: string;
  duplicate?: () => void;
  bookmark?: MenuAction & { kind: 'create' | 'remove' | 'update' };
  split?: MenuAction;
  /** Pins a tab to the favourites bar, or unpins a favourite while keeping its tabs. */
  pin?: { kind: 'pin' | 'unpin'; run: () => void; shortcut?: string };
  cut?: () => void;
  copy?: () => void;
  paste?: () => void;
  pasteAvailability?: () => Promise<boolean>;
  /** Why nothing can be pasted here: Paste shows disabled, with this as its tooltip. */
  pasteUnavailable?: string;
  reload?: MenuAction;
  closeDuplicates?: () => void;
  /** Takes the item off where it shows without closing or deleting anything. */
  dismiss?: MenuAction;
  close?: MenuAction;
  remove?: MenuAction;
  spaces?: ContextMenuEntry[];
}

const BOOKMARK_ICONS: Record<'create' | 'remove' | 'update', LucideIcon> = {
  create: BookmarkPlus,
  remove: BookmarkMinus,
  update: RefreshCw,
};

/** A row's menu in a fixed order, so every kind of row reads alike. */
export function itemMenuEntries(menu: ItemMenu): ContextMenuEntry[] {
  const items = (count: number) => count === 1 ? '' : ` ${count} items`;
  const groups: ContextMenuEntry[][] = [
    [
      ...(menu.rename ? [{
        icon: Pencil,
        id: 'rename',
        label: 'Rename',
        onSelect: menu.rename,
        ...(menu.renameKey ? { shortcut: menu.renameKey } : {}),
      }] : []),
      ...(menu.duplicate ? [{ icon: SquareStack, id: 'duplicate', label: 'Duplicate', onSelect: menu.duplicate }] : []),
      ...(menu.bookmark ? [{
        icon: BOOKMARK_ICONS[menu.bookmark.kind],
        id: 'bookmark',
        label: menu.bookmark.label,
        onSelect: menu.bookmark.run,
      }] : []),
      ...(menu.split ? [{ icon: Columns2, id: 'split', label: menu.split.label, onSelect: menu.split.run }] : []),
      ...(menu.pin ? [{
        icon: menu.pin.kind === 'pin' ? Pin : PinOff,
        id: menu.pin.kind,
        label: menu.pin.kind === 'pin' ? 'Pin' : 'Unpin',
        onSelect: menu.pin.run,
        ...(menu.pin.shortcut ? { shortcut: menu.pin.shortcut } : {}),
      }] : []),
    ],
    [
      ...([[menu.cut, Scissors, 'cut', 'Cut', 'cutItem'], [menu.copy, Copy, 'copy', 'Copy', 'copyItem']] as const)
        .flatMap(([onSelect, icon, id, label, shortcut]) => onSelect ? [{
          icon,
          id,
          label: `${label}${items(menu.count)}`,
          onSelect,
          shortcut: shortcutLabel(shortcut),
        }] : []),
      ...(menu.paste ? [{
        icon: ClipboardPaste,
        id: 'paste',
        label: 'Paste',
        onSelect: menu.paste,
        ...(menu.pasteUnavailable
          ? { disabled: true, hint: menu.pasteUnavailable }
          : menu.pasteAvailability ? { isAvailable: menu.pasteAvailability } : {}),
        shortcut: shortcutLabel('pasteItem'),
      }] : []),
      ...(menu.reload ? [{ icon: RefreshCw, id: 'reload', label: menu.reload.label, ...actionState(menu.reload) }] : []),
    ],
    [
      ...(menu.closeDuplicates ? [{
        icon: Broom,
        id: 'close-duplicates',
        label: 'Close duplicates',
        onSelect: menu.closeDuplicates,
      }] : []),
      ...(menu.dismiss ? [{ icon: CircleMinus, id: 'dismiss', label: menu.dismiss.label, ...actionState(menu.dismiss) }] : []),
      ...(menu.close ? [{ icon: X, id: 'close', label: menu.close.label, ...actionState(menu.close) }] : []),
      ...(menu.remove ? [{
        danger: true,
        icon: Trash2,
        id: 'remove',
        label: menu.remove.label,
        onSelect: menu.remove.run,
      }] : []),
    ],
    menu.spaces ?? [],
  ];
  return menuGroups(groups);
}
