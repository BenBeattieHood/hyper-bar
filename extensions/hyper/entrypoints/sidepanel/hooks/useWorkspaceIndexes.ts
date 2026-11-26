import { useMemo } from 'react';
import {
  bookmarkFolderIdsContainingUrls,
  indexTabSpacesByPageIdentity,
  indexTabsByPageIdentity,
  type BookmarkNode,
  type Space,
} from '../../lib/bookmarks';
import { faviconAudioStateForTabs } from '../components/Favicon';
import { indexVisibleSpaceIds } from '../lib/projectionState';
import type { useBrowserState } from './useBrowserState';
import { spaceColourValue } from '../lib/groupColour';
import { tabUrl } from '../../lib/urlIdentity';

type BrowserStateApi = ReturnType<typeof useBrowserState>;

export function useWorkspaceIndexes({
  audioStateByTabId,
  browserState,
  nodeMap,
  spaces,
  visibleTree,
}: {
  audioStateByTabId: Parameters<typeof faviconAudioStateForTabs>[1];
  browserState: BrowserStateApi;
  nodeMap: ReadonlyMap<string, BookmarkNode>;
  spaces: Space[];
  visibleTree: BookmarkNode[];
}) {
  const tabsByPageIdentity = useMemo(
    () => indexTabsByPageIdentity(browserState.tabs),
    [browserState.tabs],
  );
  const audioStateByPageIdentity = useMemo(() => new Map(
    [...tabsByPageIdentity.entries()].flatMap(([identity, tabs]) => {
      const state = faviconAudioStateForTabs(tabs, audioStateByTabId);
      return state ? [[identity, state] as const] : [];
    }),
  ), [audioStateByTabId, tabsByPageIdentity]);
  const tabBackingsByTabId = useMemo(
    () => Object.fromEntries(Object.entries(browserState.tabBackingIds).flatMap(
      ([tabId, backingId]) => {
        const backing = nodeMap.get(backingId);
        return backing ? [[Number(tabId), backing] as const] : [];
      },
    )),
    [browserState.tabBackingIds, nodeMap],
  );
  const spaceIdsByPageIdentity = useMemo(
    () => indexVisibleSpaceIds(browserState, [
      ...visibleTree,
      ...browserState.favouriteIds.flatMap((id) => nodeMap.get(id) ?? []),
    ]),
    [browserState, nodeMap, visibleTree],
  );
  const localSpaceIdsByPageIdentity = useMemo(
    () => indexTabSpacesByPageIdentity(browserState.tabs, browserState.tabSpaceIds),
    [browserState.tabSpaceIds, browserState.tabs],
  );
  const openBookmarkFolderIds = useMemo(() => {
    return bookmarkFolderIdsContainingUrls(
      visibleTree,
      browserState.tabs.map(tabUrl),
    );
  }, [browserState.tabs, visibleTree]);
  const spaceColours = useMemo(
    () => Object.fromEntries(spaces.map((space) => [space.id, spaceColourValue(space)])),
    [spaces],
  );
  return {
    audioStateByPageIdentity,
    localSpaceIdsByPageIdentity,
    openBookmarkFolderIds,
    spaceColours,
    spaceIdsByPageIdentity,
    tabBackingsByTabId,
    tabsByPageIdentity,
  };
}
