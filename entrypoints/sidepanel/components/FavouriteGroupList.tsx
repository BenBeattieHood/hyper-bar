import { Pin, X } from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type RefObject,
} from 'react';
import {
  Favicon,
  faviconAudioStateForTabs,
  faviconLoadingForTabs,
  type FaviconAudioStates,
} from './Favicon';
import { bestTabFaviconUrl } from '../../lib/bookmarks';
import { orderEntriesBySpace, type FavouriteGroup, type FavouriteGroupEntry } from '../lib/favouriteBar';
import { tileListBox, type FavouriteGroupPlacement } from '../lib/favouriteGroupPlacement';
import { isWithin, listen } from '../lib/listen';
import { popoverMotion } from './WorkspaceMotion';
import { tabUrl } from '../../lib/urlIdentity';
import './FavouriteGroupList.css';

const tileIn = (grid: HTMLElement | null, slotId: string) =>
  grid?.querySelector<HTMLElement>(`[data-slot-id="${CSS.escape(slotId)}"] .favourite-tile`) ?? null;

export const groupEntryKey = (entry: FavouriteGroupEntry) =>
  entry.kind === 'tab' ? `tab:${entry.tab.id}` : `favourite:${entry.node.id}`;

/**
 * Which grouped tile's list is open, besides the one under the pointer. A click
 * or keyboard focus keeps a list open until Escape, a choice from it, another
 * click on its tile, or a click or focus elsewhere. Closing it also hides it
 * from the pointer still over it, until the pointer moves to another tile.
 */
export function useFavouriteGroupList({
  gridRef,
  hoverSlotId,
  listRef,
}: {
  gridRef: RefObject<HTMLElement | null>;
  hoverSlotId?: string;
  listRef: RefObject<HTMLElement | null>;
}) {
  const [openSlotId, setOpenSlotId] = useState<string>();
  const [closedSlotId, setClosedSlotId] = useState<string>();
  const [focusRequest, setFocusRequest] = useState<'first' | 'last'>();
  // Focus Hyper hands back to a tile must not reopen its list.
  const refocusing = useRef(false);

  useEffect(() => setClosedSlotId(undefined), [hoverSlotId]);
  const outside = (target: EventTarget | null) => !isWithin(gridRef.current, target) && !isWithin(listRef.current, target);
  const closeOnLeave = (event: FocusEvent<HTMLElement>) => {
    if (outside(event.relatedTarget)) setOpenSlotId(undefined);
  };

  useEffect(() => {
    if (!openSlotId) return;
    const pointerDown = (event: globalThis.PointerEvent) => {
      if (outside(event.target)) setOpenSlotId(undefined);
    };
    return listen([document, 'pointerdown', pointerDown, true]);
  }, [gridRef, listRef, openSlotId]);

  const open = (slotId: string, focus?: 'first' | 'last') => {
    setOpenSlotId(slotId);
    setClosedSlotId(undefined);
    setFocusRequest(focus);
  };
  const close = (slotId: string, refocusTile: boolean) => {
    setOpenSlotId(undefined);
    setClosedSlotId(slotId);
    setFocusRequest(undefined);
    if (!refocusTile) return;
    refocusing.current = true;
    tileIn(gridRef.current, slotId)?.focus();
    refocusing.current = false;
  };

  return {
    close,
    closedSlotId,
    focusRequest,
    onFocusHandled: () => setFocusRequest(undefined),
    openSlotId,
    toggle: (slotId: string) => {
      if (openSlotId === slotId) close(slotId, false);
      else open(slotId);
    },
    /** Grid handlers: keyboard focus on a grouped tile opens its list, and the arrows enter it. */
    gridHandlers: (isGroupSlot: (slotId: string) => boolean) => {
      const groupSlotOf = (target: EventTarget) => {
        if (!(target instanceof HTMLElement) || !target.classList.contains('favourite-tile')) return undefined;
        const slotId = target.closest('.favourite-slot')?.getAttribute('data-slot-id');
        return slotId && isGroupSlot(slotId) ? slotId : undefined;
      };
      return {
        onFocus: (event: FocusEvent<HTMLElement>) => {
          const slotId = groupSlotOf(event.target);
          if (!refocusing.current && slotId && event.target.matches(':focus-visible')) open(slotId);
        },
        onBlur: closeOnLeave,
        onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
          const slotId = groupSlotOf(event.target);
          if (!slotId) return;
          if (event.key === 'ArrowDown' || event.key === 'Enter') open(slotId, 'first');
          else if (event.key === 'ArrowUp') open(slotId, 'last');
          else if (event.key === 'Escape' && (openSlotId === slotId || hoverSlotId === slotId)) close(slotId, false);
          else return;
          event.preventDefault();
          event.stopPropagation();
        },
      };
    },
    onListBlur: closeOnLeave,
  };
}

