import { useEffect, useRef, useState } from 'react';
import { createSerialAsyncRunner } from '../../lib/async';
import {
  activateTabOptimistically,
  moveTabsOptimistically,
  removeBookmarkOptimistically,
  removeTabsOptimistically,
  updateBookmarkOptimistically,
} from '../lib/backingOperations';
import {
  bookmarkTitleWithCustomName,
  deriveSpaces, findBookmarkNode, shownSpaces,
  MAX_FAVOURITES,
  parseBookmarkTitle,
  serializeBookmarkTitle,
  type BookmarkNode,
  type BrowserTab,
} from '../../lib/bookmarks';
import { pageIdentity } from '../../lib/urlIdentity';
import type { HyperPreferences } from '../../lib/preferences';
import type { TabReuseScope } from '../../lib/tabs';
import {
  emptyProjectedBrowserState,
  projectBrowserState,
  type ProjectedBrowserState,
} from '../lib/projectionState';
import { createLatestSpaceSelector } from '../lib/spaceActivation';
import { reportBuildMismatch } from '../lib/buildMismatch';
import { createHyperModelClient, INTENT_DROPPED, modelClientSearch, type HyperModelClient } from '../../lib/modelClient';
import { preserveIdentity } from '../../lib/modelIdentity';
import type { HyperSidebarProjection } from '../../lib/modelPort';
import type {
  CommandSettlementOutcome,
  CommandStatus,
  HyperActionKind,
} from '../../lib/modelActions';
import { createOverlayStore } from '../../lib/modelOverlay';
import {
  asBookmarkNode,
  asBrowserTab,
  createBookmarkCreationSubmitters,
  createBookmarkEditSubmitters,
  createBrowserFeatureIntentSubmitters,
  createBrowserCommandSubmitter,
  createCrossWindowIntentSubmitters,
  createSettledIntentSubmitter,
  required,
  createSpaceIntentSubmitters,
  createSpaceSelectionAdmitter,
  createSplitViewIntentSubmitter,
  createTabFolderIntentSubmitters,
  searchSelectionIntents,
  timedMessageIntents,
} from '../lib/intentSubmission';
import { createCommandSettlementTracker } from '../lib/commandSettlement';
import { createPendingOperationGauge } from '../lib/pendingOperations';
import { resolveActiveSpaceHold } from '../lib/activeSpaceHold';

interface BrowserState extends Omit<
  ProjectedBrowserState,
  'currentWindowId' | 'currentWindowIncognito'
> {
  activeGroupId: number | null;
  currentWindowId: number | null;
  currentWindowIncognito: boolean | null;
  pendingBackingOperations: number;
  bookmarkImportInProgress: boolean;
  isLoading: boolean;
  error: string | null;
}

const initialState: BrowserState = {
  ...emptyProjectedBrowserState,
  activeGroupId: null,
  currentWindowId: null,
  currentWindowIncognito: null,
  pendingBackingOperations: 0,
  isLoading: true,
  error: null,
};

