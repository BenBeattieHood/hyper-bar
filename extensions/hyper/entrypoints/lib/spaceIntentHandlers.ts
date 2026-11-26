import type { BrowserTab } from './bookmarks';
import {
  closedTabsSeries,
  closedTabsText,
  isBlankTab,
  reopenClosedTabs,
  snapshotClosingTabs,
  type ClosedSpaceTabs,
} from './closedTabsUndo';
import type { HyperActionKind } from './modelActions';
import { spaceTarget, windowTarget } from './modelGuards';
import { intentHandler, type HyperIntentHandlers } from './modelIntents';
import {
  parseDuplicateSpacePayload,
  parseSetSpaceArchivedPayload,
  parseSpaceTabsPayload,
  type SetSpaceArchivedPayload,
} from './modelIntentPayloads';
import { duplicateSpace } from './spaceDuplication';
import type { SpaceTabRestore } from './spaceTabRestore';
import { loadTabOwnerships, tabsOwnedBySpace } from './tabOwnership';
import { isTabUnloaded, tabById } from './tabs';
import type { RemadeBookmarks, TimedMessages } from './timedMessages';
import { goToNewSpace, type WindowSpaceChoice } from './windowSpaceChoice';
import { getWindowActiveSpaceId } from './windowState';

type SpaceIntentKind = Extract<
  HyperActionKind,
  'closeSpaceTabs' | 'duplicateSpace' | 'reloadSpaceTabs' | 'setSpaceArchived'
>;

export interface SpaceIntentHandlerDependencies {
  closeTabs(tabIds: number[]): Promise<void>;
  markIntentionalTab(tabId: number): void;
  messages: Pick<TimedMessages, 'offer'>;
  queueMutation<Result>(operation: () => Promise<Result>): Promise<Result>;
  restoreSpaceTabs: SpaceTabRestore;
  routeTab(tabId: number, spaceId: string): Promise<void>;
  setSpaceArchived(payload: SetSpaceArchivedPayload): Promise<void>;
  /** Read when a handler runs: the background builds the handlers before its window choice. */
  windowSpaces(): Pick<WindowSpaceChoice, 'select' | 'showNewSpace'>;
}

/** The tab left showing in place of the closed ones, which an undo closes again if Hyper opened it. */
interface Placeholder {
  created: boolean;
  spaceId: string;
  tabId: number;
}

/** A window's tabs in a space; pinned tabs belong to no space, whatever they once did. */
async function windowSpaceTabs(spaceId: string, windowId: number) {
  const windowTabs = await browser.tabs.query({ windowId });
  const ownerships = await loadTabOwnerships(windowTabs);
  return {
    owned: tabsOwnedBySpace(windowTabs, ownerships, spaceId).filter((tab) => !tab.pinned),
    ownerships,
  };
}

/**
 * Acts on a whole space at once from its menu. A copy opens in the window
 * that asked for it; closing and reloading touch only that window's tabs.
 */