export interface FavouriteGroupRowActions {
  audioStateByTabId: FaviconAudioStates;
  /** Opens the entry: focuses a tab, or opens a favourite as its tile would. */
  onActivate(entry: FavouriteGroupEntry): void;
  /** Closes the entry's tabs in this window; absent when it has none. */
  closeEntry(entry: FavouriteGroupEntry): (() => void) | undefined;
  onMenu(event: MouseEvent<HTMLElement>, entry: FavouriteGroupEntry): void;
  entryTitle(entry: FavouriteGroupEntry): string;
  /** The space the entry is in, which the list gathers entries by and colours each row with. */
  entrySpace(entry: FavouriteGroupEntry): { id: string; colour?: string; title: string } | undefined;
}

const VIEWPORT_MARGIN = 8;

type ListBox = { bottom?: number; left: number; maxHeight: number; top?: number; width?: number };

/** Whether two list boxes set the same sides, to the same values. */
const sameBox = (a: ListBox | undefined, b: ListBox) =>
  a !== undefined && (Object.keys(b) as (keyof ListBox)[]).every((key) => a[key] === b[key]) &&
  Object.keys(a).length === Object.keys(b).length;

/** Where the list sits for its placement: below the bar takes the stylesheet's place. */
function useListBox(
  placement: FavouriteGroupPlacement,
  gridRef: RefObject<HTMLElement | null>,
  slotId: string | undefined,
) {
  const [box, setBox] = useState<ListBox>();
  useLayoutEffect(() => {
    const tile = slotId ? tileIn(gridRef.current, slotId)?.getBoundingClientRect() : undefined;
    const section = gridRef.current?.parentElement;
    if (placement === 'bar' || !tile || !section) return;
    const inline = Number.parseFloat(getComputedStyle(section).getPropertyValue('--favourites-padding-inline')) || 0;
    const next = tileListBox(section.getBoundingClientRect(), tile, inline, {
      bottom: window.innerHeight - VIEWPORT_MARGIN,
      top: VIEWPORT_MARGIN,
    });
    setBox((current) => sameBox(current, next) ? current : next);
  });
  return placement === 'bar' ? undefined : box;
}

/**
 * Lists a grouped tile's favourites and tabs, most recently used first: below
 * the bar or below the tile.
 */
