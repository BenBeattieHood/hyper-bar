import { createBookmarkFolderImport } from './lib/bookmarkImport';
import { createBookmarkIntentHandlers } from './lib/bookmarkIntentHandlers';
import { createBrowserCommandIntentHandlers } from './lib/browserCommandIntentHandlers';
import { createSpaceIntentHandlers } from './lib/spaceIntentHandlers';
import { createTabIntentHandlers } from './lib/tabIntentHandlers';
import { createWorkspaceIntentHandlers } from './lib/workspaceIntentHandlers';
import {
  loadPendingBackingCleanupJournal,
  savePendingBackingCleanupJournal,
} from './lib/backingCleanupJournal';
import { createBackingCleanup } from './lib/backingCleanup';
import {
  dissolveSplitViewFolder,
  ensureHyperBookmarkStructure,
  gatherSplitViewFolder,
  hasParkedTabBackings,
  migrateLegacyPreferences,
  moveTabTreeNode,
  moveTabTreeNodes,
  removeTabBackingBookmark,
  type TabBackingLocation,
} from './lib/bookmarkStorage';
import { setFavouriteSlot } from './lib/favouriteStorage';
import { createSpaceGroupColours } from './lib/spaceGroupColours';
import { createSpaceGroupOrder } from './lib/spaceGroupOrder';
import { createSpaceWindowMaintenance } from './lib/spaceWindowMaintenance';
import { createSpaceTabRestore, recoverSpaceTabRestore } from './lib/spaceTabRestore';
import { createWindowSpaceChoice } from './lib/windowSpaceChoice';
import { createTabRouter } from './lib/tabRouter';
import { createNewTabDisposal } from './lib/newTabDisposal';
import { advanceTabGeneration, retainRecentEntries } from './lib/tabs';
import { syncBookmarkTitlesFollowingTab } from './lib/bookmarkTitleSync';
import { newTabShownMessageType, openHyperFromPageMessageType } from './lib/pageShortcut';
import { getTabOwnership, loadTabOwnerships } from './lib/tabOwnership';
import { createCoalescedAsyncRunner, createKeyedCoalescer, createSerialAsyncRunner } from './lib/async';
import { recoverDurableOperations } from './lib/operationJournal';
import {
  commandStatusesAtom,
  hyperModelAtom,
  modelTabTitles,
  setCommandStatusesAtom,
  structureHealthAtom,
} from './lib/model';
import { watchStructureRepair } from './lib/structureRepair';
import { isModelStorageArea } from './lib/modelIngress';
import { forgetClientCommands } from './lib/modelActions';
import { createIntentSubmitter } from './lib/modelIntents';
import { recoverDeletedSpaceOperation } from './lib/spaceDeletion';
import { recoverSpaceDuplication } from './lib/spaceDuplication';
import { createSpaceDeletionBrowserPort } from './lib/spaceDeletionBrowser';
import { createSpaceArchive } from './lib/spaceArchive';
import { createSpaceDeletionController } from './lib/spaceDeletionController';
import { createNavigationDedupe } from './lib/navigationDedupe';
import { createCrossSpaceDuplicates } from './lib/crossSpaceDuplicates';
import {
  bookmarkTarget,
  createTargetLedger,
  tabTarget,
  windowTarget,
} from './lib/modelGuards';
import { startHyperModelPortServer } from './lib/modelPort';
import { rememberActiveTab } from './lib/lastActiveTab';
import { createBackgroundModelRuntime } from './lib/backgroundModelRuntime';
import { createRemoteTabBackgroundController } from './lib/remoteTabBackground';
import { createSplitViewController } from './lib/splitViewController';
import { createTabStripOrderController } from './lib/tabStripOrderController';
import { createSpaceSwitchController } from './lib/spaceSwitch';
import { createBrowserRestoreBarrier } from './lib/browserRestore';
import { createTabBackingSync } from './lib/tabBackingSync';
import { createSpaceGroupExpansion } from './lib/spaceGroupExpansion';
import { createSidebarOpener, enableActionToggle } from './lib/sidebarOpener';
import { createSpaceActivation } from './lib/spaceActivation';
import { createOwnedTabActions } from './lib/ownedTabActions';
import { createStartupTabRecovery } from './lib/startupTabRecovery';
import { createTabNavigationIngress } from './lib/tabNavigationIngress';
export default defineBackground(() => {
  const spaceDeletionBrowser = createSpaceDeletionBrowserPort();
  // Lifecycle bookkeeping outlives the entities it describes, so it is capped
  // well above any plausible live tab or group count.
  const MAX_TRACKED_TAB_LIFECYCLES = 512;
  // Navigation events reach here before a tab query would report them, so the
  // model shows a page as loading from the moment it starts.
  const tabStatuses = new Map<number, 'complete' | 'loading'>();
  let bookmarkImportActiveCount = 0;
  const queueGroupMutation = createSerialAsyncRunner((error) => {
    console.error('Unable to synchronize Hyper browser state.', error);
  });
  const intentionalNewTabIds = new Set<number>();
  const markIntentionalTab = (tabId: number) => void intentionalNewTabIds.add(tabId);
  // Controllers built further down, reached lazily because they depend on one another.
  const closeTabs = (tabIds: number[]) => ownedTabs.closeTabs(tabIds);
  const openTabInSpace: typeof ownedTabs.openTabInSpace = (options) => ownedTabs.openTabInSpace(options);
  const restoreSpaceTabsLater: typeof restoreSpaceTabs = (...args) => restoreSpaceTabs(...args);
  const routeTabToSpace = (tabId: number, spaceId?: string) => routeTabToBookmarkSpace(tabId, false, spaceId);
  const {
    duplicateController, inPageSidebar, mediaController, modelRead, persistTabOwnership,
    persistWindowActiveSpace,
    reconciler: hyperModelReconciler,
    searchController,
    sharedDrag,
    store: hyperModelStore,
    tabBookmarkLinks, tabContentController, timedMessages,
  } = createBackgroundModelRuntime({
    queueMutation: queueGroupMutation,
    readRuntimeSignals: () => ({
      bookmarkImportActiveCount,
      statuses: tabStatuses,
    }),
  });
  let hyperModelReady = false;
  const readModel = () => hyperModelStore.get(hyperModelAtom);
  const browserRestore = createBrowserRestoreBarrier();
  const targetLedger = createTargetLedger();
  const tabBackingLocations = new Map<number, TabBackingLocation>();
  const remoteTabController = createRemoteTabBackgroundController({
    closeTabs,
    persistTabOwnership,
    placeMovedTab: (tabId, spaceId) => void queueGroupMutation(
      () => routeTabToSpace(tabId, spaceId),
    ).catch(() => undefined),
    readSnapshot: readModel,
    tabBackingLocations,
  });
  const splitViews = createSplitViewController({
    browserSettled: browserRestore.settled,
    dissolveSplitViewFolder,
    gatherSplitViewFolder,
    getTabOwnership,
    openTabInSpace,
    queueMutation: queueGroupMutation,
    store: hyperModelStore,
  });
  const tabStripOrder = createTabStripOrderController({
    browserSettled: browserRestore.settled,
    moveTabTreeNode,
    queueMutation: queueGroupMutation,
    store: hyperModelStore,
    targetLedger,
  });
  const scheduleHyperModelReconciliation = () => {
    if (!hyperModelReady) return;
    void hyperModelReconciler.scheduleReconciliation().catch((error) => {
      console.error('Unable to reconcile the Hyper model.', error);
    });
  };
  const tabSpaceSwitch = {
    admit: (tabId: number, client: { role: string; windowId: number }) => windowSpaces.beforeTab(tabId, client).admit(),
    run: (tabId: number, client: { role: string; windowId: number }) =>
      queueGroupMutation(() => windowSpaces.beforeTab(tabId, client).run()),
  };
  const submitHyperIntent = createIntentSubmitter({
    handlers: {
      ...createBookmarkIntentHandlers({
        linkTabToBookmark: (tabId, bookmarkId) => tabBookmarkLinks.link(tabId, bookmarkId),
        messages: timedMessages,
        openTabInSpace,
        queueMutation: queueGroupMutation,
        setFavouriteSlot,
        tabTitles: (tabId, url) => modelTabTitles(readModel(), tabId, url),
        tabsLinkedTo: (bookmarkIds) => tabBookmarkLinks.tabsLinkedTo(bookmarkIds),
        windowSpaces: () => windowSpaces,
      }),
      ...createTabIntentHandlers({
        activateRemoteTab: remoteTabController.activate,
        adoptTabPositions: (tabIds) => tabStripOrder.adoptPositions(tabIds),
        closeTabs,
        closeTabsInSpace: remoteTabController.close,
        deleteHistory: (url) => searchController.deleteHistory(url), forgetSearchSelection: (resultId) => searchController.forgetSelection(resultId), recordSearchSelection: (query, resultId) => searchController.recordSelection(query, resultId),
        expectAttachment: remoteTabController.expectAttachment,
        getTabOwnership,
        markIntentionalTab,
        messages: timedMessages,
        moveRemoteTabToWindow: remoteTabController.move,
        moveTabTreeNodes,
        openNewTab: async (url, windowId) => void await openTabInSpace({
          active: true, forceNew: true, reuse: 'window', url, windowId,
        }),
        queueMutation: queueGroupMutation,
        releaseSplitViews: (tabIds) => splitViews.releaseDeparting(tabIds), restoreSpaceTabs: restoreSpaceTabsLater,
        routeTab: (tabId, fallbackSpaceId) => routeTabToBookmarkSpace(tabId, fallbackSpaceId === undefined, fallbackSpaceId),
        sharedDragTabIds: sharedDrag.tabIds,
        tabSpaceSwitch,
      }),
      ...createBrowserCommandIntentHandlers({
        queueMutation: queueGroupMutation,
      }),
      ...createSpaceIntentHandlers({
        closeTabs,
        markIntentionalTab,
        messages: timedMessages,
        queueMutation: queueGroupMutation,
        restoreSpaceTabs: restoreSpaceTabsLater,
        routeTab: routeTabToSpace,
        setSpaceArchived: (payload) => spaceArchive.setSpaceArchived(payload),
        windowSpaces: () => windowSpaces,
      }),
      ...createWorkspaceIntentHandlers({
        deleteSpace: (payload, windowId) => deleteSpace(payload, windowId),
        duplicateTab: (tabId) => ownedTabs.duplicateOwnedTab(tabId),
        importBookmarkFolder: (sourceFolderId, destinationParentId) =>
          bookmarkFolderImport.importFolder(sourceFolderId, destinationParentId),
        messages: timedMessages,
        openTabInSpace,
        queueMutation: queueGroupMutation,
        releaseDepartingBackings: (backingIds) => splitViews.releaseDepartingBackings(backingIds),
        renameBookmark: (bookmarkId, title, url) => tabBookmarkLinks.renameBookmark(bookmarkId, title, url),
        renameTab: (tabId, backingId, title) => ownedTabs.renameOwnedTabBacking(tabId, backingId, title),
        windowSpaces: () => windowSpaces,
      }),
      ...mediaController.handlers,
      ...sharedDrag.handlers,
      ...splitViews.handlers,
      ...timedMessages.handlers,
    },
    ledger: targetLedger,
    reconciler: hyperModelReconciler,
    store: hyperModelStore,
  });
  // The connection that wakes the worker reaches only the listeners registered
  // as it starts, so the port listens now. Views may only authenticate against
  // an observed model, so a failed initial read never exposes the empty seed model.
  startHyperModelPortServer(hyperModelStore, {
    admitted: Promise.all([inPageSidebar.ready, modelRead]),
    authorizeInPageSidebar: inPageSidebar.authorize,
    onNativeSidebarPresence: inPageSidebar.nativeSidebarPresence,
    // A dead client's settled statuses are unreachable, and its running
    // effects keep their slot until they finish.
    onDisconnect: (client) => {
      sharedDrag.release(client.clientId);
      hyperModelStore.set(
        setCommandStatusesAtom,
        forgetClientCommands(hyperModelStore.get(commandStatusesAtom), client.clientId),
      );
    },
    search: (request, client) => searchController.search(request, client),
    submitIntent: submitHyperIntent,
  });
  let startupGroupRecoveryInProgress = false;
  const tabNavigationGenerations = new Map<number, number>();
  const spaceActivationTokens = new Map<number, string>();
  const groupExpansion = createSpaceGroupExpansion({
    activateSpaceGroup: (group) => spaceActivation.activateSpaceGroup(group),
    activationTokens: spaceActivationTokens,
    isSwitching: (windowId) => spaceSwitch.isSwitching(windowId),
    maxTrackedGroups: MAX_TRACKED_TAB_LIFECYCLES,
    queueActivation: (operation) => spaceActivation.queueSpaceGroupActivation(operation),
    startupRecoveryInProgress: () => startupGroupRecoveryInProgress,
  });
  const { beginProgrammaticGroupUpdate, endProgrammaticGroupUpdate } = groupExpansion;
  const spaceSwitch = createSpaceSwitchController({
    activateLiveGroup: (group, token, tabId) => spaceActivation.activateSpaceGroup(group, token, tabId, true),
    canAdoptParkedTabs: () => browserRestore.isSettled(),
    activationTokens: spaceActivationTokens,
    backingClosing: (backing) => tabBackingSync.backingClosing(backing),
    beginProgrammaticGroupUpdate,
    endProgrammaticGroupUpdate,
    disposeSpaceNewTabs: (spaceId, windowId, token) => disposeSpaceNewTabs(spaceId, windowId, token),
    persistWindowActiveSpace,
    restoreSpaceTabs: restoreSpaceTabsLater,
    routeTabToSpace: (tabId, spaceId) => {
      markIntentionalTab(tabId);
      return routeTabToSpace(tabId, spaceId);
    },
    spaceTabStripOrder: (spaceId, windowId) => tabStripOrder.stripOrder(spaceId, windowId),
  });
  const windowSpaces = createWindowSpaceChoice({
    activateFromSearch: (spaceId, windowId) => spaceActivation.activateSpaceFromSearch(spaceId, windowId),
    hasParkedTabs: hasParkedTabBackings,
    model: readModel,
    queueMutation: queueGroupMutation,
    switcher: spaceSwitch,
  });
  const initialTabOwnerships = browser.tabs.query({}).then(async (tabs) => {
    const ownerships = await loadTabOwnerships(tabs);
    return new Map(tabs.flatMap((tab) => tab.id === undefined ? [] : [[tab.id, tab.id in ownerships] as const]));
  }).catch(() => new Map<number, boolean>());
  const removedTabs = new Map<number, boolean>();
  let tabLifecycleGeneration = 0;
  let bookmarkLifecycleGeneration = 0;
  const hyperNewTabUrl = browser.runtime.getURL('/newtab.html');
  const navigationDedupe = createNavigationDedupe({
    generations: tabNavigationGenerations,
    markIntentionalTab,
    messages: timedMessages,
    newTabUrl: hyperNewTabUrl,
    persistWindowActiveSpace,
    queueMutation: queueGroupMutation,
  });
  const recordBookmarkImportState = (activeCount: number): Promise<void> => {
    bookmarkImportActiveCount = activeCount;
    return hyperModelReady
      ? hyperModelReconciler.scheduleReconciliation().then(
        () => undefined,
        () => undefined,
      )
      : Promise.resolve();
  };
  const bookmarkFolderImport = createBookmarkFolderImport(recordBookmarkImportState);
  const recoverJournalledOperations = () => recoverDurableOperations(async (operation) => {
    if (operation.kind === 'move-tab-to-window') return remoteTabController.recover(operation);
    if (operation.kind === 'restore-space-tabs') return recoverSpaceTabRestore(operation);
    if (operation.kind === 'import-bookmark-folder') return bookmarkFolderImport.recover(operation);
    if (operation.kind === 'duplicate-space') return recoverSpaceDuplication(operation);
    return recoverDeletedSpaceOperation(operation, { ...spaceDeletionBrowser, getTabOwnership });
  });
  const reportSearchIndexError = (error: unknown) => {
    console.error('Unable to update the background Search service.', error);
  };
  const {
    backingClaimedByAnotherLiveTab,
    rememberPending: rememberPendingBackingCleanup,
    removeBackingIfUnclaimed,
    retryPending: retryPendingBackingCleanup,
  } = createBackingCleanup({
    getTabOwnership,
    loadPendingJournal: loadPendingBackingCleanupJournal,
    queryTabs: () => browser.tabs.query({}),
    removeTabBackingBookmark,
    savePendingJournal: savePendingBackingCleanupJournal,
    tabBackingLocations,
  });
  const { disposeRestoredNewTabs, disposeSpaceNewTabs } = createNewTabDisposal({
    activationTokens: spaceActivationTokens,
    generations: tabNavigationGenerations,
    markIntentionalTab,
    newTabUrl: hyperNewTabUrl,
  });
  const tabBackingSync = createTabBackingSync({
    generations: tabNavigationGenerations,
    persistTabOwnership,
    rememberPendingBackingCleanup,
    removeBackingIfUnclaimed,
    removedTabs,
    tabBackingLocations,
  });
  const sidebarOpener = createSidebarOpener();
  sidebarOpener.registerActionClick();
  const spaceActivation = createSpaceActivation({
    activationTokens: spaceActivationTokens,
    disposeSpaceNewTabs,
    markIntentionalTab,
    persistWindowActiveSpace,
    queueMutation: queueGroupMutation,
    restoreSpaceTabs: restoreSpaceTabsLater,
    routeTabToSpace,
    spaceSwitch,
  });

  const tabRouter = createTabRouter({
    activateSpaceGroup: (group, tabId) => spaceActivation.activateSpaceGroup(group, undefined, tabId),
    beginProgrammaticGroupUpdate,
    endProgrammaticGroupUpdate,
    ensureStructure: () => ensureHyperBookmarkStructure(),
    syncTabBacking: (tab, spaceId) => tabBackingSync.syncTabBacking(tab, spaceId),
  });
  const routeTabToBookmarkSpace = (
    tabId: number,
    assignToActiveSpaceWhenUnmatched: boolean,
    fallbackSpaceId?: string,
  ) => tabRouter.route(tabId, assignToActiveSpaceWhenUnmatched, fallbackSpaceId);

  const spaceGroupOrder = createSpaceGroupOrder(groupExpansion);
  const spaceGroupColours = createSpaceGroupColours(groupExpansion);
  // Windows keep a space and its groups from the model, so no view has to be open for it.
  const spaceWindows = createSpaceWindowMaintenance({
    browserSettled: browserRestore.settled,
    persistWindowActiveSpace,
    queueMutation: queueGroupMutation,
    reconcileGroupColours: () => spaceGroupColours.reconcileAll(),
    reconcileGroupOrder: (spaces) => spaceGroupOrder.reconcileAll(spaces),
    routeTab: (tabId) => routeTabToBookmarkSpace(tabId, true),
    showSpace: (spaceId, windowId) => spaceSwitch.select(spaceId, windowId, { blankTab: false, reconcile: true }),
    store: hyperModelStore,
  });

  const ownedTabs = createOwnedTabActions({
    backingClaimedByAnotherLiveTab,
    duplicateController,
    markIntentionalTab,
    persistWindowActiveSpace,
    routeTab: routeTabToSpace,
    tabBookmarkLinks,
  });

  const restoreSpaceTabs = createSpaceTabRestore({
    activationTokens: spaceActivationTokens,
    backingClaimedByAnotherLiveTab,
    backingClosing: (backing) => tabBackingSync.backingClosing(backing),
    markIntentionalTab,
    persistTabOwnership: (tabId, ownership) => persistTabOwnership(tabId, ownership),
    tabBackingLocations,
  });

  const { deleteSpace } = createSpaceDeletionController({
    bookmarkLifecycleGeneration: () => bookmarkLifecycleGeneration,
    closeTabs,
    persistWindowActiveSpace,
    port: spaceDeletionBrowser,
  });
  const spaceArchive = createSpaceArchive({
    closeTabs, persistTabOwnership,
    queueMutation: queueGroupMutation, tabBackingLocations, windowSpaces: () => windowSpaces,
  });

  browser.runtime.onInstalled.addListener(() => void enableActionToggle());
  browser.commands.onCommand.addListener((command, tab) => {
    if (command !== 'open-command-bar') return;
    void sidebarOpener.openHyper(tab).catch((error) =>
      console.error('Unable to open Hyper.', error));
  });
  const reopenParkedTabs = () => spaceSwitch.reopenParkedTabs(sidebarOpener.lastFocusedNormalWindowId());
  const startupTabRecovery = createStartupTabRecovery({
    disposeRestoredNewTabs,
    generations: tabNavigationGenerations,
    persistTabOwnership,
    reopenParkedTabs,
    restoreSpaceTabs,
    routeTab: routeTabToBookmarkSpace,
    startupRecoveryInProgress: () => startupGroupRecoveryInProgress,
    tabBackingLocations,
    tabLifecycleGeneration: () => tabLifecycleGeneration,
  });
  const queueBootstrapTabBackings = createCoalescedAsyncRunner(
    () => queueGroupMutation(startupTabRecovery.bootstrapTabBackings),
  );
  // Restored tabs claim their parked backings first; whatever is left reopens after.
  const reopenParkedTabsOnceRestored = () => void browserRestore.settled().then(() =>
    queueGroupMutation(reopenParkedTabs))
    .catch(() => undefined);
  browser.runtime.onStartup.addListener(() => {
    void enableActionToggle();
    void queueGroupMutation(retryPendingBackingCleanup);
    startupGroupRecoveryInProgress = true;
    const cleanupRestoredNewTabs = queueGroupMutation(startupTabRecovery.cleanupRestoredNewTabs);
    const startupRecovery = cleanupRestoredNewTabs.then(queueBootstrapTabBackings);
    void startupRecovery.finally(() => {
      startupGroupRecoveryInProgress = false;
    }).catch(() => undefined);
    // Restored windows keep their old IDs on their backings until startup matches them.
    browserRestore.begin();
    browserRestore.hold(startupRecovery);
    reopenParkedTabsOnceRestored();
  });
  const handleBookmarkMutation = (
    bookmarkId?: string,
    change: 'created' | 'moved' | 'removed' | 'updated' = 'updated',
  ) => {
    if (bookmarkId) targetLedger.observe(bookmarkTarget(bookmarkId), change);
    bookmarkLifecycleGeneration += 1;
    scheduleHyperModelReconciliation();
  };
  browser.bookmarks.onCreated.addListener((id) => handleBookmarkMutation(id, 'created'));
  browser.bookmarks.onChanged.addListener((id) => handleBookmarkMutation(id, 'updated'));
  browser.bookmarks.onChildrenReordered.addListener((id) => handleBookmarkMutation(id));
  browser.bookmarks.onMoved.addListener((id) => handleBookmarkMutation(id, 'moved'));
  browser.bookmarks.onRemoved.addListener((id) => handleBookmarkMutation(id, 'removed'));
  const updateSearchIndex = <Change,>(update: (change: Change) => Promise<unknown>) =>
    (change: Change) => void update(change).catch(reportSearchIndexError);
  browser.history.onVisited.addListener(updateSearchIndex(searchController.handleHistoryVisited));
  browser.history.onVisitRemoved.addListener(updateSearchIndex(searchController.handleHistoryRemoved));
  const historyWithTitleChanges = browser.history as typeof browser.history & {
    onTitleChanged?: {
      addListener: (listener: (changed: { url: string; title: string }) => void) => void;
    };
  };
  historyWithTitleChanges.onTitleChanged?.addListener(
    updateSearchIndex(searchController.handleHistoryTitleChanged),
  );
  browser.runtime.onMessage.addListener((message: unknown, sender) => {
    const type = (message as { type?: unknown } | null)?.type;
    if (sender.tab && type === newTabShownMessageType) spaceSwitch.relayNewTabShown(sender.tab);
    if (!sender.tab || type !== openHyperFromPageMessageType) return;
    return sidebarOpener.openPageSearchOverlay(sender.tab).catch((error) => {
      console.error('Unable to open the Hyper Search overlay from the page shortcut.', error);
    });
  });
  void searchController.initialize().catch(reportSearchIndexError);
  const navigation = createTabNavigationIngress({
    backingClaimedByAnotherLiveTab,
    crossSpaceDuplicates: createCrossSpaceDuplicates({
      messages: timedMessages,
      newTabUrl: hyperNewTabUrl,
      queueMutation: queueGroupMutation,
      spaceTitle: (spaceId) => readModel().hyper.spaces.find((space) => space.id === spaceId)?.title,
      tabSpaceSwitch,
    }),
    duplicateController,
    forgetRemoval: (tabId) => removedTabs.delete(tabId),
    generations: tabNavigationGenerations,
    initialTabOwnerships,
    intentionalNewTabIds,
    maxTrackedTabs: MAX_TRACKED_TAB_LIFECYCLES,
    navigationDedupe,
    newTabUrl: hyperNewTabUrl,
    queueMutation: queueGroupMutation,
    retryPendingBackingCleanup,
    routeTab: routeTabToBookmarkSpace,
    scheduleReconciliation: scheduleHyperModelReconciliation,
    syncSameDomainNavigation: tabBackingSync.syncSameDomainNavigation,
    tabBookmarkLinks,
    tabStatuses,
  });
  navigation.seedNavigationUrls();
  browser.tabs.onCreated.addListener((tab) => {
    scheduleHyperModelReconciliation();
    browserRestore.noteTabCreated();
    tabLifecycleGeneration += 1;
    navigation.tabCreated(tab);
  });
  browser.webNavigation.onCommitted.addListener(navigation.historyNavigation);
  browser.webNavigation.onHistoryStateUpdated.addListener(navigation.historyNavigation);
  browser.webNavigation.onReferenceFragmentUpdated.addListener(navigation.historyNavigation);
  browser.webNavigation.onBeforeNavigate.addListener(navigation.beforeNavigate);
  browser.webNavigation.onCompleted.addListener(navigation.navigationCompleted);
  browser.webNavigation.onErrorOccurred.addListener(navigation.navigationFailed);
  const queueTitleSync = createKeyedCoalescer(queueGroupMutation, async (tabId: number, tab: Browser.tabs.Tab) => {
    const ownership = await getTabOwnership(tabId);
    if (ownership) await tabBackingSync.syncTabBacking(tab, ownership.spaceId);
    await syncBookmarkTitlesFollowingTab(tab, ownership?.backingId);
  }, { minIntervalMs: 1_000 });
  const queueHistoryTitle = createKeyedCoalescer(createSerialAsyncRunner(), (_tabId: number, tab: Browser.tabs.Tab) =>
    searchController.updateHistoryTitleFromTab(tab), { minIntervalMs: 1_000 });
  browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status === 'loading' || changeInfo.url !== undefined) {
      tabContentController.markNavigation(tabId);
    }
    scheduleHyperModelReconciliation();
    navigation.tabUpdated(tabId, changeInfo, tab);
    if (changeInfo.title !== undefined) {
      void queueHistoryTitle(tabId, tab).catch(reportSearchIndexError);
      void queueTitleSync(tabId, tab).catch(() => undefined);
    }
  });
  browser.tabs.onMoved.addListener((tabId) => {
    const origin = targetLedger.observe(tabTarget(tabId), 'moved');
    scheduleHyperModelReconciliation();
    void queueGroupMutation(() => routeTabToSpace(tabId)).catch(() => undefined);
    if (origin === 'external') tabStripOrder.tabMoved(tabId);
  });
  browser.tabs.onAttached.addListener((tabId, attachInfo) => {
    targetLedger.observe(tabTarget(tabId), 'moved');
    scheduleHyperModelReconciliation();
    if (remoteTabController.consumeExpectedAttachment(tabId, attachInfo.newWindowId)) return;
    // Queued at once, so an activation that follows the attach sees the tab routed.
    void queueGroupMutation(() => tabRouter.placeAttached(tabId, attachInfo.newWindowId))
      .catch(() => undefined);
  });
  browser.tabs.onRemoved.addListener((tabId, removeInfo) => {
    tabContentController.removeTab(tabId);
    scheduleHyperModelReconciliation();
    tabLifecycleGeneration += 1;
    const removalGeneration = advanceTabGeneration(tabNavigationGenerations, tabId);
    const locationAtRemoval = tabBackingLocations.get(tabId);
    const ownershipAtRemoval = getTabOwnership(tabId);
    removedTabs.set(tabId, removeInfo.isWindowClosing);
    retainRecentEntries(removedTabs, MAX_TRACKED_TAB_LIFECYCLES);
    navigation.tabRemoved(tabId);
    // Its backing counts as closing at once, though the release waits its turn.
    void queueGroupMutation(tabBackingSync.tabRemoved({
      isWindowClosing: removeInfo.isWindowClosing,
      locationAtRemoval,
      ownershipAtRemoval,
      removalGeneration,
      tabId,
    })).catch(() => undefined);
  });
  browser.windows.onRemoved.addListener((windowId) => {
    scheduleHyperModelReconciliation();
    sidebarOpener.forgetWindow(windowId);
    spaceActivationTokens.delete(windowId);
    void queueGroupMutation(() => spaceSwitch.closeWindow(windowId)).catch(() => undefined);
    // A quitting browser closes every window; waiting keeps it from reopening tabs on its way out.
    setTimeout(reopenParkedTabsOnceRestored, 1_000);
  });
  browser.windows.onFocusChanged.addListener((windowId) => {
    if (windowId >= 0) targetLedger.observe(windowTarget(windowId), 'updated');
    scheduleHyperModelReconciliation();
    sidebarOpener.focusChanged(windowId);
  });
  browser.tabs.onActivated.addListener(({ tabId, windowId }) => {
    targetLedger.observe(tabTarget(tabId), 'updated');
    scheduleHyperModelReconciliation();
    // The model follows every activation, but only the user's is a last-used choice.
    if (spaceSwitch.claimActivation(windowId, tabId)) return;
    void rememberActiveTab(tabId).catch(() => undefined);
    spaceActivation.queueBrowserTabActivation(tabId, windowId);
  });
  browser.tabGroups?.onUpdated?.addListener((group) => {
    scheduleHyperModelReconciliation();
    groupExpansion.groupUpdated(group);
  });
  browser.tabGroups?.onMoved?.addListener((group) => {
    scheduleHyperModelReconciliation();
    void queueGroupMutation(() => spaceGroupOrder.reorderSpacesFromWindow(group.windowId))
      .catch(() => undefined);
  });
  browser.windows.onCreated.addListener(() => {
    scheduleHyperModelReconciliation();
    // A reopened window brings its tabs back right after it.
    browserRestore.begin();
    reopenParkedTabsOnceRestored();
  });
  for (const event of [
    browser.tabs.onReplaced,
    browser.tabs.onDetached,
    browser.tabGroups?.onCreated,
    browser.tabGroups?.onRemoved,
    browser.bookmarks.onImportBegan,
    browser.bookmarks.onImportEnded,
    browser.sessions?.onChanged,
    // Capability changes alter what the model can observe at all, so they are
    // ingress in exactly the same way a bookmark or tab event is.
    browser.permissions?.onAdded,
    browser.permissions?.onRemoved,
  ] as ({ addListener(listener: () => void): void } | undefined)[]) {
    event?.addListener(() => scheduleHyperModelReconciliation());
  }
  browser.storage.onChanged.addListener((_changes, areaName) => {
    if (isModelStorageArea(areaName)) scheduleHyperModelReconciliation();
  });
  // The model repairs the structure it depends on, so the commit that reports
  // the damage is what asks for the repair. No view has to watch bookmark
  // events to keep the roots alive.
  hyperModelStore.sub(hyperModelAtom, watchStructureRepair(
    () => hyperModelStore.get(structureHealthAtom),
    () => void queueGroupMutation(ensureHyperBookmarkStructure).catch(() => undefined),
  ));
  void enableActionToggle();
  // Earlier versions kept preferences in storage.local. Moving them before the
  // first read means no view or in-page sidebar ever sees the defaults instead.
  void queueGroupMutation(migrateLegacyPreferences).catch((error: unknown) => {
    console.error('Unable to move Hyper preferences into the bookmarks.', error);
  }).then(() => {
    hyperModelReady = true;
    return hyperModelReconciler.reconcile();
  }).catch((error: unknown) => {
    console.error('Unable to read the Hyper model.', error);
  });
  void queueGroupMutation(retryPendingBackingCleanup).catch(() => undefined)
    .then(() => queueGroupMutation(recoverJournalledOperations))
    .then(queueBootstrapTabBackings)
    .catch((error) => {
      console.error('Unable to complete Hyper maintenance.', error);
    })
    .then(() => spaceWindows.start())
    .then(() => splitViews.start())
    .then(() => tabStripOrder.start());
});
