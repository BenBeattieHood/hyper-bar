import { createCoalescedAsyncRunner } from './async';
import { bookmarkableTabUrl, shownSpaces, type BrowserTab, type Space } from './bookmarks';
import { groupOwnerships } from './groupOwnership';
import { hyperModelAtom, type HyperModelSnapshot, type HyperModelStore } from './model';
import { SupersededTargetError, spaceTarget, windowTarget } from './modelGuards';
import { ownershipNamesAnotherWindow } from './tabDisposition';
import { loadTabOwnerships, type TabOwnership } from './tabOwnership';
import { unroutedTabIds } from './tabs';
import { getWindowActiveSpaceId, windowById } from './windowState';

/** Each window's space as maintenance last left it; null once a window was offered one and took none. */
export type WindowSpaces = ReadonlyMap<number, string | null>;

export interface WindowSpacePlan {
  /** Windows whose space needs showing: they have none, or theirs was removed. */
  needed: number[];
  windowSpaces: Map<number, string | null>;
}

export const pendingTargets = (snapshot: HyperModelSnapshot): ReadonlySet<string> =>
  new Set(Object.values(snapshot.commands).flatMap((command) =>
    command.phase === 'pending' ? command.targets : []));

const isBusy = (busy: ReadonlySet<string>, windowId: number, space: string | null | undefined) =>
  busy.has(windowTarget(windowId)) || (typeof space === 'string' && busy.has(spaceTarget(space)));

/**
 * Which windows need their space shown. A window with no space takes one, and a
 * window whose space was removed shows the one it has now. A window a running
 * command is changing is left to that command, so maintenance only ever follows
 * a settled choice rather than racing one.
 */
export function planWindowSpaces(snapshot: HyperModelSnapshot, previous: WindowSpaces): WindowSpacePlan {
  const windowSpaces = new Map<number, string | null>();
  const needed: number[] = [];
  // An archived space counts as removed: a window showing it takes another.
  const spaceIds = new Set(shownSpaces(snapshot.hyper.spaces).map((space) => space.id));
  // Until the structure is repaired there is no space to show.
  if (spaceIds.size === 0) return { needed, windowSpaces: new Map(previous) };
  const busy = pendingTargets(snapshot);
  for (const window of snapshot.browser.windows) {
    if (window.id === undefined || window.type !== 'normal' || window.incognito) continue;
    const last = previous.get(window.id);
    const active = snapshot.runtime.activeSpaceIds[window.id];
    const hasSpace = active !== undefined && spaceIds.has(active);
    if (isBusy(busy, window.id, last)) {
      if (last !== undefined) windowSpaces.set(window.id, last);
    } else if (hasSpace && !(typeof last === 'string' && !spaceIds.has(last))) {
      windowSpaces.set(window.id, active);
    } else if (!hasSpace && last === null) {
      windowSpaces.set(window.id, null);
    } else {
      if (last !== undefined) windowSpaces.set(window.id, last);
      needed.push(window.id);
    }
  }
  return { needed, windowSpaces };
}

/**
 * What the group colour pass reads: which spaces exist, each group's colour and
 * window, and which space owns which group. A change to any of them, from Hyper
 * or from the user recolouring a group in the browser, runs the pass.
 */
export function groupColourSignature(snapshot: HyperModelSnapshot): string {
  const spaces = snapshot.hyper.spaces.map((space) => space.id);
  const groups = snapshot.browser.tabGroups.map((group) => `${group.id}@${group.windowId}=${group.color}`);
  const owned = groupOwnerships(snapshot.runtime.groupOwnership)
    .map((ownership) => `${ownership.spaceId}:${ownership.groupId}`);
  return [spaces.join(','), groups.sort().join(','), owned.sort().join(',')].join('|');
}

/**
 * The space a window with none shows: its active tab's, else the first space its
 * tabs belong to, else the first space. A tab still arriving from another window
 * has not joined this one's space, so it does not choose.
 */
export function defaultWindowSpaceId(
  tabs: readonly BrowserTab[],
  ownerships: Readonly<Record<number, TabOwnership>>,
  spaces: readonly Pick<Space, 'id'>[],
): string | undefined {
  const spaceIds = new Set(spaces.map((space) => space.id));
  const candidates = [...tabs].sort((left, right) =>
    Number(right.active) - Number(left.active) || left.index - right.index);
  for (const tab of candidates) {
    const ownership = tab.id === undefined ? undefined : ownerships[tab.id];
    if (ownership && spaceIds.has(ownership.spaceId) && !ownershipNamesAnotherWindow(tab, ownership)) {
      return ownership.spaceId;
    }
  }
  return spaces[0]?.id;
}

