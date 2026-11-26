import { existingBookmarks } from './bookmarkStorage';
import type { HyperActionKind } from './modelActions';
import { intentHandler, runEachItem, type HyperIntentHandlers } from './modelIntents';
import {
  parseActivateTabPayload,
  parseCloseTabsPayload,
  parseCreateTabPayload,
  parseDeleteHistoryPayload,
  parseMoveSessionTabItems,
  parseMoveTabsPayload,
  parseMoveTabToWindowPayload,
  parseNavigateTabPayload,
  parseForgetSearchSelectionPayload,
  parseRecordSearchSelectionPayload,
  parseSetTabGroupPayload,
  parseSetTabMutedPayload,
  type MoveTabsPayload,
  type RemoteTabOperationPayload,
} from './modelIntentPayloads';
import {
  bookmarkTarget,
  spaceTarget,
  tabTarget,
  windowTarget,
  type EffectFence,
  type TargetKey,
} from './modelGuards';
import {
  canCloseOtherTab,
  closeOtherTabsConditionally,
  closeTabOrWindow,
  focusTabInWindow,
  moveTabsPreservingActive,
  tabById,
} from './tabs';
import { searchWithDefaultEngine } from './browserSearch';
import {
  placementsChanged,
  restorePlacements,
  snapshotPlacements,
  undoMessageText,
  undoSeries,
} from './bookmarkUndo';
import { closedTabsSeries, closedTabsText, isBlankTab, reopenClosedTabs, snapshotClosingTabs } from './closedTabsUndo';
import { moveSessionTab } from './sessionTabs';
import type { SpaceTabRestore } from './spaceTabRestore';
import { loadTabOwnerships, type TabOwnership } from './tabOwnership';
import type { TimedMessages } from './timedMessages';

type TabIntentKind = Extract<HyperActionKind,
  | 'activateTab'
  | 'closeTabs'
  | 'createTab'
  | 'deleteHistory'
  | 'moveSessionTab'
  | 'moveTabs'
  | 'moveTabToWindow'
  | 'navigateTab'
  | 'forgetSearchSelection'
  | 'recordSearchSelection'
  | 'setTabGroup'
  | 'setTabMuted'
>;

export interface TabIntentHandlerDependencies {
  activateRemoteTab(
    payload: RemoteTabOperationPayload,
    client: { clientId: string; role: string; windowId: number },
    effects: EffectFence,
  ): Promise<void>;
  /** Takes where tabs now sit in the tab strip into the list, as the model then orders the strip. */
  adoptTabPositions(tabIds: readonly number[]): Promise<void>;
  closeTabs(tabIds: number[]): Promise<void>;
  closeTabsInSpace(
    payload: RemoteTabOperationPayload,
    client: { clientId: string; role: string; windowId: number },
    effects: EffectFence,
  ): Promise<void>;
  deleteHistory(url: string): Promise<void>;
  /** Tells the attach listener that the move bringing this tab to the window places it. */
  expectAttachment(tabId: number, windowId: number): void;
  getTabOwnership(tabId: number): Promise<TabOwnership | undefined>;
  markIntentionalTab(tabId: number): void;
  messages: Pick<TimedMessages, 'offer'>;
  moveRemoteTabToWindow(
    payload: RemoteTabOperationPayload,
    client: { clientId: string; role: string; windowId: number },
    effects: EffectFence,
  ): Promise<void>;
  moveTabTreeNodes(
    spaceId: string,
    nodeIds: readonly string[],
    destination: { index?: number; parentId: string },
  ): Promise<void>;
  /** Opens beside the current tab even when the page is already open, as a modified click does. */
  openNewTab(url: string, windowId: number): Promise<void>;
  queueMutation<Result>(operation: () => Promise<Result>): Promise<Result>;
  forgetSearchSelection(resultId: string): Promise<void>;
  recordSearchSelection(query: string, resultId: string): Promise<void>;
  /** A split's tabs share a group, so one leaving for another space leaves the split first. */
  releaseSplitViews(tabIds: readonly number[]): Promise<void>;
  /** Reopens a space's tabs whose backings no live tab claims, as undoing a close needs. */
  restoreSpaceTabs: SpaceTabRestore;
  routeTab(tabId: number, fallbackSpaceId?: string): Promise<void>;
  /** The tabs in a drag another window's sidebar shared, for this window to take. */
  sharedDragTabIds(token: string, windowId: number): readonly number[] | undefined;
  /** Takes the window to the space a tab belongs to before showing it, so focusing it is one choice. */
  tabSpaceSwitch?: {
    admit(tabId: number, client: { role: string; windowId: number }): void;
    run(tabId: number, client: { role: string; windowId: number }): Promise<void>;
  };
}

