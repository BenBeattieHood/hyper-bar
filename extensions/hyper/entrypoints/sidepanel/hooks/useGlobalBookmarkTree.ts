import { useMemo } from 'react';
import { type BookmarkNode, type BrowserTab } from '../../lib/bookmarks';
import { flattenVisibleTree } from '../lib/drag';
import { indexVisibleSpaceIds, type ProjectedBrowserState } from '../lib/projectionState';

function collectIds(nodes: readonly BookmarkNode[], ids = new Set<string>()): Set<string> {
  for (const node of nodes) {
    ids.add(node.id);
    collectIds(node.children ?? [], ids);
  }
  return ids;
}

/**
 * What the global bookmarks tree draws from. A tab opened from a global
 * bookmark stays linked to it in whichever space it lives, so its sync button
 * shows wherever the tab has wandered.
 */
export function useGlobalBookmarkTree({
  browserState,
  collapsedIds,
  globalBookmarks,
}: {
  browserState: Pick<
    ProjectedBrowserState,
    'globalBookmarksFolderId' | 'remoteSpacePresence' | 'tabBookmarkLinks' | 'tabSpaceIds' | 'tabs'
  >;
  collapsedIds: Set<string>;
  globalBookmarks: BookmarkNode[];
}) {
  const rootId = browserState.globalBookmarksFolderId ?? undefined;
  const items = useMemo(
    () => flattenVisibleTree(globalBookmarks, rootId ?? '', collapsedIds, false),
    [collapsedIds, globalBookmarks, rootId],
  );
  const matchingTabsByBookmarkId = useMemo(() => {
    const ids = collectIds(globalBookmarks);
    const matches = new Map<string, BrowserTab[]>();
    for (const tab of browserState.tabs) {
      const link = tab.id === undefined ? undefined : browserState.tabBookmarkLinks[tab.id];
      if (!link || !ids.has(link.bookmarkId)) continue;
      matches.set(link.bookmarkId, [...matches.get(link.bookmarkId) ?? [], tab]);
    }
    return matches;
  }, [browserState.tabBookmarkLinks, browserState.tabs, globalBookmarks]);
  const { remoteSpacePresence, tabSpaceIds, tabs } = browserState;
  const spaceIdsByPageIdentity = useMemo(
    () => indexVisibleSpaceIds({ remoteSpacePresence, tabSpaceIds, tabs }, globalBookmarks),
    [globalBookmarks, remoteSpacePresence, tabSpaceIds, tabs],
  );
  return { items, matchingTabsByBookmarkId, nodes: globalBookmarks, rootId, spaceIdsByPageIdentity };
}
