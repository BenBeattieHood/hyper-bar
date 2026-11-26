import { useDndContext, useDraggable, useDroppable } from '@dnd-kit/core';
import { useContext, useMemo, useState, type CSSProperties, type MouseEvent } from 'react';
import { visibleBookmarkTitle, type BookmarkNode } from '../../lib/bookmarks';
import { useTreeKeyboard } from '../hooks/useTreeKeyboard';
import { dragSelectionId, type DragSelectionModifiers } from '../lib/dragSelection';
import {
  clipboardEntries,
  closeTabsLabel,
  ItemActionsContext,
  itemMenuEntries,
  pasteEntries,
  reloadTabsLabel,
  type ItemActions,
} from '../lib/itemActions';
import { toggleFolder } from '../lib/folderReveal';
import { useItemGesture } from '../lib/itemGesture';
import { otherSessions, sessionTabFolders, type OtherSession } from '../lib/otherSessions';
import { itemTooltip } from '../lib/itemTooltip';
import type { SelectableDragItem } from '../types';
import { Favicon } from '@hyper/ui';
import { FolderIcon, RowIconButton } from './TreeRow';

/** A time today, so sessions active the same day differ; otherwise the day. */
function lastActive(time: number): string {
  const active = new Date(time);
  const now = new Date();
  if (active.toDateString() === now.toDateString()) {
    return active.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }
  return active.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    ...(active.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  });
}

/** What closing another session's tab can and cannot do, as its tooltips say. */
export const SESSION_CLOSE_HINT = 'Forgets this tab here and on every device. ' +
  'A device still running that Hyper keeps its tab open and lists it again.';
const SESSION_RELOAD_UNAVAILABLE = 'Hyper cannot reach a tab another session keeps open';
export const LEGACY_SESSION_PASTE_UNAVAILABLE = 'Tabs kept before Hyper named its installations cannot take more';

type SessionTabItem = Extract<SelectableDragItem, { kind: 'session-tab' }>;

/** What a session's rows share: selection, and what its menu pastes into. */
interface SessionRowProps {
  onDragSelectionPointerDown: (
    source: SelectableDragItem,
    orderedItems: readonly SelectableDragItem[],
    modifiers: DragSelectionModifiers,
  ) => void;
  onOpen: (node: BookmarkNode) => void;
  selectedDragItemIds: ReadonlySet<string>;
}

const pasteMenu = (actions: ItemActions, installationId: string) => {
  const target = { installationId, kind: 'session' as const };
  return installationId
    ? pasteEntries(actions, target)
    : { paste: () => undefined, pasteUnavailable: LEGACY_SESSION_PASTE_UNAVAILABLE };
};

