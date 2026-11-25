import { Ban, File, FolderClosed, Globe, Plus, Trash2 } from 'lucide-react';
import { bestTabFaviconUrl, type BookmarkNode, type BrowserTab } from '../../lib/bookmarks';
import { pageIdentity, tabUrl } from '../../lib/urlIdentity';
import type { dragOverlayAction } from '../lib/drag';
import { isSharedDragTab } from '../lib/sharedDragDrops';
import type { DragItemData } from '../types';
import { Favicon, type FaviconAudioStates } from './Favicon';

const ACTION_BADGES = {
  add: { className: 'drag-add-badge', Icon: Plus, label: 'Add', size: 11 },
  delete: { className: 'drag-delete-badge', Icon: Trash2, label: 'Delete', size: 10 },
  forbidden: { className: 'drag-forbidden-badge', Icon: Ban, label: 'Cannot drop here', size: 11 },
};

/** What follows the pointer while a tab, bookmark or folder is dragged, with what a drop would do. */
export function DragItemPreview({
  action,
  audioStateByTabId,
  count,
  drag,
  nodes,
  tabs,
  tabsByPageIdentity,
  title,
}: {
  action: ReturnType<typeof dragOverlayAction>;
  audioStateByTabId: FaviconAudioStates;
  count: number;
  drag: DragItemData;
  nodes: ReadonlyMap<string, BookmarkNode>;
  tabs: readonly BrowserTab[];
  tabsByPageIdentity: ReadonlyMap<string, BrowserTab[]>;
  title: string;
}) {
  const node = drag.kind === 'tree' || drag.kind === 'favourite' || drag.kind === 'tab-folder' ||
    drag.kind === 'session-tab'
    ? nodes.get(drag.nodeId)
    : undefined;
  const tab = drag.kind === 'tab' ? tabs.find((candidate) => candidate.id === drag.tabId) : undefined;
  const url = node?.url ?? tabUrl(tab);
  const identity = pageIdentity(node?.url);
  const isFolder = drag.kind === 'tab-folder' || drag.kind === 'tree' && drag.isFolder;
  const badge = action && ACTION_BADGES[action];
  return (
    <div className="drag-overlay">
      {url && !isFolder ? (
        <Favicon
          audioState={tab?.id === undefined ? undefined : audioStateByTabId[tab.id]}
          url={url}
          title={title}
          size="large"
          sourceUrl={tab?.favIconUrl ?? bestTabFaviconUrl(
            identity ? tabsByPageIdentity.get(identity) ?? [] : [],
          )}
        />
      ) : drag.kind === 'external' && drag.files > 0 ? (
        <File size={18} aria-hidden="true" />
      ) : isSharedDragTab(drag) || drag.kind === 'external' ? (
        <Globe size={18} aria-hidden="true" />
      ) : (
        <FolderClosed size={18} aria-hidden="true" />
      )}
      {badge && (
        <span className={badge.className} aria-label={badge.label}>
          <badge.Icon size={badge.size} aria-hidden="true" />
        </span>
      )}
      {count > 1 && (
        <span className="drag-count-badge" aria-label={`${count} items`}>
          {count}
        </span>
      )}
    </div>
  );
}