export function FavouriteGroupList({
  group,
  gridRef,
  listRef,
  onBlur,
  onClose,
  onFocusHandled,
  onPointerLeave,
  focusRequest,
  placement,
  rowActions,
  slotId,
  windowId,
}: {
  group?: FavouriteGroup;
  gridRef: RefObject<HTMLElement | null>;
  listRef: RefObject<HTMLDivElement | null>;
  onBlur(event: FocusEvent<HTMLElement>): void;
  /** Closes the list; `refocusTile` hands focus back to its tile. */
  onClose(refocusTile: boolean): void;
  onFocusHandled(): void;
  onPointerLeave(event: PointerEvent): void;
  focusRequest?: 'first' | 'last';
  placement: FavouriteGroupPlacement;
  rowActions: FavouriteGroupRowActions;
  slotId?: string;
  windowId: number | null;
}) {
  const reduceMotion = useReducedMotion();
  const shownBox = useListBox(placement, gridRef, slotId);
  const entries = group ? orderEntriesBySpace(group.entries, (entry) => rowActions.entrySpace(entry)?.id) : [];
  const spaces = entries.map((entry) => rowActions.entrySpace(entry));
  const rows = () => Array.from(
    listRef.current?.querySelectorAll<HTMLElement>('.favourite-group-row-main') ?? [],
  );

  useLayoutEffect(() => {
    if (!group || !focusRequest) return;
    const all = rows();
    (focusRequest === 'first' ? all[0] : all.at(-1))?.focus();
    onFocusHandled();
  });

  const activate = (entry: FavouriteGroupEntry) => {
    onClose(true);
    rowActions.onActivate(entry);
  };
  const keyDown = (event: KeyboardEvent<HTMLElement>) => {
    const all = rows();
    const current = all.findIndex((row) => row === event.currentTarget.ownerDocument.activeElement);
    const focusAt = (index: number) => all[(index + all.length) % all.length]?.focus();
    if (event.key === 'ArrowDown') focusAt(current + 1);
    else if (event.key === 'ArrowUp') focusAt(current - 1);
    else if (event.key === 'Home') focusAt(0);
    else if (event.key === 'End') focusAt(all.length - 1);
    else if (event.key === 'Escape') onClose(true);
    else if (event.key === 'Delete' || event.key === 'Backspace') {
      const entry = entries[current];
      const close = entry && rowActions.closeEntry(entry);
      if (!close) return;
      focusAt(current + 1 < all.length ? current + 1 : current - 1);
      close();
    } else return;
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    <AnimatePresence>
      {group && slotId && (placement === 'bar' || shownBox) && (
        <motion.div
          key={`group-list-${placement}`}
          ref={listRef}
          className={`favourite-group-list is-${placement}${shownBox?.bottom !== undefined ? ' is-above' : ''}`}
          style={shownBox && {
            bottom: shownBox.bottom,
            left: shownBox.left,
            top: shownBox.top,
            width: shownBox.width,
            '--group-list-max-height': `${Math.max(0, shownBox.maxHeight)}px`,
          } as CSSProperties}
          role="group"
          aria-label={`${group.domain}, ${group.entries.length} items`}
          {...popoverMotion(reduceMotion, 0.18, 0.2)}
          onPointerLeave={onPointerLeave}
          onKeyDown={keyDown}
          onBlur={onBlur}
        >
          <div className="favourite-group-panel">
            <div className="favourite-group-heading" aria-hidden="true">{group.domain}</div>
            {entries.map((entry, index) => {
              const title = rowActions.entryTitle(entry);
              const tabs = entry.kind === 'tab' ? [entry.tab] : entry.tabs;
              const url = entry.kind === 'tab' ? tabUrl(entry.tab) : entry.node.url;
              const current = tabs.some((tab) => tab.active && tab.windowId === windowId);
              const close = rowActions.closeEntry(entry);
              const space = spaces[index];
              const joins = (other: number) => !!space?.colour && spaces[other]?.id === space.id;
              return (
                <div
                  key={groupEntryKey(entry)}
                  className={`favourite-group-row${current ? ' is-current' : ''}${entry.kind === 'favourite' ? ' is-pinned' : ''}${space?.colour ? ' has-space' : ''}${joins(index - 1) ? ' joins-previous' : ''}${joins(index + 1) ? ' joins-next' : ''}`}
                  style={space?.colour ? { '--row-space-colour': space.colour } as CSSProperties : undefined}
                  data-url={url}
                  data-space-id={space?.id}
                  onAuxClick={(event) => {
                    if (event.button !== 1) return;
                    event.preventDefault();
                    close?.();
                  }}
                  onMouseDown={(event) => event.button === 1 && event.preventDefault()}
                  onContextMenu={(event) => rowActions.onMenu(event, entry)}
                >
                  <button
                    type="button"
                    className="favourite-group-row-main"
                    aria-current={current ? 'page' : undefined}
                    aria-description={[space && `in ${space.title}`, url !== title && url].filter(Boolean).join(', ') || undefined}
                    onClick={() => activate(entry)}
                  >
                    <Favicon
                      audioState={faviconAudioStateForTabs(tabs, rowActions.audioStateByTabId)}
                      loading={faviconLoadingForTabs(tabs)}
                      url={url ?? ''}
                      title={title}
                      sourceUrl={bestTabFaviconUrl(tabs)}
                    />
                    <span className="favourite-group-row-title">{title}</span>
                    {entry.kind === 'favourite' && (
                      <span className="favourite-group-row-pin" aria-label="pinned">
                        <Pin size={9} strokeWidth={2.4} aria-hidden="true" />
                      </span>
                    )}
                  </button>
                  {close && (
                    <button
                      type="button"
                      className="favourite-group-row-close"
                      tabIndex={-1}
                      aria-label={`Close ${title}`}
                      onClick={close}
                    >
                      <X size={12} strokeWidth={2.2} aria-hidden="true" />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