function SessionTab({
  depth = 0,
  dragData,
  node,
  onDragSelectionPointerDown,
  onOpen,
  orderedItems,
  selectedDragItemIds,
}: SessionRowProps & {
  depth?: number;
  dragData: SessionTabItem;
  node: BookmarkNode;
  orderedItems: readonly SessionTabItem[];
}) {
  const actions = useContext(ItemActionsContext);
  const gesture = useItemGesture();
  const { title } = dragData;
  const draggable = useDraggable({ id: `session-tab:${node.id}`, data: dragData });
  const selectionId = dragSelectionId(dragData);
  const selected = selectedDragItemIds.has(selectionId);
  const close = () => actions?.removeItems([dragData]);
  const openMenu = (event: MouseEvent<HTMLElement>) => {
    if (!actions) return;
    const items = actions.itemsFor(dragData);
    actions.openMenu(event, `Actions for ${title}`, itemMenuEntries({
      count: items.length,
      ...clipboardEntries(actions, items),
      ...pasteMenu(actions, dragData.installationId),
      reload: { label: reloadTabsLabel(items.length), run: () => undefined, unavailable: SESSION_RELOAD_UNAVAILABLE },
      close: { hint: SESSION_CLOSE_HINT, label: closeTabsLabel(items.length), run: () => actions.removeItems(items) },
    }));
  };
  return (
    <li>
      <div
        ref={draggable.setNodeRef}
        className={`tab-row session-tab-row${selected ? ' is-drag-selected' : ''}${draggable.isDragging ? ' is-dragging' : ''}`}
        style={{ '--tree-depth': depth } as CSSProperties}
        data-session-tab-id={node.id}
        data-drag-selection-id={selectionId}
      >
        {depth > 0 && <span className="tree-depth-guides" aria-hidden="true" />}
        <div className="tab-content">
          <div
            className="tab-main"
            title={itemTooltip(title, node.url)}
            data-url={node.url}
            data-item-drag="true"
            draggable={Boolean(draggable.listeners)}
            {...draggable.attributes}
            {...draggable.listeners}
            aria-label={`${title}, kept by another session`}
            aria-selected={selected}
            onPointerDownCapture={(event) => {
              gesture.onPointerDownCapture(event);
              onDragSelectionPointerDown(dragData, orderedItems, {
                range: event.shiftKey,
                toggle: event.metaKey || event.ctrlKey,
              });
            }}
            onClick={(event) => {
              if (event.button !== 0 || !gesture.isClick(event)) return;
              onOpen(node);
            }}
            onAuxClick={(event) => {
              if (event.button !== 1) return;
              event.preventDefault();
              close();
            }}
            onMouseDownCapture={(event) => event.button === 1 && event.preventDefault()}
            onContextMenu={openMenu}
          >
            <Favicon url={node.url ?? ''} title={title} />
            <span className="tab-title">{title}</span>
          </div>
          <RowIconButton
            className="tab-close"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={close}
            aria-label={`Close ${title}`}
            title={SESSION_CLOSE_HINT}
          />
        </div>
      </div>
    </li>
  );
}

/** A site's tabs in another session; it folds open and shut, but only its tabs drag. */
function SessionFolder({
  collapsed,
  folder,
  onToggle,
}: {
  collapsed: boolean;
  folder: BookmarkNode;
  onToggle: () => void;
}) {
  const count = folder.children?.length ?? 0;
  return (
    <li>
      <div className="tree-row tab-folder-row session-folder-row" style={{ '--tree-depth': 0 } as CSSProperties}>
        <div className="tab-folder-content">
          <button
            type="button"
            className="tree-item-main folder-item"
            aria-expanded={!collapsed}
            aria-label={`${folder.title}, ${count} tabs`}
            onClick={onToggle}
          >
            <FolderIcon collapsed={collapsed} count={count} />
            <span className="tree-title">{folder.title}</span>
          </button>
        </div>
      </div>
    </li>
  );
}

