import { isSplitViewFolder, type BookmarkNode, type BrowserTab } from './bookmarks';
import { tabUrl } from './urlIdentity';

const AUTO_TAB_FOLDER_PREFIX = 'auto-tab-folder:';

export function isAutoTabFolderId(id: string): boolean {
  return id.startsWith(AUTO_TAB_FOLDER_PREFIX);
}

export interface AutoTabFolderTree {
  nodes: BookmarkNode[];
  memberIdsByFolderId: ReadonlyMap<string, readonly string[]>;
}

export interface AutoTabFolderIdentity {
  key: string;
  title: string;
}

export function autoTabFolderIdentity(tab: Pick<BrowserTab, 'pendingUrl' | 'url'>): AutoTabFolderIdentity {
  const rawUrl = tabUrl(tab);
  if (rawUrl) {
    try {
      const url = new URL(rawUrl);
      const hostname = url.hostname.toLocaleLowerCase().replace(/^www\./, '');
      if (hostname) return { key: `host:${hostname}`, title: hostname };
      const protocol = url.protocol.slice(0, -1).toLocaleLowerCase();
      if (protocol) return { key: `protocol:${protocol}`, title: `${protocol}:` };
    } catch {}
  }
  return { key: 'other', title: 'Other tabs' };
}

export function autoTabFolderId(key: string): string {
  return `auto-tab-folder:${encodeURIComponent(key)}`;
}

export function settleAutoTabFolderIdentities(
  tabs: readonly BrowserTab[],
  previous: ReadonlyMap<number, AutoTabFolderIdentity>,
): Map<number, AutoTabFolderIdentity> {
  return new Map(tabs.flatMap((tab) => {
    if (tab.id === undefined) return [];
    const identity = tab.status === 'loading'
      ? previous.get(tab.id) ?? autoTabFolderIdentity(tab)
      : autoTabFolderIdentity(tab);
    return [[tab.id, identity] as const];
  }));
}

/**
 * Root-level tabs gather into one virtual folder per domain, shown where the
 * domain's first tab sits. Manual folders and their contents are untouched.
 * A split view joins the folder of its first pane, the tab it was dropped on.
 */
export function projectAutoTabFolders(
  rootNodes: readonly BookmarkNode[],
  rootId: string,
  identityForNode: (node: BookmarkNode) => AutoTabFolderIdentity | undefined,
): AutoTabFolderTree {
  const members = new Map<string, BookmarkNode[]>();
  const nodes: BookmarkNode[] = [];
  for (const node of rootNodes) {
    const firstPane = isSplitViewFolder(node) ? node.children?.[0] : undefined;
    const identity = isSplitViewFolder(node)
      ? firstPane?.url ? identityForNode(firstPane) : undefined
      : identityForNode(node);
    if (!identity) {
      nodes.push(node);
      continue;
    }
    const id = autoTabFolderId(identity.key);
    const existing = members.get(id);
    if (existing) {
      existing.push(node);
      continue;
    }
    members.set(id, [node]);
    nodes.push({ id, parentId: rootId, title: identity.title, syncing: false });
  }
  return {
    nodes: nodes.map((node, index) => {
      const children = members.get(node.id);
      return {
        ...node,
        index,
        ...(children
          ? {
              children: children.map((child, childIndex) => ({
                ...child,
                parentId: node.id,
                index: childIndex,
              })),
            }
          : {}),
      };
    }),
    memberIdsByFolderId: new Map([...members].map(([id, children]) =>
      [id, children.map((child) => child.id)])),
  };
}

/** Maps a drop position in the displayed autofolder tree to the real tab tree. */
export function realAutoTabFolderDestination(
  tree: AutoTabFolderTree,
  rootId: string,
  realIndexById: ReadonlyMap<string, number>,
  destination: { parentId: string; index?: number },
): { parentId: string; index?: number } {
  const members = tree.memberIdsByFolderId.get(destination.parentId);
  if (!members && destination.parentId !== rootId) return destination;
  const realIndexes = (ids: readonly string[]) => ids.flatMap((id) => {
    const index = realIndexById.get(id);
    return index === undefined ? [] : [index];
  });
  if (members) {
    const next = destination.index === undefined
      ? undefined
      : realIndexById.get(members[destination.index] ?? '');
    if (next !== undefined) return { parentId: rootId, index: next };
    const last = Math.max(...realIndexes(members));
    return Number.isFinite(last) ? { parentId: rootId, index: last + 1 } : { parentId: rootId };
  }
  const node = destination.index === undefined ? undefined : tree.nodes[destination.index];
  const first = Math.min(...realIndexes(
    node ? tree.memberIdsByFolderId.get(node.id) ?? [node.id] : [],
  ));
  return Number.isFinite(first) ? { parentId: rootId, index: first } : { parentId: rootId };
}
