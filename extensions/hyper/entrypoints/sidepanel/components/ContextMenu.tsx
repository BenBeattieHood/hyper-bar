import {
  autoUpdate,
  flip,
  FloatingFocusManager,
  FloatingPortal,
  offset,
  shift,
  size,
  useDismiss,
  useFloating,
  useInteractions,
  useRole,
} from '@floating-ui/react';
import type { LucideIcon } from 'lucide-react';
import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from 'react';
import { isWithin, listen } from '../lib/listen';
import './ContextMenu.css';

/** Keeps a floating menu beside its anchor and inside the window, scrolling when it outgrows the room. */
export const fittedMenuMiddleware = (gap: number, padding: number, fitWidth = false) => [
  offset(gap),
  flip({ padding }),
  shift({ padding }),
  size({
    padding,
    apply({ availableHeight, availableWidth, elements }) {
      elements.floating.style.maxHeight = `${Math.max(0, availableHeight)}px`;
      if (fitWidth) elements.floating.style.maxWidth = `${Math.max(0, availableWidth)}px`;
    },
  }),
];

export interface ContextMenuEntry {
  id: string;
  label: string;
  icon?: LucideIcon;
  isAvailable?: () => Promise<boolean>;
  /** A colour shown instead of an icon, such as a space's. */
  swatch?: string;
  shortcut?: string;
  /** Starts a group under this heading. */
  section?: string;
  /** Starts a group after a rule. */
  separated?: boolean;
  danger?: boolean;
  /** Shown but not chosen, with `hint` saying why. */
  disabled?: boolean;
  /** A tooltip, such as why the entry is disabled. */
  hint?: string;
  onSelect: () => void;
}

export interface ContextMenuRequest {
  entries: readonly ContextMenuEntry[];
  label: string;
  /** Where the menu opens, in viewport coordinates. */
  x: number;
  y: number;
  /**
   * The top of the item a key opened the menu for, whose bottom is `y`.
   * With no room below, the menu then opens above the item rather than over it.
   */
  top?: number;
  /** Takes focus back when the menu closes. */
  returnFocus?: HTMLElement | null;
}

export type ContextMenuAnchor = Pick<ContextMenuRequest, 'top' | 'x' | 'y'>;

const ITEM_SELECTOR = '[role="menuitem"]';
const MENU_FADE_DURATION_MS = 100;
const POINTER_LEAVE_CLOSE_DELAY_MS = 2000;

/** Joins groups of entries into one menu, with a rule before each group a heading does not start. */
export function menuGroups(groups: readonly (readonly ContextMenuEntry[])[]): ContextMenuEntry[] {
  return groups.filter((group) => group.length > 0).flatMap((group, groupIndex) =>
    group.map((entry, index) => index === 0 && groupIndex > 0 && !entry.section
      ? { ...entry, separated: true }
      : entry));
}

/**
 * Where a menu asked for by `event` opens: at the pointer, or from the item
 * when the keyboard asked, since a key's event has no pointer.
 */
export function contextMenuAnchor(event: {
  clientX: number;
  clientY: number;
  currentTarget: Element;
}): ContextMenuAnchor {
  if (event.clientX !== 0 || event.clientY !== 0) return { x: event.clientX, y: event.clientY };
  return keyboardMenuAnchor(event.currentTarget);
}

/** Where a menu the keyboard asked for opens: below the start of `item`, or above it when there is no room below. */
export function keyboardMenuAnchor(item: Element): ContextMenuAnchor {
  const rect = item.getBoundingClientRect();
  return { top: rect.top, x: rect.left + Math.min(24, rect.width / 2), y: rect.bottom };
}

/**
 * Opens `item`'s menu for Shift+F10 or the Menu key through its own context
 * menu handler, so the key does just what a right-click does.
 */
export function openContextMenuFromKey(item: HTMLElement) {
  item.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
}

/** The Menu key, or Shift+F10. */
export const isMenuKey = (event: { key: string; shiftKey: boolean }) =>
  event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10');