function SessionSection({
  autofolders,
  dragging,
  dropDisabled,
  session,
  ...rowProps
}: SessionRowProps & {
  autofolders: boolean;
  /** A drag is under way, and its keys belong to it. */
  dragging: boolean;
  dropDisabled?: boolean;
  session: OtherSession;
}) {
  const actions = useContext(ItemActionsContext);
  const [collapsedFolderIds, setCollapsedFolderIds] = useState<ReadonlySet<string>>(() => new Set());
  const folders = useMemo(
    () => autofolders ? sessionTabFolders(session.tabs) : undefined,
    [autofolders, session.tabs],
  );
  const toggleCollapsed = (folderId: string) => setCollapsedFolderIds((current) => toggleFolder(current, folderId));
  const shownTabs = useMemo(() => folders
    ? folders.flatMap((folder) => collapsedFolderIds.has(folder.id) ? [] : folder.children ?? [])
    : session.tabs, [collapsedFolderIds, folders, session.tabs]);
  const dragItems = useMemo(() => new Map(shownTabs.map((node) => {
    const title = visibleBookmarkTitle(node) || node.url || 'Untitled tab';
    const item: SessionTabItem = {
      installationId: session.id,
      itemCount: 1,
      kind: 'session-tab',
      nodeId: node.id,
      title,
      ...(node.url ? { url: node.url } : {}),
    };
    return [node.id, item] as const;
  })), [session.id, shownTabs]);
  const orderedItems = useMemo(() => [...dragItems.values()], [dragItems]);
  const keyItems = useMemo(() => orderedItems.map((item) => ({
    ancestorIds: [], isFolder: false, nodeId: item.nodeId, title: item.title,
  })), [orderedItems]);
  const onKeyDown = useTreeKeyboard({
    collapsedIds: collapsedFolderIds,
    disabled: dragging,
    items: keyItems,
    nodeAttribute: 'data-session-tab-id',
    onToggle: () => undefined,
    onClipboard: (key, nodeId) => {
      const item = dragItems.get(nodeId);
      if (!actions || !item) return;
      // The paste's plan explains why the legacy session takes nothing.
      if (key !== 'paste') actions.clipboard(key, actions.itemsFor(item));
      else actions.paste({ installationId: session.id, kind: 'session' });
    },
  });
  const tab = (node: BookmarkNode, depth?: number) => {
    const item = dragItems.get(node.id);
    return item && (
      <SessionTab key={node.id} depth={depth} dragData={item} node={node} orderedItems={orderedItems} {...rowProps} />
    );
  };
  const label = session.lastKeptAt
    ? `Session last active ${lastActive(session.lastKeptAt)}`
    : 'Another session';
  // Tabs kept before installations had IDs can leave, but nothing can join them.
  const droppable = useDroppable({
    id: `session-zone:${session.id}`,
    disabled: dropDisabled || !session.id,
    data: { installationId: session.id, kind: 'session-zone' },
  });
  return (
    <section
      ref={droppable.setNodeRef}
      className={`other-session${droppable.isOver ? ' is-over' : ''}`}
      aria-label={label}
      data-installation-id={session.id}
    >
      <div
        className="other-session-label"
        title={session.id
          ? `Tabs that Hyper installation ${session.id.slice(0, 8)} keeps`
          : 'Tabs kept before Hyper named its installations'}
        onContextMenu={(event) => actions?.openMenu(event, label, itemMenuEntries({
          count: 0,
          ...pasteMenu(actions, session.id),
        }))}
      >
        <span>{label}</span>
        <span className="other-session-count">{session.tabs.length}</span>
      </div>
      {session.tabs.length > 0 ? (
        <ul className="tabs-list other-session-tabs" onKeyDown={onKeyDown}>
          {folders
            ? folders.flatMap((folder) => [
                <SessionFolder
                  key={folder.id}
                  collapsed={collapsedFolderIds.has(folder.id)}
                  folder={folder}
                  onToggle={() => toggleCollapsed(folder.id)}
                />,
                ...(collapsedFolderIds.has(folder.id) ? [] : (folder.children ?? []).map((node) => tab(node, 1))),
              ])
            : session.tabs.map((node) => tab(node))}
        </ul>
      ) : (
        <p className="other-session-empty">No tabs in this space</p>
      )}
    </section>
  );
}

/**
 * The tabs other sessions keep in this space, a section each: other devices,
 * and installations of Hyper this one replaced. Their tabs select, drag, cut,
 * copy, paste and close as this window's do (DECISIONS 36): dragging moves
 * them, and Alt, Ctrl or Cmd held copies them.
 */
export function OtherSessions({
  autofolders,
  dropDisabled,
  installationId,
  spaceId,
  tree,
  ...rowProps
}: SessionRowProps & {
  autofolders: boolean;
  dropDisabled?: boolean;
  installationId?: string;
  spaceId: string;
  tree: BookmarkNode[];
}) {
  const dragging = Boolean(useDndContext().active);
  const sessions = useMemo(
    () => otherSessions(tree, spaceId, installationId),
    [installationId, spaceId, tree],
  );
  if (!installationId) return null;
  return (
    <div className="other-sessions">
      {sessions.length === 0 && <p className="other-session-empty">No other session keeps tabs</p>}
      {sessions.map((session) => (
        <SessionSection
          key={session.id}
          autofolders={autofolders}
          dragging={dragging}
          dropDisabled={dropDisabled}
          session={session}
          {...rowProps}
        />
      ))}
    </div>
  );
}
