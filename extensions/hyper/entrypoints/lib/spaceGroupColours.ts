import { bookmarkById } from './bookmarkStorage';
import {
  deriveSpaces,
  findHyperBookmarkStructure,
  spaceBookmarkTitleWithoutColour,
  type Space,
} from './bookmarks';
import { isRecord } from './collections';
import {
  groupOwnerships,
  liveSpaceColours,
  ownedGroupColours,
  resolveGroupOwnership,
  type GroupOwnership,
  type ObservedGroup,
} from './groupOwnership';
import { sessionStorageArea } from './sessionValues';
import { allSpaceGroups } from './spaceGroupStore';
import {
  defaultHyperGroupColour,
  isTabGroupColour,
  nativeTabGroups,
  type ProgrammaticGroupUpdates,
  type TabGroupColour,
} from './tabGroups';

/**
 * The colour Hyper last gave or saw on each group it owns, by group id, kept for
 * the browser session. A group that no longer wears it was recoloured by the user.
 */
export const SYNCED_GROUP_COLOURS_KEY = 'spaceGroupColours';

/**
 * The colour a new group of the space takes: the one its groups already wear in
 * other windows, else one derived from its id, since a browser group needs one.
 */
export async function newSpaceGroupColour(spaceId: string, windowId: number): Promise<TabGroupColour> {
  const groupsApi = nativeTabGroups('query');
  if (!groupsApi) return defaultHyperGroupColour(spaceId);
  const [groups, mappings] = await Promise.all([groupsApi.query({}), allSpaceGroups()]);
  const { registry } = resolveGroupOwnership(
    mappings,
    new Map(groups.map((group) => [group.id, group.windowId] as const)),
  );
  return liveSpaceColours(groups, groupOwnerships(registry), windowId).get(spaceId)
    ?? defaultHyperGroupColour(spaceId);
}

export interface SpaceColourSyncInput {
  groups: readonly ObservedGroup[];
  ownerships: readonly GroupOwnership[];
  spaces: readonly Pick<Space, 'id'>[];
  synced: Readonly<Record<number, TabGroupColour>>;
}

export interface SpaceColourSyncPlan {
  /** Groups to recolour to the colour their space's other groups wear. */
  updates: Array<{ colour: TabGroupColour; groupId: number }>;
  /** The record to keep, for owned groups that still exist. */
  synced: Record<number, TabGroupColour>;
}

/**
 * Keeps every group a space owns, in every window, wearing one colour. A group
 * the user recoloured since Hyper last synced it sets that colour; otherwise a
 * group Hyper already knows keeps its colour, and a group new to it (adopted,
 * or restored after a restart) takes it. With none known, the first group's wins.
 */
export function planSpaceColourSync(input: SpaceColourSyncInput): SpaceColourSyncPlan {
  const owned = ownedGroupColours(input.groups, input.ownerships);
  const plan: SpaceColourSyncPlan = { synced: {}, updates: [] };
  for (const space of input.spaces) {
    const groups = owned.get(space.id) ?? [];
    if (groups.length === 0) continue;
    const picked = groups.find((group) =>
      input.synced[group.id] !== undefined && input.synced[group.id] !== group.colour);
    const known = groups.find((group) => input.synced[group.id] !== undefined);
    const colour = (picked ?? known ?? groups[0]!).colour;
    for (const group of groups) {
      plan.synced[group.id] = colour;
      if (group.colour !== colour) plan.updates.push({ colour, groupId: group.id });
    }
  }
  return plan;
}

function parseSynced(value: unknown): Record<number, TabGroupColour> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).flatMap(([groupId, colour]) =>
    Number.isSafeInteger(Number(groupId)) && isTabGroupColour(colour)
      ? [[Number(groupId), colour] as const]
      : []));
}

/** Removes the colour earlier versions kept on space folder titles; the groups now hold it. */
export async function removeStoredSpaceColours(): Promise<void> {
  const structure = findHyperBookmarkStructure(await browser.bookmarks.getTree());
  for (const folder of structure?.spaces.children ?? []) {
    if (folder.url || spaceBookmarkTitleWithoutColour(folder) === folder.title) continue;
    // Read again, so a title edited since the tree read is not overwritten.
    const current = await bookmarkById(folder.id);
    if (!current || current.url) continue;
    const title = spaceBookmarkTitleWithoutColour(current);
    if (title !== current.title) await browser.bookmarks.update(folder.id, { title });
  }
}

export type SpaceGroupColoursDependencies = ProgrammaticGroupUpdates;

/**
 * Keeps every space's groups, in every window, wearing one colour, carrying a
 * colour the user gives one of them in the browser to the others. It reads the
 * live groups itself, after any of its own writes, so a stale model read cannot
 * mistake a group it is still recolouring for a choice. Its first pass also
 * removes the colours earlier versions stored on space folders.
 */
export function createSpaceGroupColours(dependencies: SpaceGroupColoursDependencies) {
  let storedColoursRemoved = false;
  return {
    /** Whether every group now wears its space's colour; false when the browser refused one. */
    async reconcileAll(): Promise<boolean> {
      if (!storedColoursRemoved) {
        await removeStoredSpaceColours()
          .then(() => { storedColoursRemoved = true; })
          .catch((error: unknown) => console.error('Unable to remove stored space colours.', error));
      }
      const groupsApi = nativeTabGroups('query', 'update');
      const session = sessionStorageArea();
      if (!groupsApi || !session) return true;
      const [bookmarkTree, groups, mappings, stored] = await Promise.all([
        browser.bookmarks.getTree(),
        groupsApi.query({}),
        allSpaceGroups(),
        session.get(SYNCED_GROUP_COLOURS_KEY).catch(() => ({} as Record<string, unknown>)),
      ]);
      const { registry } = resolveGroupOwnership(
        mappings,
        new Map(groups.map((group) => [group.id, group.windowId] as const)),
      );
      const synced = parseSynced(stored[SYNCED_GROUP_COLOURS_KEY]);
      const plan = planSpaceColourSync({
        groups,
        ownerships: groupOwnerships(registry),
        spaces: deriveSpaces(bookmarkTree),
        synced,
      });
      // Recorded first, so the browser's echo of each update below already matches.
      if (JSON.stringify(plan.synced) !== JSON.stringify(synced)) {
        await session.set({ [SYNCED_GROUP_COLOURS_KEY]: plan.synced });
      }
      const failed: number[] = [];
      for (const { colour, groupId } of plan.updates) {
        dependencies.beginProgrammaticGroupUpdate(groupId);
        try {
          await groupsApi.update(groupId, { color: colour }).catch(() => failed.push(groupId));
        } finally {
          await dependencies.endProgrammaticGroupUpdate(groupId);
        }
      }
      if (failed.length === 0) return true;
      // A group the browser would not recolour, say mid-drag, still wears what it
      // wore, so it must not read as the user's choice on the next pass.
      const restored = { ...plan.synced };
      for (const groupId of failed) {
        if (synced[groupId] === undefined) delete restored[groupId];
        else restored[groupId] = synced[groupId];
      }
      await session.set({ [SYNCED_GROUP_COLOURS_KEY]: restored });
      return false;
    },
  };
}

export type SpaceGroupColours = ReturnType<typeof createSpaceGroupColours>;
