import { useRef, type KeyboardEvent } from 'react';
import { isMenuKey, openContextMenuFromKey } from '../components/ContextMenu';
import { isTypeaheadKey, treeKeyAction, typeaheadMatch, type TreeKeyItem } from '../lib/treeKeyboard';
import { matchesShortcut, type ShortcutId } from '../../lib/shortcuts';

const TYPEAHEAD_RESET_MS = 700;
const NAVIGATION_KEYS = new Set(['ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'End', 'Home']);
const CLIPBOARD_SHORTCUTS = { copyItem: 'copy', cutItem: 'cut', pasteItem: 'paste' } as const satisfies Partial<Record<ShortcutId, TreeClipboardKey>>;

export type TreeClipboardKey = 'copy' | 'cut' | 'paste';

interface TreeKeyboardOptions {
  /** The rows on show, in order, as the tree lists them for dragging. */
  items: readonly (TreeKeyItem & { title: string })[];
  collapsedIds: ReadonlySet<string>;
  /** A drag is under way, and its keys belong to it. */
  disabled: boolean;
  /** The attribute on each row naming its node. */
  nodeAttribute: 'data-bookmark-node-id' | 'data-session-tab-id' | 'data-tab-node-id';
  onToggle(nodeId: string): void;
  onClipboard(key: TreeClipboardKey, nodeId: string): void;
}

/**
 * Keys for a tree's rows: the arrow keys, Home, End and Enter as the WAI-ARIA
 * tree pattern has them, typing to jump to a row by its title, Shift+F10 or the
 * menu key for its context menu, and Cut, Copy and Paste. Space stays with
 * dragging. Enter and the menu key act through the row's own click and
 * context menu, so they do just what the pointer does.
 */
export function useTreeKeyboard({
  collapsedIds,
  disabled,
  items,
  nodeAttribute,
  onClipboard,
  onToggle,
}: TreeKeyboardOptions) {
  const typed = useRef({ at: 0, text: '' });
  return (event: KeyboardEvent<HTMLElement>) => {
    if (disabled || event.defaultPrevented || event.nativeEvent.isComposing) return;
    const row = event.target instanceof HTMLElement && event.target.matches('[data-item-drag]')
      ? event.target
      : undefined;
    const nodeId = row?.closest(`[${nodeAttribute}]`)?.getAttribute(nodeAttribute);
    if (!row || !nodeId) return;
    const container = event.currentTarget;
    const rowFor = (id: string) => container.querySelector<HTMLElement>(
      `[${nodeAttribute}="${CSS.escape(id)}"] [data-item-drag]`,
    );
    const clipboardShortcut = (Object.keys(CLIPBOARD_SHORTCUTS) as (keyof typeof CLIPBOARD_SHORTCUTS)[])
      .find((id) => matchesShortcut(event, id));
    const clipboardKey = clipboardShortcut && CLIPBOARD_SHORTCUTS[clipboardShortcut];
    if (clipboardKey) {
      event.preventDefault();
      onClipboard(clipboardKey, nodeId);
      return;
    }
    if (isMenuKey(event)) {
      event.preventDefault();
      openContextMenuFromKey(row);
      return;
    }
    if (isTypeaheadKey(event)) {
      const continuing = event.timeStamp - typed.current.at < TYPEAHEAD_RESET_MS;
      typed.current = { at: event.timeStamp, text: `${continuing ? typed.current.text : ''}${event.key}` };
      const match = typeaheadMatch(items, nodeId, typed.current.text);
      if (match) {
        event.preventDefault();
        rowFor(match)?.focus();
      }
      return;
    }
    // Alt with an arrow reorders a bookmark; Alt with Enter opens another copy.
    if (event.metaKey || event.ctrlKey || event.shiftKey || (event.altKey && event.key !== 'Enter')) return;
    const action = treeKeyAction(items, nodeId, event.key, (id) => collapsedIds.has(id));
    if (action || NAVIGATION_KEYS.has(event.key)) event.preventDefault();
    if (action?.kind === 'focus') rowFor(action.nodeId)?.focus();
    else if (action?.kind === 'expand' || action?.kind === 'collapse') onToggle(action.nodeId);
    else if (action?.kind === 'activate') {
      row.dispatchEvent(new MouseEvent('click', { altKey: event.altKey, bubbles: true, cancelable: true }));
    }
  };
}