/** A sortable's key handler that opens its menu for the menu keys and leaves the rest to the sortable. */
export const sortableMenuKeyDown = (listeners: Record<string, Function> | undefined) =>
  (event: KeyboardEvent<HTMLElement>) => {
    if (!isMenuKey(event)) return listeners?.onKeyDown?.(event);
    event.preventDefault();
    openContextMenuFromKey(event.currentTarget);
  };

function ContextMenuPopover({
  onClose,
  request,
}: {
  onClose: () => void;
  request: ContextMenuRequest;
}) {
  const returnFocus = useRef<HTMLElement | null>(request.returnFocus ?? null);
  const [closing, setClosing] = useState(false);
  const closeTimer = useRef<number | undefined>(undefined);
  const requestClose = useCallback(() => {
    if (closeTimer.current !== undefined) return;
    setClosing(true);
    closeTimer.current = window.setTimeout(onClose, MENU_FADE_DURATION_MS);
  }, [onClose]);
  useEffect(() => () => {
    if (closeTimer.current !== undefined) window.clearTimeout(closeTimer.current);
  }, []);
  const [availableEntries, setAvailableEntries] = useState<ReadonlySet<ContextMenuEntry>>(() => new Set());
  useEffect(() => {
    const pending = request.entries.filter((entry) => entry.isAvailable);
    let current = true;
    void Promise.all(pending.map(async (entry) => {
      try {
        return [entry, await entry.isAvailable?.()] as const;
      } catch {
        return [entry, false] as const;
      }
    })).then((results) => {
      if (current) setAvailableEntries(new Set(results.filter(([, available]) => available).map(([entry]) => entry)));
    });
    return () => {
      current = false;
    };
  }, [request.entries]);
  useEffect(() => {
    let pointerLeaveTimer: number | undefined;
    const cancelPointerLeaveTimer = () => {
      if (pointerLeaveTimer !== undefined) {
        window.clearTimeout(pointerLeaveTimer);
        pointerLeaveTimer = undefined;
      }
    };
    const onMouseOut = (event: MouseEvent) => {
      if (isWithin(document.documentElement, event.relatedTarget)) return;
      cancelPointerLeaveTimer();
      pointerLeaveTimer = window.setTimeout(requestClose, POINTER_LEAVE_CLOSE_DELAY_MS);
    };
    if (!document.documentElement.matches(':hover')) {
      pointerLeaveTimer = window.setTimeout(requestClose, POINTER_LEAVE_CLOSE_DELAY_MS);
    }
    const unlisten = listen([document, 'mouseout', onMouseOut], [document, 'mouseover', cancelPointerLeaveTimer]);
    return () => {
      cancelPointerLeaveTimer();
      unlisten();
    };
  }, [requestClose]);
  const { context, floatingStyles, isPositioned, refs } = useFloating({
    open: true,
    onOpenChange: (open) => {
      if (!open) requestClose();
    },
    placement: 'bottom-start',
    strategy: 'fixed',
    middleware: fittedMenuMiddleware(2, 6),
    whileElementsMounted: autoUpdate,
  });
  useLayoutEffect(() => {
    // Spanning the item a key opened the menu for, flipping up for room clears the item.
    const top = request.top ?? request.y;
    refs.setPositionReference({
      getBoundingClientRect: () => new DOMRect(request.x, top, 0, request.y - top),
    });
  }, [refs, request.top, request.x, request.y]);
  const dismiss = useDismiss(context, { ancestorScroll: true });
  const role = useRole(context, { role: 'menu' });
  const { getFloatingProps } = useInteractions([dismiss, role]);

  const run = (entry: ContextMenuEntry) => {
    if (entry.disabled) return;
    requestClose();
    entry.onSelect();
  };

  const navigate = (event: KeyboardEvent<HTMLDivElement>) => {
    // The menu sits in a portal, but React still bubbles its keys to the row that opened it.
    event.stopPropagation();
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(ITEM_SELECTOR));
    const current = items.indexOf(document.activeElement as HTMLElement);
    const focusAt = (index: number) => items[(index + items.length) % items.length]?.focus();
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      focusAt(current + (event.key === 'ArrowDown' ? 1 : -1));
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      focusAt(event.key === 'Home' ? 0 : items.length - 1);
    } else if (event.key === 'Tab') {
      event.preventDefault();
      requestClose();
    } else if (
      event.key.length === 1 && event.key !== ' ' &&
      !event.altKey && !event.ctrlKey && !event.metaKey
    ) {
      const key = event.key.toLocaleLowerCase();
      const next = items.findIndex((item, index) => index > current &&
        item.textContent?.trimStart().toLocaleLowerCase().startsWith(key));
      const wrapped = next >= 0 ? next : items.findIndex((item) =>
        item.textContent?.trimStart().toLocaleLowerCase().startsWith(key));
      if (wrapped >= 0) {
        event.preventDefault();
        focusAt(wrapped);
      }
    }
  };

  return (
    <FloatingPortal>
      <FloatingFocusManager context={context} initialFocus={0} modal={false} returnFocus={returnFocus}>
        <div
          ref={refs.setFloating}
          className="context-menu"
          style={{
            ...floatingStyles,
            opacity: isPositioned && !closing ? 1 : 0,
            pointerEvents: isPositioned && !closing ? undefined : 'none',
          }}
          {...getFloatingProps({
            'aria-label': request.label,
            onContextMenu: (event) => event.preventDefault(),
            onKeyDown: navigate,
            onPointerMove: (event) => {
              (event.target as Element).closest<HTMLElement>(ITEM_SELECTOR)?.focus({ preventScroll: true });
            },
          })}
        >
          {request.entries.filter((entry) => !entry.isAvailable || availableEntries.has(entry)).map((entry) => {
            const Icon = entry.icon;
            return (
              <Fragment key={entry.id}>
                {entry.section ? (
                  <div className="context-menu-section" role="separator" aria-label={entry.section}>
                    {entry.section}
                  </div>
                ) : entry.separated ? (
                  <div className="context-menu-separator" role="separator" />
                ) : null}
                <button
                  type="button"
                  role="menuitem"
                  className={`context-menu-item${entry.danger ? ' is-danger' : ''}${entry.disabled ? ' is-disabled' : ''}`}
                  data-menu-item-id={entry.id}
                  aria-disabled={entry.disabled || undefined}
                  title={entry.hint}
                  onClick={() => run(entry)}
                >
                  <span className="context-menu-visual" aria-hidden="true">
                    {entry.swatch ? (
                      <span
                        className="context-menu-swatch"
                        style={{ '--context-menu-swatch': entry.swatch } as CSSProperties}
                      />
                    ) : Icon ? <Icon size={14} /> : null}
                  </span>
                  <span className="context-menu-item-label">{entry.label}</span>
                  {entry.shortcut && <kbd>{entry.shortcut}</kbd>}
                </button>
              </Fragment>
            );
          })}
        </div>
      </FloatingFocusManager>
    </FloatingPortal>
  );
}

/** One context menu at a time: `open` shows it, replacing any already open. */
export function useContextMenu() {
  const [request, setRequest] = useState<ContextMenuRequest & { key: number }>();
  const opened = useRef(0);
  const open = useCallback((next: ContextMenuRequest) => {
    opened.current += 1;
    next.entries.forEach((entry) => {
      if (!entry.isAvailable) return;
      try {
        void entry.isAvailable().catch(() => false);
      } catch {
        // Clipboard checks must not prevent the rest of the menu from opening.
      }
    });
    setRequest({ ...next, key: opened.current });
  }, []);
  const close = useCallback(() => setRequest(undefined), []);
  const menu = request && request.entries.length > 0
    ? <ContextMenuPopover key={request.key} request={request} onClose={close} />
    : null;
  return { close, menu, open };
}
