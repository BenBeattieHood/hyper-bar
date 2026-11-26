import type { HyperModelSnapshot } from './model';
import { SupersededTargetError } from './modelGuards';

interface ChoosingClient {
  role: string;
  windowId: number;
}

export interface WindowSpaceChoiceDependencies {
  /** A lighter activation for views that do not show a space themselves. */
  activateFromSearch(spaceId: string, windowId: number): Promise<void>;
  hasParkedTabs(spaceId: string): Promise<boolean>;
  model(): Pick<HyperModelSnapshot, 'runtime'>;
  queueMutation<Result>(operation: () => Promise<Result>): Promise<Result>;
  switcher: {
    admit(windowId: number, spaceId: string): void;
    runIfLatest(windowId: number, spaceId: string, run: () => Promise<void>): Promise<void>;
    select(
      spaceId: string,
      windowId: number,
      options: { blankTab?: boolean; reconcile: boolean; takeNewTab?: boolean },
    ): Promise<void>;
  };
}

/**
 * The one path by which an intent takes a window to another space.
 *
 * Selecting a space, opening a page that lives in another space, and focusing
 * a tab in another space are each a single user choice. The background makes
 * the switch and then the effect, so no view has to sequence two intents, and
 * the latest choice in a window always wins over one still running.
 */
export function createWindowSpaceChoice(dependencies: WindowSpaceChoiceDependencies) {
  const activeSpaceId = (windowId: number) =>
    dependencies.model().runtime.activeSpaceIds[windowId];

  /** Switches the window; an intent showing a page there asks for no blank tab. */
  const switchTo = (spaceId: string, client: ChoosingClient, blankTab?: boolean) =>
    dependencies.switcher.runIfLatest(client.windowId, spaceId, async () =>
      // Parked tabs reopen through a full switch, whichever view asked for it.
      client.role === 'sidebar' || await dependencies.hasParkedTabs(spaceId)
        ? dependencies.switcher.select(spaceId, client.windowId, { blankTab, reconcile: false })
        : dependencies.activateFromSearch(spaceId, client.windowId));

  const pageSpaceElsewhere = (
    page: { active: boolean; destinationSpaceId?: string },
    windowId: number,
  ) => page.active && page.destinationSpaceId !== undefined &&
    page.destinationSpaceId !== activeSpaceId(windowId)
    ? page.destinationSpaceId
    : undefined;

  // The sidebar shows one space, so a tab it focuses in another takes the window there.
  const tabSpaceElsewhere = (tabId: number, client: ChoosingClient) => {
    if (client.role !== 'sidebar') return undefined;
    const spaceId = dependencies.model().runtime.tabOwnerships[tabId]?.spaceId;
    return spaceId !== undefined && spaceId !== activeSpaceId(client.windowId) ? spaceId : undefined;
  };

  const before = (spaceId: string | undefined, client: ChoosingClient) => ({
    admit: () => {
      if (spaceId) dependencies.switcher.admit(client.windowId, spaceId);
    },
    run: async () => {
      if (spaceId) await switchTo(spaceId, client, false);
    },
  });

  return {
    /** A page opening in another space: admitted with the intent, switched before it shows. */
    beforePage: (page: { active: boolean; destinationSpaceId?: string }, client: ChoosingClient) =>
      before(pageSpaceElsewhere(page, client.windowId), client),
    beforeTab: (tabId: number, client: ChoosingClient) => before(tabSpaceElsewhere(tabId, client), client),
    select: (spaceId: string, client: ChoosingClient) => {
      dependencies.switcher.admit(client.windowId, spaceId);
    },
    /** A new space opens on the window's focused new tab page, or else on a new one. */
    showNewSpace: (spaceId: string, client: ChoosingClient) => dependencies.queueMutation(() =>
      dependencies.switcher.runIfLatest(client.windowId, spaceId, () =>
        dependencies.switcher.select(spaceId, client.windowId, { reconcile: false, takeNewTab: true }))),
    switchTo: (spaceId: string, client: ChoosingClient) =>
      dependencies.queueMutation(() => switchTo(spaceId, client)),
  };
}

export type WindowSpaceChoice = ReturnType<typeof createWindowSpaceChoice>;

/**
 * Takes the window to a space just made in it, as a new space or a copy is made
 * to be worked in. The space exists either way; a newer choice in the window simply wins.
 */
export async function goToNewSpace(
  windowSpaces: Pick<WindowSpaceChoice, 'select' | 'showNewSpace'>,
  spaceId: string,
  client: ChoosingClient,
  failure: string,
): Promise<void> {
  windowSpaces.select(spaceId, client);
  await windowSpaces.showNewSpace(spaceId, client).catch((error: unknown) => {
    if (!(error instanceof SupersededTargetError)) console.error(failure, error);
  });
}