function targetTabId(tabId: number | undefined, client: { tabId?: number }): number {
  const resolved = tabId ?? client.tabId;
  if (resolved === undefined) throw new Error('The target tab is unavailable.');
  return resolved;
}

function newTabPageReplacedBy(
  tabId: number,
  client: { role: string; tabId?: number },
): number | undefined {
  return client.role === 'newtab' && client.tabId !== undefined && client.tabId !== tabId
    ? client.tabId
    : undefined;
}

function remoteTabTargets(
  payload: RemoteTabOperationPayload,
  client: { windowId: number },
): readonly TargetKey[] {
  return [
    ...(payload.source.kind === 'tab' ? [tabTarget(payload.source.tabId)] : [
      `bookmark:${payload.source.bookmarkId}` as const,
    ]),
    spaceTarget(payload.spaceId),
    windowTarget(client.windowId),
  ];
}

function requireEffectFence(effects: EffectFence | undefined): EffectFence {
  if (!effects) throw new Error('A remote tab operation requires the model effect lane.');
  return effects;
}

/**
 * Worker-local tab routing stays injected so all browser effects enter through
 * the same intent handler and serial mutation lane.
 */
export function createTabIntentHandlers(
  dependencies: TabIntentHandlerDependencies,
): Pick<HyperIntentHandlers, TabIntentKind> {
  /** A tab's place in the Tabs list is its backing's, so undoing a move puts the backings back. */
  const snapshotTabTreeMove = async (tabIds: readonly number[]) => {
    const backingIds = (await Promise.all(tabIds.map(dependencies.getTabOwnership)))
      .flatMap((ownership) => ownership?.backingId ? [ownership.backingId] : []);
    if (backingIds.length === 0) return undefined;
    const backings = await existingBookmarks(backingIds);
    return { backings, placements: await snapshotPlacements(backingIds) };
  };
  const offerUndoTabTreeMove = async (
    windowId: number,
    { backings, placements }: NonNullable<Awaited<ReturnType<typeof snapshotTabTreeMove>>>,
  ) => {
    if (!(await placementsChanged(placements))) return;
    dependencies.messages.offer(windowId, {
      act: (remade) => dependencies.queueMutation(() => restorePlacements(placements, remade)),
      kind: 'undo',
      series: undoSeries('moved-tabs', 'Moved', backings),
      ...undoMessageText('Moved', backings, { folder: 'folder', leaf: 'tab' }),
    });
  };
  /**
   * Closes tabs and offers to undo it, naming the folder when the user closed
   * one. Only the tabs that pass `closes` are recorded, as only they close.
   */
  const closeWithUndo = async (
    tabIds: readonly number[],
    windowId: number,
    close: () => Promise<void>,
    { closes = () => true, folderTitle }: { closes?: (tab: Browser.tabs.Tab) => boolean; folderTitle?: string } = {},
  ) => {
    const tabs = (await Promise.all([...new Set(tabIds)].map(tabById)))
      .filter((tab): tab is Browser.tabs.Tab => tab !== undefined && closes(tab));
    const ownerships = await loadTabOwnerships(tabs);
    const closed = await snapshotClosingTabs(tabs, ownerships);
    await close();
    const backed = new Set(closed.flatMap((group) => [...group.backingIds]));
    const pages = tabs.filter((tab) =>
      !isBlankTab(tab) && backed.has(ownerships[tab.id as number]?.backingId ?? ''));
    if (pages.length === 0) return;
    dependencies.messages.offer(windowId, {
      act: (remade) => dependencies.queueMutation(async () => {
        for (const group of closed) {
          const { shownTabId } = await reopenClosedTabs(group, dependencies, remade);
          if (shownTabId !== undefined) await browser.tabs.update(shownTabId, { active: true });
        }
      }),
      kind: 'undo',
      series: closedTabsSeries(pages.map((tab) => ownerships[tab.id as number]!.backingId!)),
      ...closedTabsText(pages, folderTitle),
    });
  };
  // A sidebar takes a drag shared from another window only into its own window.
  const movedTabIds = (payload: MoveTabsPayload, client: { windowId: number }): readonly number[] => {
    if ('tabIds' in payload) return payload.tabIds;
    const tabIds = payload.windowId === client.windowId
      ? dependencies.sharedDragTabIds(payload.sharedDrag, client.windowId)
      : undefined;
    if (!tabIds?.length) throw new Error('That drag holds no tabs this window can take.');
    return tabIds;
  };
  // A tab Hyper opens joins the window's space before it is handed back.
  const openRoutedTab = async (windowId: number) => {
    const tab = await browser.tabs.create({ active: true, windowId });
    try {
      if (tab.id === undefined) return tab;
      dependencies.markIntentionalTab(tab.id);
      await dependencies.routeTab(tab.id);
      return await browser.tabs.get(tab.id).catch(() => tab);
    } catch (error) {
      if (tab.id !== undefined) await browser.tabs.remove(tab.id).catch(() => undefined);
      throw error;
    }
  };
  return {
    activateTab: intentHandler({
      admit: (payload, client) => {
        if (payload.operation === 'local') dependencies.tabSpaceSwitch?.admit(payload.tabId, client);
      },
      parse: parseActivateTabPayload,
      run: async (payload, client, effects) => {
        if (payload.operation === 'remote') {
          if (client.role !== 'sidebar') throw new Error('Only the sidebar can activate remote tabs.');
          await dependencies.activateRemoteTab(
            { source: payload.source, spaceId: payload.spaceId },
            client,
            requireEffectFence(effects),
          );
          return;
        }
        const tab = await browser.tabs.get(payload.tabId);
        if (tab.windowId !== client.windowId || tab.incognito) {
          throw new Error('The tab is not visible in this client window.');
        }
        await dependencies.tabSpaceSwitch?.run(payload.tabId, client);
        await focusTabInWindow(payload.tabId, client.windowId, client.windowId);
        // A new tab page that hands the user to an open tab has done its job.
        const replacedTabId = newTabPageReplacedBy(payload.tabId, client);
        if (replacedTabId !== undefined) {
          await dependencies.queueMutation(() => closeTabOrWindow(replacedTabId, client.windowId));
        }
      },
      targets: (payload, client) => payload.operation === 'remote'
        ? remoteTabTargets(payload, client)
        : [
          tabTarget(payload.tabId),
          windowTarget(client.windowId),
          ...[newTabPageReplacedBy(payload.tabId, client)].flatMap(
            (tabId) => tabId === undefined ? [] : [tabTarget(tabId)],
          ),
        ],
    }),
    closeTabs: intentHandler({
      parse: parseCloseTabsPayload,
      run: async (payload, client, effects) => {
        if (payload.condition === 'page-in-space') {
          const fence = requireEffectFence(effects);
          return dependencies.queueMutation(() => dependencies.closeTabsInSpace(payload, client, fence));
        }
        return dependencies.queueMutation(() => payload.condition === 'other-unpinned'
          ? closeWithUndo(
            payload.tabIds,
            client.windowId,
            () => closeOtherTabsConditionally(payload.tabIds, payload, (tabId) => browser.tabs.get(tabId), closeTabOrWindow),
            { closes: (tab) => canCloseOtherTab(tab, payload) },
          )
          : closeWithUndo(
            payload.tabIds,
            client.windowId,
            () => dependencies.closeTabs([...payload.tabIds]),
            payload.folderTitle === undefined ? {} : { folderTitle: payload.folderTitle },
          ));
      },
      targets: (payload, client) => {
        if (payload.condition === 'page-in-space') return remoteTabTargets(payload, client);
        return [
          ...payload.tabIds.map(tabTarget),
          ...(payload.condition === 'other-unpinned'
            ? [tabTarget(payload.keepTabId), windowTarget(payload.windowId)]
            : []),
        ];
      },
    }),
    createTab: intentHandler({
      parse: parseCreateTabPayload,
      run: (_payload, client) => dependencies.queueMutation(() => openRoutedTab(client.windowId)),
      targets: (_payload, client) => [windowTarget(client.windowId)],
    }),
    deleteHistory: intentHandler({
      parse: parseDeleteHistoryPayload,
      run: ({ url }) => dependencies.deleteHistory(url),
      targets: () => [],
    }),
    moveTabToWindow: intentHandler({
      parse: parseMoveTabToWindowPayload,
      run: async (payload, client, effects) => {
        if (client.role !== 'sidebar') throw new Error('Only the sidebar can move remote tabs.');
        const fence = requireEffectFence(effects);
        // Queued with tab routing, which also claims backings and records ownership.
        await dependencies.queueMutation(() => dependencies.moveRemoteTabToWindow(payload, client, fence));
      },
      targets: remoteTabTargets,
    }),
    moveSessionTab: intentHandler({
      parse: parseMoveSessionTabItems,
      run: (moves, client) => dependencies.queueMutation(() => runEachItem(
        moves,
        (move) => moveSessionTab(move, client.windowId, dependencies),
      )),
      targets: (moves, client) => moves.items.flatMap((move) => [
        'tabId' in move.source ? tabTarget(move.source.tabId) : bookmarkTarget(move.source.backingId),
        ...('tree' in move.destination
          ? [spaceTarget(move.destination.tree.spaceId), windowTarget(client.windowId)]
          : 'bookmarks' in move.destination
            ? [bookmarkTarget(move.destination.bookmarks.parentId)]
            : []),
      ]),
    }),
    moveTabs: intentHandler({
      parse: parseMoveTabsPayload,
      run: (payload, client, effects) => dependencies.queueMutation(async () => {
        const { index, tree, windowId } = payload;
        const requestedTabIds = movedTabIds(payload, client);
        await dependencies.releaseSplitViews(requestedTabIds);
        // A tab closed since the drag began is left out, rather than failing the whole move.
        const tabsBefore = (await Promise.all(requestedTabIds.map((tabId) =>
          tabById(tabId)))).flatMap((tab) => tab ? [tab] : []);
        const tabIds = tabsBefore.flatMap((tab) => tab.id === undefined ? [] : [tab.id]);
        if (tabIds.length === 0) return;
        if (tree) {
          for (const tab of tabsBefore) {
            if (tab.id !== undefined && tab.windowId !== windowId) dependencies.expectAttachment(tab.id, windowId);
          }
        }
        const undo = tabsBefore.every((tab) => tab.windowId === windowId)
          ? await snapshotTabTreeMove(tabIds)
          : undefined;
        await moveTabsPreservingActive([...tabIds], windowId, index, undefined, undefined, effects);
        // Tabs brought from another window join the space they were dropped in, where they were dropped.
        if (tree) for (const tabId of tabIds) await dependencies.routeTab(tabId, tree.spaceId);
        // With no place in the tree, the tab strip position becomes the list's, or the strip would spring back.
        if (tree?.parentId === undefined) {
          await dependencies.adoptTabPositions([...tabIds]);
        } else {
          const backingIds = (await Promise.all(tabIds.map(dependencies.getTabOwnership))).flatMap((ownership) =>
            ownership?.spaceId === tree.spaceId && ownership.backingId ? [ownership.backingId] : []);
          if (backingIds.length > 0) {
            await dependencies.moveTabTreeNodes(tree.spaceId, backingIds, {
              parentId: tree.parentId,
              ...(tree.index === undefined ? {} : { index: tree.index }),
            });
          }
        }
        if (undo) await offerUndoTabTreeMove(client.windowId, undo);
      }),
      targets: (payload, client) => [
        ...movedTabIds(payload, client).map(tabTarget),
        windowTarget(payload.windowId),
        ...(payload.tree ? [spaceTarget(payload.tree.spaceId)] : []),
      ],
    }),
    navigateTab: intentHandler({
      parse: parseNavigateTabPayload,
      run: async (payload, client) => {
        if (payload.kind === 'search' && payload.newTab) {
          await dependencies.queueMutation(async () => {
            const tab = await openRoutedTab(client.windowId);
            if (tab.id === undefined) throw new Error('A search tab could not be created.');
            try {
              await searchWithDefaultEngine(payload.query, tab.id);
            } catch (error) {
              await browser.tabs.remove(tab.id).catch(() => undefined);
              throw error;
            }
          });
          return;
        }
        if (payload.kind === 'url' && payload.newTab) {
          await dependencies.queueMutation(() => dependencies.openNewTab(payload.url, client.windowId));
          return;
        }
        // Like the address bar, sending a tab elsewhere never waits behind Hyper's upkeep.
        const tabId = targetTabId(payload.tabId, client);
        if (payload.kind === 'search') {
          await searchWithDefaultEngine(payload.query, tabId);
          return;
        }
        await browser.tabs.update(tabId, { url: payload.url });
        await dependencies.queueMutation(() => dependencies.routeTab(tabId));
      },
      targets: (payload, client) => payload.newTab
        ? [windowTarget(client.windowId)]
        : [tabTarget(targetTabId(payload.tabId, client)), windowTarget(client.windowId)],
    }),
    forgetSearchSelection: intentHandler({
      parse: parseForgetSearchSelectionPayload,
      run: ({ resultId }) => dependencies.forgetSearchSelection(resultId),
      targets: () => [],
    }),
    recordSearchSelection: intentHandler({
      parse: parseRecordSearchSelectionPayload,
      run: ({ query, resultId }) => dependencies.recordSearchSelection(query, resultId),
      targets: () => [],
    }),
    setTabGroup: intentHandler({
      parse: parseSetTabGroupPayload,
      run: (payload, client) => dependencies.queueMutation(async () => {
        const groupableTabIds = new Set((await browser.tabs.query({ windowId: client.windowId }))
          .flatMap((tab) => tab.id === undefined || tab.pinned ? [] : [tab.id]));
        const tabIds = [...new Set(payload.tabIds)].filter((tabId) => groupableTabIds.has(tabId));
        await dependencies.releaseSplitViews(tabIds);
        for (const tabId of tabIds) await dependencies.routeTab(tabId, payload.spaceId);
      }),
      targets: (payload, client) => [
        ...payload.tabIds.map(tabTarget),
        spaceTarget(payload.spaceId),
        windowTarget(client.windowId),
      ],
    }),
    setTabMuted: intentHandler({
      parse: parseSetTabMutedPayload,
      run: async ({ muted, tabId }, client) => {
        const tab = await browser.tabs.get(tabId);
        if (tab.windowId !== client.windowId || tab.incognito) {
          throw new Error('The tab is not visible in this client window.');
        }
        await browser.tabs.update(tabId, { muted });
      },
      targets: ({ tabId }) => [tabTarget(tabId)],
    }),
  };
}