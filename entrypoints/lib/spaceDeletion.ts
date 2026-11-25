import {
  isBookmarkFolder,
  isLocalBookmarkNode,
  visibleBookmarkTitle,
  type BookmarkNode,
  type BrowserTab,
  type Space,
} from './bookmarks';
import {
  deleteSpaceViolations,
  type DeleteSpaceProof,
} from './modelActions';
import type {
  DurableOperation,
  DurableOperationResolution,
} from './operationJournal';
import type { TabOwnership } from './tabOwnership';
import { parseSpaceGroupKey } from './spaceGroupStore';

export interface TabOwnershipObservation {
  ownership?: TabOwnership;
  tab: BrowserTab;
}

export interface SpaceGroupMapping {
  groupId: number;
  key: string;
}

export const MAX_GROUP_RELEASE_ATTEMPTS = 3;

export interface ProvisionalSpaceInfrastructureDependencies {
  getBookmark(bookmarkId: string): Promise<BookmarkNode | undefined>;
  getBookmarkChildren(parentId: string): Promise<readonly BookmarkNode[]>;
  isInfrastructureFolder(node: BookmarkNode): boolean;
  visibleTitle(node: BookmarkNode): string;
}

export async function provisionalSpaceInfrastructureIds(
  spaceId: string,
  expectedTitle: string | undefined,
  dependencies: ProvisionalSpaceInfrastructureDependencies,
): Promise<string[] | undefined> {
  if (expectedTitle === undefined) return [];
  const space = await dependencies.getBookmark(spaceId);
  if (!space || dependencies.visibleTitle(space) !== expectedTitle) return undefined;
  const children = await dependencies.getBookmarkChildren(spaceId);
  if (!children.every((child) =>
    child.parentId === spaceId && dependencies.isInfrastructureFolder(child))) {
    return undefined;
  }
  const infrastructureChildren = await Promise.all(children.map(
    (child) => dependencies.getBookmarkChildren(child.id),
  ));
  return infrastructureChildren.every((nodes) => nodes.length === 0)
    ? children.map((child) => child.id)
    : undefined;
}

export function ownedTabIdsForSpace(
  observations: readonly TabOwnershipObservation[],
  spaceId: string,
): number[] {
  return observations.flatMap(({ tab, ownership }) =>
    tab.id !== undefined && !tab.incognito && ownership?.spaceId === spaceId
      ? [tab.id]
      : []);
}

/** The deleted space's name, numbered past any folder already called that where it lands. */
export function movedBookmarksFolderTitle(
  spaceTitle: string,
  destinationNodes: readonly BookmarkNode[],
): string {
  const taken = new Set(destinationNodes.flatMap((node) =>
    isBookmarkFolder(node) ? [visibleBookmarkTitle(node).toLocaleLowerCase()] : []));
  let title = spaceTitle;
  for (let number = 2; taken.has(title.toLocaleLowerCase()); number += 1) {
    title = `${spaceTitle} ${number}`;
  }
  return title;
}

export interface SpaceBookmarkMoveDependencies {
  createBookmarkFolder(parentId: string, title: string): Promise<Pick<BookmarkNode, 'id'>>;
  moveBookmark(bookmarkId: string, parentId: string): Promise<unknown>;
}

/** Moves a space's bookmarks, in order, into a folder named for it at the end of another space's list. */
export async function moveSpaceBookmarks(
  source: Pick<Space, 'children' | 'title'>,
  destination: Pick<Space, 'children'> & { rootId: string },
  dependencies: SpaceBookmarkMoveDependencies,
): Promise<string | undefined> {
  const nodes = source.children.filter(isLocalBookmarkNode);
  if (nodes.length === 0) return undefined;
  const folder = await dependencies.createBookmarkFolder(
    destination.rootId,
    movedBookmarksFolderTitle(source.title, destination.children.filter(isLocalBookmarkNode)),
  );
  for (const node of nodes) await dependencies.moveBookmark(node.id, folder.id);
  return folder.id;
}

export function spaceGroupMappingsForSpace(
  values: Readonly<Record<string, unknown>>,
  spaceId: string,
): SpaceGroupMapping[] {
  return Object.entries(values).flatMap(([key, value]) =>
    parseSpaceGroupKey(key)?.spaceId === spaceId && typeof value === 'number'
      ? [{ groupId: value, key }]
      : []);
}

export function bookmarkParentIds(
  nodes: readonly BookmarkNode[],
): ReadonlyMap<string, string> {
  const parentIds = new Map<string, string>();
  const visit = (children: readonly BookmarkNode[]) => {
    for (const node of children) {
      parentIds.set(node.id, node.parentId ?? '');
      visit(node.children ?? []);
    }
  };
  visit(nodes);
  return parentIds;
}

export function liveGroupIds(tabs: readonly BrowserTab[]): ReadonlySet<number> {
  return new Set(tabs.flatMap((tab) =>
    typeof tab.groupId === 'number' && tab.groupId >= 0 ? [tab.groupId] : []));
}

export interface MappedGroupReleaseDependencies {
  isMapped(groupId: number): Promise<boolean>;
  listTabs(): Promise<readonly BrowserTab[]>;
  ungroup(tabIds: readonly number[]): Promise<void>;
}

