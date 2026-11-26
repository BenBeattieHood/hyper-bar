import { findBookmarkNode, shownSpaces, type BookmarkNode } from './bookmarks';
import type { HyperModelSnapshot } from './model';
import type { TabOwnership } from './tabOwnership';
import { pageIdentity, tabPageIdentity } from './urlIdentity';
import { normalWindowIds } from './windowState';

export type RemoteTabReference =
  | { bookmarkId: string; kind: 'bookmark' }
  | { kind: 'tab'; tabId: number };

export interface RemoteTabRequest {
  source: RemoteTabReference;
  spaceId: string;
}

export interface RemoteTabTarget {
  ownership: TabOwnership;
  page: string;
  spaceId: string;
  tabId: number;
  windowId: number;
}

function visibleBookmarks(
  snapshot: HyperModelSnapshot,
  windowId: number,
): readonly BookmarkNode[] {
  const activeSpaceId = snapshot.runtime.activeSpaceIds[windowId] ?? shownSpaces(snapshot.hyper.spaces)[0]?.id;
  return [
    ...(activeSpaceId ? snapshot.hyper.localBookmarksBySpaceId[activeSpaceId] ?? [] : []),
    ...snapshot.hyper.globalBookmarks,
  ];
}

function sourcePage(
  snapshot: HyperModelSnapshot,
  windowId: number,
  reference: RemoteTabReference,
): string | undefined {
  if (reference.kind === 'bookmark') {
    return pageIdentity(
      findBookmarkNode(visibleBookmarks(snapshot, windowId), reference.bookmarkId)?.url,
    ) ?? undefined;
  }
  const tab = snapshot.browser.tabs.find((candidate) =>
    candidate.id === reference.tabId && candidate.windowId === windowId && !candidate.incognito);
  return tabPageIdentity(tab) ?? undefined;
}

/** The source's page and every normal-window tab showing it, if the asking window is normal. */
function pageTabs(snapshot: HyperModelSnapshot, clientWindowId: number, request: RemoteTabRequest) {
  const page = sourcePage(snapshot, clientWindowId, request.source);
  const windowIds = normalWindowIds(snapshot.browser.windows);
  if (!page || !windowIds.has(clientWindowId)) return undefined;
  const tabs = snapshot.browser.tabs.filter((tab): tab is typeof tab & { id: number } =>
    tab.id !== undefined &&
    !tab.incognito &&
    windowIds.has(tab.windowId) &&
    tabPageIdentity(tab) === page);
  return { page, tabs };
}

/**
 * Resolves an opaque, client-visible reference to one exact remote tab without
 * exposing a remote tab record or accepting a raw remote tab id from a view.
 */
export function resolveRemoteTabTarget(
  snapshot: HyperModelSnapshot,
  clientWindowId: number,
  request: RemoteTabRequest,
): RemoteTabTarget | undefined {
  const found = pageTabs(snapshot, clientWindowId, request);
  const matches = (found?.tabs ?? []).flatMap((tab) => {
    if (tab.windowId === clientWindowId) return [];
    const ownership = snapshot.runtime.tabOwnerships[tab.id];
    const disposition = snapshot.derived.tabDispositions.get(tab.id);
    return ownership?.spaceId === request.spaceId &&
      disposition?.status === 'owned' &&
      disposition.spaceId === request.spaceId
      ? [{ ownership, page: found!.page, spaceId: request.spaceId, tabId: tab.id, windowId: tab.windowId }]
      : [];
  });
  return matches.length === 1 ? matches[0] : undefined;
}

/** The source's page wherever the space has it open, matched as the space dots match it. */
export function spacePageTabIds(
  snapshot: HyperModelSnapshot,
  clientWindowId: number,
  request: RemoteTabRequest,
): number[] {
  return (pageTabs(snapshot, clientWindowId, request)?.tabs ?? []).flatMap((tab) => {
    const disposition = snapshot.derived.tabDispositions.get(tab.id);
    const spaceId = tab.windowId === clientWindowId
      ? snapshot.runtime.tabOwnerships[tab.id]?.spaceId
      : disposition?.status === 'owned' ? disposition.spaceId : undefined;
    return spaceId === request.spaceId ? [tab.id] : [];
  });
}