export function createSpaceIntentHandlers(
  dependencies: SpaceIntentHandlerDependencies,
): Pick<HyperIntentHandlers, SpaceIntentKind> {
  const queueMutation = dependencies.queueMutation;

  /** A window showing the space keeps showing it, on a new tab page, rather than going elsewhere. */
  const placeholderFor = async (
    spaceId: string,
    windowId: number,
    owned: readonly BrowserTab[],
  ): Promise<Placeholder> => {
    const shownSpaceId = (await getWindowActiveSpaceId(windowId)) ?? spaceId;
    const blank = shownSpaceId === spaceId
      ? owned.filter(isBlankTab).sort((left, right) => Number(right.active) - Number(left.active))[0]
      : undefined;
    if (blank?.id !== undefined) {
      if (!blank.active) await browser.tabs.update(blank.id, { active: true });
      return { created: false, spaceId, tabId: blank.id };
    }
    const tab = await browser.tabs.create({ active: true, windowId });
    if (tab.id === undefined) throw new Error('A new tab could not be opened.');
    try {
      dependencies.markIntentionalTab(tab.id);
      await dependencies.routeTab(tab.id, shownSpaceId);
    } catch (error) {
      await browser.tabs.remove(tab.id).catch(() => undefined);
      throw error;
    }
    return { created: true, spaceId: shownSpaceId, tabId: tab.id };
  };

  const closeSpaceTabs = async (spaceId: string, windowId: number) => {
    const { owned, ownerships } = await windowSpaceTabs(spaceId, windowId);
    const active = owned.find((tab) => tab.active);
    // Closing the shown tab would let the browser show a neighbour, which may be another space's.
    const placeholder = active ? await placeholderFor(spaceId, windowId, owned) : undefined;
    const closing = owned.filter((tab) => tab.id !== placeholder?.tabId);
    if (closing.length === 0) return;
    const [closed] = await snapshotClosingTabs(closing, ownerships);
    await dependencies.closeTabs(closing.map((tab) => tab.id as number));
    // A blank page has nothing to bring back, so the count is of pages, as the space's menu counted them.
    const pages = closing.filter((tab) => !isBlankTab(tab));
    if (!closed || pages.length === 0) return;
    dependencies.messages.offer(windowId, {
      act: (remade) => queueMutation(() => reopenSpaceTabs(closed, placeholder, remade)),
      kind: 'undo',
      series: closedTabsSeries(pages.flatMap((tab) => ownerships[tab.id as number]?.backingId ?? [])),
      ...closedTabsText(pages),
    });
  };

  /**
   * Puts closed tabs back where they were in the space, as they were named and
   * linked, and shows the one that was showing if the window still shows the
   * placeholder that stood in for it.
   */
  const reopenSpaceTabs = async (closed: ClosedSpaceTabs, placeholder?: Placeholder, remade?: RemadeBookmarks) => {
    const { reopened, shownTabId } = await reopenClosedTabs(closed, dependencies, remade);
    if (!placeholder || reopened.length === 0) return;
    const standIn = await tabById(placeholder.tabId);
    if (!standIn || !isBlankTab(standIn)) return;
    if (standIn.active && placeholder.spaceId === closed.spaceId) {
      const shown = shownTabId ?? reopened[0];
      if (shown !== undefined) await browser.tabs.update(shown, { active: true });
    }
    if (placeholder.created && !(await tabById(placeholder.tabId))?.active) {
      await dependencies.closeTabs([placeholder.tabId]);
    }
  };

  return {
    closeSpaceTabs: intentHandler({
      parse: parseSpaceTabsPayload,
      run: ({ spaceId }, client) => queueMutation(() => closeSpaceTabs(spaceId, client.windowId)),
      targets: ({ spaceId }, client) => [spaceTarget(spaceId), windowTarget(client.windowId)],
    }),
    duplicateSpace: intentHandler({
      parse: parseDuplicateSpacePayload,
      run: async ({ spaceId, withTabs }, client) => {
        const space = await queueMutation(() => duplicateSpace({
          sourceSpaceId: spaceId,
          windowId: client.windowId,
          withTabs,
        }));
        await goToNewSpace(dependencies.windowSpaces(), space.id, client, 'Unable to show the space copy.');
        return space;
      },
      targets: ({ spaceId }, client) => [spaceTarget(spaceId), windowTarget(client.windowId)],
    }),
    reloadSpaceTabs: intentHandler({
      parse: parseSpaceTabsPayload,
      run: ({ spaceId }, client) => queueMutation(async () => {
        const { owned } = await windowSpaceTabs(spaceId, client.windowId);
        // A tab holding no page loads it afresh when shown, so loading it now only costs memory.
        await Promise.all(owned.flatMap((tab) =>
          tab.id === undefined || isTabUnloaded(tab) || isBlankTab(tab) ? [] : [browser.tabs.reload(tab.id)]));
      }),
      targets: ({ spaceId }, client) => [spaceTarget(spaceId), windowTarget(client.windowId)],
    }),
    setSpaceArchived: intentHandler({
      parse: parseSetSpaceArchivedPayload,
      // Queues its own steps: archiving switches windows between them, which queues too.
      run: (payload) => dependencies.setSpaceArchived(payload),
      targets: ({ spaceId }, client) => [spaceTarget(spaceId), windowTarget(client.windowId)],
    }),
  };
}