/** Releases only groups that remain mapped at each destructive browser call. */
export async function releaseMappedGroups(
  groupIds: readonly number[],
  dependencies: MappedGroupReleaseDependencies,
): Promise<number[]> {
  const released = new Set<number>();
  for (const groupId of new Set(groupIds)) {
    for (let attempt = 0; attempt < MAX_GROUP_RELEASE_ATTEMPTS; attempt += 1) {
      if (!await dependencies.isMapped(groupId)) break;
      const tabIds = (await dependencies.listTabs()).flatMap((tab) =>
        tab.id !== undefined && tab.groupId === groupId ? [tab.id] : []);
      if (tabIds.length === 0) {
        released.add(groupId);
        break;
      }
      if (!await dependencies.isMapped(groupId)) break;
      await dependencies.ungroup(tabIds);
      const stillGrouped = (await dependencies.listTabs()).some((tab) =>
        tab.groupId === groupId);
      if (!stillGrouped) {
        released.add(groupId);
        break;
      }
      if (attempt === MAX_GROUP_RELEASE_ATTEMPTS - 1 &&
        await dependencies.isMapped(groupId)) {
        throw new Error('A native group changed while its space was being deleted.');
      }
    }
  }
  return [...released];
}

export interface SpaceGroupCleanupDependencies {
  listTabs(): Promise<readonly BrowserTab[]>;
  readSession(): Promise<Readonly<Record<string, unknown>>>;
  removeSessionKeys(keys: readonly string[]): Promise<void>;
  ungroup?: (tabIds: readonly number[]) => Promise<void>;
}

/** Releases groups and removes only the source mappings still proven current. */
export async function releaseAndRemoveSpaceGroupMappings(
  mappings: readonly SpaceGroupMapping[],
  dependencies: SpaceGroupCleanupDependencies,
): Promise<number[]> {
  const isMapped = async (groupId: number) => {
    const latest = await dependencies.readSession();
    return mappings.some((mapping) =>
      mapping.groupId === groupId && latest[mapping.key] === groupId);
  };
  const releasedGroupIds = await releaseMappedGroups(
    mappings.map(({ groupId }) => groupId),
    {
      isMapped,
      listTabs: dependencies.listTabs,
      ungroup: async (tabIds) => {
        if (!dependencies.ungroup) {
          throw new Error('Native tab groups cannot be released in this browser.');
        }
        await dependencies.ungroup(tabIds);
      },
    },
  );
  const latest = await dependencies.readSession();
  const mappingKeys = mappings.flatMap(({ groupId, key }) => {
    const current = latest[key];
    if (current === undefined) return [];
    if (current !== groupId) {
      throw new Error('A native group mapping changed while its space was being deleted.');
    }
    return [key];
  });
  if (mappingKeys.length > 0) await dependencies.removeSessionKeys(mappingKeys);
  return releasedGroupIds;
}

export interface SpaceDeletionVerificationDependencies {
  getBookmarkTree(): Promise<readonly BookmarkNode[]>;
  listTabs(): Promise<readonly BrowserTab[]>;
  readSession(): Promise<Readonly<Record<string, unknown>>>;
}

export async function deleteSpacePostconditionViolations(
  verification: DeleteSpaceProof,
  dependencies: SpaceDeletionVerificationDependencies,
): Promise<readonly string[]> {
  const [tree, tabs, session] = await Promise.all([
    dependencies.getBookmarkTree(),
    dependencies.listTabs(),
    dependencies.readSession(),
  ]);
  return deleteSpaceViolations(verification, {
    bookmarkParentIds: bookmarkParentIds(tree),
    claimedBackingIds: new Set<string>(),
    liveGroupIds: liveGroupIds(tabs),
    liveTabIds: new Set(tabs.flatMap((tab) => tab.id === undefined ? [] : [tab.id])),
    mappedGroupIds: new Set(spaceGroupMappingsForSpace(
      session,
      verification.spaceRootId,
    ).map(({ groupId }) => groupId)),
  });
}

export interface DeleteSpaceRecoveryDependencies {
  getBookmark(bookmarkId: string): Promise<BookmarkNode | undefined>;
  getTabOwnership(tabId: number): Promise<TabOwnership | undefined>;
  listTabs(): Promise<readonly BrowserTab[]>;
  readSession(): Promise<Readonly<Record<string, unknown>>>;
}

export async function recoverDeletedSpaceOperation(
  operation: DurableOperation,
  dependencies: DeleteSpaceRecoveryDependencies,
): Promise<DurableOperationResolution> {
  if (operation.kind !== 'delete-space') {
    return { reason: 'The operation is not a space deletion.', status: 'abandoned' };
  }
  const sourceSpaceId = operation.completionProof.sourceSpaceId;
  if (typeof sourceSpaceId !== 'string') {
    return { reason: 'The deleted space identity is invalid.', status: 'abandoned' };
  }
  if (await dependencies.getBookmark(sourceSpaceId)) {
    return {
      reason: 'The source space remains present after interrupted deletion.',
      status: 'abandoned',
    };
  }
  const tabs = await dependencies.listTabs();
  const stillOwned = await Promise.all(tabs.flatMap((tab) => tab.id === undefined
    ? []
    : [dependencies.getTabOwnership(tab.id).then((ownership) =>
      ownership?.spaceId === sourceSpaceId)]));
  if (stillOwned.some(Boolean)) {
    return { reason: 'A live tab still claims the removed space.', status: 'abandoned' };
  }
  if (spaceGroupMappingsForSpace(await dependencies.readSession(), sourceSpaceId).length > 0) {
    return { reason: 'A native group still claims the removed space.', status: 'abandoned' };
  }
  const releasedGroupIds = operation.payload.releasedGroupIds;
  if (releasedGroupIds !== undefined) {
    if (!Array.isArray(releasedGroupIds) || !releasedGroupIds.every(
      (groupId) => typeof groupId === 'number',
    )) {
      return {
        reason: 'The released native group identities were not fully recorded.',
        status: 'abandoned',
      };
    }
    const remainingGroupIds = liveGroupIds(tabs);
    if (releasedGroupIds.some((groupId) => remainingGroupIds.has(groupId))) {
      return { reason: 'A released native group still contains tabs.', status: 'abandoned' };
    }
  }
  return { status: 'completed' };
}