export function useBrowserState() {
  const [state, setState] = useState(initialState);
  // The space the view is switching to, held until the model reports it. The
  // model keeps naming the space being left until activation takes effect, so
  // without this the projection would drag the view back mid-switch.
  const pendingActiveSpaceIdRef = useRef<string | null>(null);
  const deletingSpaceRef = useRef(false);
  const runSpaceActivation = useRef(createSerialAsyncRunner()).current;
  const spaceActivationVersion = useRef(0);
  const modelClient = useRef<HyperModelClient | undefined>(undefined);
  const search = useRef(modelClientSearch(modelClient)).current;
  const lastProjection = useRef<HyperSidebarProjection | undefined>(undefined);
  const settlement = useRef(createCommandSettlementTracker()).current;
  const overlays = useRef(createOverlayStore<BrowserState>());

  /**
   * A dropped connection leaves a command's fate unknown, so its caller is told
   * only that the change was not seen through. The model stays authoritative for
   * what actually happened.
   */
  const releaseSettlementWaiters = () => {
    settlement.releaseAll();
    // A dropped port settles nothing, so an edit waiting on a command has no
    // remaining way to be proved. The model is the only account left.
    overlays.current.discardPendingCommands();
  };

  const recordCommandStatuses = (statuses: readonly CommandStatus[]) =>
    settlement.record(statuses);

  /**
   * Rebuilds view state from the last committed projection with the still
   * pending edits laid over it. Re-deriving from the projection each time is
   * what keeps an optimistic edit from outliving the change that justified it.
   */
  const reproject = () => {
    const projection = lastProjection.current;
    // Revision zero is the model before it has read the browser; adopting it
    // would blank the view rather than describe it.
    if (!projection || projection.revision === 0) return;
    const projected = projectBrowserState(projection);
    // A space the view has just switched to shows until the model reports it,
    // because until then the model still holds the space being left.
    const hold = resolveActiveSpaceHold(pendingActiveSpaceIdRef.current, projected.activeSpaceId);
    pendingActiveSpaceIdRef.current = hold.pendingActiveSpaceId;
    // The active group is the active space's group in this projection and nowhere else.
    const activeGroupId = hold.activeSpaceId === null
      ? null
      : projected.spaceGroupIds[hold.activeSpaceId] ?? null;
    setState((current) => preserveIdentity(current, overlays.current.project(
      {
        ...current,
        ...projected,
        activeGroupId,
        activeSpaceId: hold.activeSpaceId,
      },
      settlement.statuses(),
    )));
  };

  /**
   * The sidebar draws its bookmarks from the model, so it stays in its loading
   * state until the opening commit arrives. Revision zero is the model before
   * it has read the browser, and rendering it would show an empty profile.
   */
  const settleLoading = () => {
    const projection = lastProjection.current;
    if (
      !projection ||
      projection.revision === 0 ||
      projection.bookmarkImportInProgress
    ) return;
    setState((current) => (
      current.isLoading ? { ...current, error: null, isLoading: false } : current
    ));
  };

  const backingOperations = useRef(createPendingOperationGauge((count) =>
    setState((current) => ({ ...current, pendingBackingOperations: count })),
  )).current;

  const runBackingOperation = backingOperations.track;

  useEffect(() => {
    let disposed = false;
    const start = async () => {
      const windowId = await browser.windows?.getCurrent()
        .then((window) => window.id)
        .catch(() => undefined);
      if (disposed || windowId === undefined) return;
      modelClient.current = createHyperModelClient<HyperSidebarProjection>({
        onBuildMismatch: reportBuildMismatch,
        onCommandStatuses: (statuses) => {
          recordCommandStatuses(statuses);
          reproject();
        },
        onConnectionChange: (connection) => {
          if (connection !== 'connected') releaseSettlementWaiters();
        },
        onProjection: (projection) => {
          lastProjection.current = projection;
          recordCommandStatuses(projection.commands);
          reproject();
          settleLoading();
        },
        role: 'sidebar',
        windowId,
      });
    };
    void start();
    return () => {
      disposed = true;
      releaseSettlementWaiters();
      modelClient.current?.dispose();
      modelClient.current = undefined;
    };
  }, []);

  /**
   * Sends a change as an intent and shows it immediately.
   *
   * The optimistic edit is held against the command that carries it rather than
   * written into state, so the background stays authoritative: the edit is
   * dropped by the commit that settles the command, or at once if the intent was
   * never admitted.
   *
   * Acceptance only says the command was admitted, so a caller that sequences
   * further work behind this one waits for the command to settle instead. A
   * caller that consumes what the effect created reads `result`, which arrives
   * on the same revision as the tree that contains it.
   */
  const submitIntentForOutcome = async (
    kind: HyperActionKind,
    payload: unknown,
    optimistic?: (current: BrowserState) => BrowserState,
    options: { awaitSettlement?: boolean } = {},
  ): Promise<CommandSettlementOutcome> => {
    const client = modelClient.current;
    if (!client) return { succeeded: false };
    const commandId = crypto.randomUUID();
    if (optimistic) {
      overlays.current.add(commandId, optimistic);
      reproject();
    }
    const outcome = await client.submitIntent(kind, payload, commandId);
    if (outcome.status === 'rejected') {
      overlays.current.discard(commandId);
      reproject();
      return { dropped: outcome.reason === INTENT_DROPPED, succeeded: false };
    }
    // From here the command exists in the model, so its absence from a status
    // table means it has settled rather than that it has not arrived.
    overlays.current.admit(commandId);
    return options.awaitSettlement ? await settlement.waitFor(commandId) : { succeeded: true };
  };

  const submitIntent = async (
    kind: HyperActionKind,
    payload: unknown,
    optimistic?: (current: BrowserState) => BrowserState,
    options: { awaitSettlement?: boolean } = {},
  ): Promise<boolean> =>
    (await submitIntentForOutcome(kind, payload, optimistic, options)).succeeded;

  const requireSettledIntent = createSettledIntentSubmitter(submitIntent);

  /** Waits for the effect and returns what it created, or undefined if it failed. */
  const submitIntentForResult = async <Result>(
    kind: HyperActionKind,
    payload: unknown,
    parse: (result: unknown) => Result | undefined,
  ): Promise<Result | undefined> => {
    const outcome = await submitIntentForOutcome(kind, payload, undefined, {
      awaitSettlement: true,
    });
    return outcome.succeeded ? parse(outcome.result) : undefined;
  };

  const setFavouriteSlot = async (id: string, slotIndex: number) => {
    if (slotIndex < 0 || slotIndex >= MAX_FAVOURITES) return;
    await requireSettledIntent('setFavourite', { bookmarkId: id, slotIndex }, 'This favourite could not be set.');
  };

  const setActiveSpaceId = createLatestSpaceSelector({
    admitSpaceSelection: createSpaceSelectionAdmitter(() => modelClient.current, settlement),
    deletingSpaceRef,
    pendingActiveSpaceIdRef,
    reproject,
    runSpaceActivation,
    spaceActivationVersion,
  });

  const { copyBookmark, moveBookmark, moveBookmarkStep: moveBookmarkByOffset, submitSelection } =
    createBookmarkEditSubmitters(submitIntentForOutcome);

  const { addCurrentPage, addTabBookmark, createFolder } =
    createBookmarkCreationSubmitters(submitIntentForResult);

  const groupTabsInSpace = async (tabIds: number[], spaceId: string) => {
    if (tabIds.length === 0) return;
    if (!deriveSpaces(state.bookmarkTree).some((space) => space.id === spaceId && !space.archived)) return;
    await runBackingOperation(() =>
      requireSettledIntent('setTabGroup', { spaceId, tabIds }, 'These tabs could not be grouped.'));
  };

  const focusTab = async (tab: BrowserTab) => {
    if (tab.id === undefined) return;
    const tabId = tab.id;
    const activationVersion = spaceActivationVersion.current;
    await runSpaceActivation(async () => {
      if (activationVersion !== spaceActivationVersion.current) return;
      await runBackingOperation(async () => {
        const activate = () => submitIntentForOutcome('activateTab', { tabId }, (current) => ({
          ...current,
          tabs: activateTabOptimistically(current.tabs, tabId),
        }), { awaitSettlement: true });
        // A drop leaves the activation's fate unknown, and activating twice is harmless.
        const first = await activate();
        const outcome = first.dropped ? await activate() : first;
        if (!outcome.succeeded) throw new Error('This tab could not be focused.');
      });
    });
  };

  const navigateTab = (tabId: number, target: string | { kind: 'search'; query: string }) => requireSettledIntent(
    'navigateTab',
    typeof target === 'string' ? { kind: 'url' as const, tabId, url: target } : { ...target, tabId },
    'This tab could not be navigated.',
  );

  const closeTab = async (tabId: number) => {
    await closeTabs([tabId]);
  };

  const closeTabs = async (tabIds: readonly number[], folderTitle?: string) => {
    const uniqueTabIds = [...new Set(tabIds)];
    const selectedIds = new Set(uniqueTabIds);
    if (!state.tabs.some((tab) => tab.id !== undefined && selectedIds.has(tab.id))) return;
    await runBackingOperation(() => requireSettledIntent(
      'closeTabs',
      { tabIds: uniqueTabIds, ...(folderTitle === undefined ? {} : { folderTitle }) },
      'These tabs could not be closed.',
      (current) => ({ ...current, tabs: removeTabsOptimistically(current.tabs, uniqueTabIds) }),
    ));
  };

  const reloadTabs = async (tabIds: readonly number[]) => {
    const uniqueTabIds = [...new Set(tabIds)];
    if (uniqueTabIds.length === 0) return;
    await requireSettledIntent(
      'reloadTab',
      { items: uniqueTabIds.map((tabId) => ({ tabId })) },
      'These tabs could not be reloaded.',
    );
  };

  const createTab = async () =>
    required(await submitIntentForResult<BrowserTab>('createTab', {}, asBrowserTab), 'A new tab could not be created.');

  const setTabMuted = (tabId: number, muted: boolean) =>
    requireSettledIntent('setTabMuted', { muted, tabId }, `This tab could not be ${muted ? 'muted' : 'unmuted'}.`);

  const searchInNewTab = (query: string) => requireSettledIntent(
    'navigateTab',
    { kind: 'search', newTab: true, query },
    'That search could not be opened.',
  );

  const deleteHistory = (url: string) => requireSettledIntent('deleteHistory', { url }, 'That history entry could not be deleted.');

  const moveTab = async (tabId: number, windowId: number, index: number) => {
    await moveTabs([tabId], windowId, index);
  };

  const moveTabs = async (tabIds: number[], windowId: number, index: number) => {
    if (tabIds.length === 0) return;
    await runBackingOperation(() => requireSettledIntent(
      'moveTabs',
      { index, tabIds, windowId },
      'These tabs could not be moved.',
      (current) => ({ ...current, tabs: moveTabsOptimistically(current.tabs, tabIds, windowId, index) }),
    ));
  };

  const { setTabMediaPlayback } =
    createBrowserFeatureIntentSubmitters(requireSettledIntent);

  const updateBookmark = async (id: string, title: string, url?: string) => {
    const optimisticNode = findBookmarkNode(state.bookmarkTree, id);
    await requireSettledIntent(
      'renameBookmark',
      { bookmarkId: id, title, ...(url ? { url } : {}) },
      'This bookmark could not be renamed.',
      optimisticNode
        ? (current) => ({
          ...current,
          bookmarkTree: updateBookmarkOptimistically(current.bookmarkTree, id, {
            // A blank name waits for the page title the background finds, if any.
            title: !title.trim()
              ? optimisticNode.title
              : optimisticNode.url
                ? bookmarkTitleWithCustomName(optimisticNode, title)
                : serializeBookmarkTitle(title, parseBookmarkTitle(optimisticNode.title).metadata),
            ...(optimisticNode.url && url ? { url } : {}),
          }),
        })
        : undefined,
    );
  };

  const updateBookmarkUrl = async (id: string, url: string) => {
    const optimisticNode = findBookmarkNode(state.bookmarkTree, id);
    await runBackingOperation(() => requireSettledIntent(
      'updateBookmarkUrl',
      { bookmarkId: id, url },
      'This bookmark URL could not be updated.',
      optimisticNode?.url
        ? (current) => ({
          ...current,
          bookmarkTree: updateBookmarkOptimistically(current.bookmarkTree, id, {
            title: optimisticNode.title,
            url,
          }),
        })
        : undefined,
    ));
  };

  const removeSpace = async (
    spaceId: string,
    choice: { expectedProvisionalTitle?: string; moveBookmarks?: boolean },
  ) => {
    if (deletingSpaceRef.current) {
      throw new Error('A space is already being deleted.');
    }
    const spaces = deriveSpaces(state.bookmarkTree);
    const space = spaces.find((candidate) => candidate.id === spaceId);
    if (!space) return;
    if (spaces.length <= 1 || !space.archived && shownSpaces(spaces).length <= 1) throw new Error('At least one space is required.');
    // A space that no longer exists cannot be the one the view is switching to.
    if (pendingActiveSpaceIdRef.current === spaceId) {
      pendingActiveSpaceIdRef.current = null;
    }
    deletingSpaceRef.current = true;
    ++spaceActivationVersion.current;
    try {
      await requireSettledIntent('deleteSpace', { ...choice, spaceId }, 'This space could not be deleted.');
    } finally {
      deletingSpaceRef.current = false;
    }
  };

  const removeBookmark = async (
    node: Pick<BookmarkNode, 'id' | 'parentId' | 'url'>,
    options: {
      expectedProvisionalTitle?: string;
      isSpace?: boolean;
      moveBookmarks?: boolean;
      unpin?: boolean;
    } = {},
  ) => {
    if (options.isSpace || node.parentId === state.spacesFolderId) {
      await runBackingOperation(() => removeSpace(node.id, {
        expectedProvisionalTitle: options.expectedProvisionalTitle,
        moveBookmarks: options.moveBookmarks,
      }));
      return;
    }
    const expectedProvisionalTitle = options.expectedProvisionalTitle;
    await requireSettledIntent(
      'deleteBookmark',
      {
        bookmarkId: node.id,
        ...(expectedProvisionalTitle === undefined ? {} : { expectedProvisionalTitle }),
        ...(options.unpin ? { unpin: true } : {}),
      },
      'This bookmark could not be deleted.',
      expectedProvisionalTitle === undefined ? (current) => ({
        ...current,
        bookmarkTree: removeBookmarkOptimistically(current.bookmarkTree, node.id),
      }) : undefined,
    );
  };

  const openBookmark = async (
    url: string,
    options: {
      activate?: boolean;
      destinationSpaceId?: string | null;
      forceNew?: boolean;
      reuse?: TabReuseScope;
    } = {},
  ) => {
    if (!pageIdentity(url)) return;
    const destinationSpaceId = options.destinationSpaceId === undefined ? state.activeSpaceId : options.destinationSpaceId;
    return required(await submitIntentForResult<BrowserTab>('openBookmark', {
      active: options.activate ?? true,
      ...(destinationSpaceId ? { destinationSpaceId } : {}),
      forceNew: options.forceNew ?? false,
      reuse: options.reuse ?? 'browser',
      url,
    }, asBrowserTab), 'The tab could not be opened.');
  };

  const openFavourite = async (url: string, forceNew = false) => required(
    await submitIntentForResult<BrowserTab>('openFavourite', {
      ...(state.activeSpaceId ? { activeSpaceId: state.activeSpaceId } : {}),
      forceNew,
      url,
    }, asBrowserTab),
    'The favourite could not be opened.',
  );

  const duplicateTab = async (tab: BrowserTab) => {
    if (tab.id === undefined) throw new Error('This tab is no longer available.');
    const succeeded = await submitIntent('duplicateTab', { tabId: tab.id });
    if (!succeeded) throw new Error('This tab could not be duplicated.');
  };

  const renameTab = async (tab: BrowserTab, title: string) => {
    if (tab.id === undefined) throw new Error('This tab is no longer available.');
    const tabId = tab.id;
    const backingId = state.tabBackingIds[tabId];
    if (!backingId) throw new Error('This tab does not have a renameable backing.');
    const backing = title.trim() ? findBookmarkNode(state.bookmarkTree, backingId) : undefined;
    await runBackingOperation(() => requireSettledIntent(
      'renameTab',
      { backingId, tabId, title },
      'This tab could not be renamed.',
      backing
        ? (current) => ({
          ...current,
          bookmarkTree: updateBookmarkOptimistically(current.bookmarkTree, backingId, {
            title: bookmarkTitleWithCustomName(backing, title),
          }),
        })
        : undefined,
    ));
  };

  const { createTabFolder, moveTabTreeNode, removeTabFolder, renameTabFolder } =
    createTabFolderIntentSubmitters(submitIntent, submitIntentForResult);

  const trackBackingOperation = <Args extends unknown[], Result>(
    operation: (...args: Args) => Promise<Result>,
  ) => (...args: Args): Promise<Result> => runBackingOperation(
    () => operation(...args),
  );

  const importExternalBookmarkFolder = async (sourceFolderId: string, destinationParentId: string) => required(
    await submitIntentForResult<BookmarkNode>('importBookmarkFolder', { destinationParentId, sourceFolderId }, asBookmarkNode),
    'The bookmark folder could not be imported.',
  );

  const submitBrowserCommand = createBrowserCommandSubmitter(closeTabs, runBackingOperation, requireSettledIntent);

  return {
    ...state,
    isBackingOperationPending: state.pendingBackingOperations > 0 || state.bookmarkImportInProgress,
    runBackingOperation,
    setFavouriteSlot: trackBackingOperation(setFavouriteSlot),
    setActiveSpaceId,
    moveBookmark,
    copyBookmark: trackBackingOperation(copyBookmark),
    importBookmarkFolder: trackBackingOperation(importExternalBookmarkFolder),
    moveBookmarkByOffset,
    addCurrentPage: trackBackingOperation(addCurrentPage),
    createFolder: trackBackingOperation(createFolder),
    createTabFolder: trackBackingOperation(createTabFolder),
    renameTabFolder: trackBackingOperation(renameTabFolder),
    removeTabFolder: trackBackingOperation(removeTabFolder),
    submitSelection: trackBackingOperation(submitSelection),
    moveTabTreeNode: trackBackingOperation(moveTabTreeNode),
    setPreference: <Key extends keyof HyperPreferences>(key: Key, value: HyperPreferences[Key]) => submitIntent('setPreference', { key, value }, (current) => ({ ...current, preferences: { ...current.preferences, [key]: value } })),
    ...createSpaceIntentSubmitters(state.spacesFolderId, runBackingOperation, submitIntentForResult, requireSettledIntent, submitIntentForOutcome),
    addTabBookmark: trackBackingOperation(addTabBookmark),
    groupTabsInSpace: trackBackingOperation(groupTabsInSpace),
    focusTab,
    ...createCrossWindowIntentSubmitters(runBackingOperation, requireSettledIntent),
    ...createSplitViewIntentSubmitter(runBackingOperation, requireSettledIntent),
    navigateTab: trackBackingOperation(navigateTab),
    closeTab,
    closeTabs,
    reloadTabs,
    createTab: trackBackingOperation(createTab),
    searchInNewTab: trackBackingOperation(searchInNewTab),
    setTabMuted: trackBackingOperation(setTabMuted),
    deleteHistory: trackBackingOperation(deleteHistory),
    moveTab,
    moveTabs,
    setTabMediaPlayback,
    search,
    ...searchSelectionIntents(submitIntent),
    updateBookmark,
    updateBookmarkUrl,
    removeBookmark,
    openBookmark: trackBackingOperation(openBookmark),
    openFavourite: trackBackingOperation(openFavourite),
    duplicateTab: trackBackingOperation(duplicateTab),
    ...timedMessageIntents(submitIntent),
    renameTab,
    submitBrowserCommand,
  };
}
