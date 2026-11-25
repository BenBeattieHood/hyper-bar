import { useEffect, useMemo, useRef, type Dispatch, type SetStateAction } from 'react';
import type { BookmarkNode, BrowserTab } from '../../lib/bookmarks';
import { TREE_ITEM_TWEEN_DURATION_MS } from '../components/SortableTree';
import { activeTabRows, type ActiveTabRow } from '../lib/activeTabReveal';

const rowSelector = ({ nodeId, pane }: ActiveTabRow) => pane === 'tabs'
  ? `.tab-row[data-tab-node-id="${CSS.escape(nodeId)}"]`
  : `.bookmark-tree-stack .tree-row[data-bookmark-node-id="${CSS.escape(nodeId)}"]`;

/**
 * Brings the window's active tab into view in each pane showing it, opening the
 * folders above its rows. It acts when the tab changes, or where it shows, or
 * `shownKey` does, so a folder the user closes over it stays closed until then.
 */
export function useActiveTabReveal({
  activeTab,
  bookmarks,
  collapsedIds,
  linkedBookmarkId,
  setCollapsedIds,
  shownKey,
  tabs,
}: {
  activeTab?: BrowserTab;
  bookmarks: { nodes: BookmarkNode[]; rootId: string; visible: boolean };
  collapsedIds: ReadonlySet<string>;
  linkedBookmarkId?: string;
  setCollapsedIds: Dispatch<SetStateAction<Set<string>>>;
  /** Changes when the panes come into view anew: in another space, or as the sidebar widens enough to show them. */
  shownKey: string;
  tabs: {
    nodes: BookmarkNode[];
    rootId: string;
    tabsByNodeId: Readonly<Record<string, BrowserTab | undefined>>;
    visible: boolean;
  };
}) {
  const { id: tabId, pendingUrl, url } = activeTab ?? {};
  const rows = useMemo(() => activeTabRows({
    activeTab: tabId === undefined ? undefined : { id: tabId, pendingUrl, url },
    bookmarks,
    linkedBookmarkId,
    tabs,
  }), [bookmarks.nodes, bookmarks.rootId, linkedBookmarkId, pendingUrl, tabId, tabs.nodes, tabs.rootId, tabs.tabsByNodeId, url]);
  const latest = useRef({ collapsedIds, rows, visible: { bookmarks: bookmarks.visible, tabs: tabs.visible } });
  latest.current = { collapsedIds, rows, visible: { bookmarks: bookmarks.visible, tabs: tabs.visible } };
  const key = [shownKey, tabId, ...rows.map((row) => `${row.pane}:${row.nodeId}:${row.folderIds.join('/')}`)].join('|');

  useEffect(() => {
    const { collapsedIds: collapsed, rows: current, visible } = latest.current;
    const shown = current.filter((row) => visible[row.pane]);
    if (shown.length === 0) return;
    const closed = new Set(shown.flatMap((row) => row.folderIds.filter((id) => collapsed.has(id))));
    if (closed.size > 0) {
      setCollapsedIds((ids) => new Set([...ids].filter((id) => !closed.has(id))));
    }
    const reveal = () => {
      const behavior = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
      for (const row of shown) {
        document.querySelector<HTMLElement>(rowSelector(row))?.scrollIntoView({ behavior, block: 'nearest' });
      }
    };
    // Rows grow in over a tween as they appear, so they are found again once they have.
    const timers = [0, TREE_ITEM_TWEEN_DURATION_MS + 32].map((delay) => window.setTimeout(reveal, delay));
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [key, setCollapsedIds]);
}