export interface SpaceWindowMaintenanceDependencies {
  /** Resolves once the browser has finished restoring windows and their tabs. */
  browserSettled(): Promise<void>;
  persistWindowActiveSpace(windowId: number, spaceId: string): Promise<void>;
  queueMutation<Result>(operation: () => Promise<Result>): Promise<Result>;
  /** Gives every group its space's colour, taking a colour the user gave a group into its space; false to retry. */
  reconcileGroupColours(): Promise<boolean>;
  /** Orders and titles the native groups by the space order. */
  reconcileGroupOrder(spaces: readonly Space[]): Promise<void>;
  routeTab(tabId: number): Promise<void>;
  /** Shows the space a window has selected, with its siblings collapsed, without opening a tab for it. */
  showSpace(spaceId: string, windowId: number): Promise<void>;
  store: HyperModelStore;
}

/**
 * Keeps every window showing a space from changes to the model, whether or not
 * any view is open: a window with no space takes one, a window whose space was
 * removed shows its replacement, and native groups follow the space order and colours.
 */
export function createSpaceWindowMaintenance(dependencies: SpaceWindowMaintenanceDependencies) {
  let started = false;
  let windowSpaces = new Map<number, string | null>();
  let groupOrder: string | undefined;
  let groupColours: string | undefined;
  const needed = new Set<number>();
  const orderOf = (spaces: readonly Space[]) => spaces.map((space) => space.id).join(',');

  const showWindowSpace = async (windowId: number) => {
    const snapshot = dependencies.store.get(hyperModelAtom);
    const spaces = shownSpaces(snapshot.hyper.spaces);
    const last = windowSpaces.get(windowId);
    // A command admitted since the plan now owns the window; its settlement plans again.
    if (spaces.length === 0 || isBusy(pendingTargets(snapshot), windowId, last)) return;
    const window = await windowById(windowId);
    if (window?.type !== 'normal' || window.incognito) return;
    const stored = await getWindowActiveSpaceId(windowId);
    let spaceId = spaces.some((space) => space.id === stored) ? stored : undefined;
    const lastRemoved = typeof last === 'string' && !spaces.some((space) => space.id === last);
    if (spaceId !== undefined && !lastRemoved) {
      windowSpaces.set(windowId, spaceId);
      return;
    }
    if (spaceId === undefined) {
      windowSpaces.set(windowId, null);
      const tabs = await browser.tabs.query({ windowId });
      const ownerships = await loadTabOwnerships(tabs);
      spaceId = defaultWindowSpaceId(tabs, ownerships, spaces);
      if (spaceId === undefined) return;
      await dependencies.persistWindowActiveSpace(windowId, spaceId);
      // Pages opened while the window had no space join it now; a blank page joins when it navigates.
      const extensionOrigin = browser.runtime.getURL('');
      const pages = tabs.filter((tab) => bookmarkableTabUrl(tab, extensionOrigin) !== null);
      for (const tabId of unroutedTabIds(pages, ownerships, extensionOrigin)) {
        await dependencies.routeTab(tabId);
      }
    }
    windowSpaces.set(windowId, spaceId);
    await dependencies.showSpace(spaceId, windowId).catch((error: unknown) => {
      // A newer choice took the window over, and it shows its own space.
      if (!(error instanceof SupersededTargetError)) throw error;
    });
  };

  const run = createCoalescedAsyncRunner(async () => {
    await dependencies.browserSettled();
    const { spaces } = dependencies.store.get(hyperModelAtom).hyper;
    if (spaces.length > 0 && orderOf(spaces) !== groupOrder) {
      groupOrder = orderOf(spaces);
      await dependencies.queueMutation(() => dependencies.reconcileGroupOrder(spaces))
        .catch(() => undefined);
    }
    const colourSignature = groupColourSignature(dependencies.store.get(hyperModelAtom));
    if (colourSignature !== groupColours) {
      groupColours = colourSignature;
      const settled = await dependencies.queueMutation(() => dependencies.reconcileGroupColours())
        .catch(() => false);
      // A refused recolour runs again on the next model change.
      if (!settled && groupColours === colourSignature) groupColours = undefined;
    }
    for (const windowId of [...needed]) {
      needed.delete(windowId);
      await dependencies.queueMutation(() => showWindowSpace(windowId)).catch(() => undefined);
    }
  });

  const evaluate = () => {
    if (!started) return;
    const snapshot = dependencies.store.get(hyperModelAtom);
    const plan = planWindowSpaces(snapshot, windowSpaces);
    windowSpaces = plan.windowSpaces;
    for (const windowId of plan.needed) needed.add(windowId);
    const { spaces } = snapshot.hyper;
    if (
      needed.size > 0 ||
      (spaces.length > 0 && orderOf(spaces) !== groupOrder) ||
      groupColourSignature(snapshot) !== groupColours
    ) {
      void run().catch(() => undefined);
    }
  };
  dependencies.store.sub(hyperModelAtom, evaluate);

  return {
    /** Begins once startup has restored what it can, so maintenance never races it. */
    start() {
      started = true;
      evaluate();
    },
  };
}
