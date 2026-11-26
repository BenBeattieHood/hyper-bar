import { createHyperModelStore, hyperModelAtom, type HyperModelStore } from './model';
import { createHyperModelReconciler, type HyperModelReconciler } from './modelReconciler';
import { createBrowserModelSourcesReader, type RuntimeSignals } from './modelSources';
import { createMediaController, type MediaController } from './mediaController';
import { createMediaAccessOffers } from './mediaAccessOffers';
import { isMediaPlaybackChangedMessage } from './mediaControl';
import {
  createInPageSidebarController,
  type InPageSidebarController,
} from './inPageSidebarController';
import { createTabContentController, type TabContentController } from './tabContentController';
import { createSearchController, type SearchController } from './searchController';
import { createTabOwnershipWriter, getTabOwnership, type TabOwnership } from './tabOwnership';
import { createWindowActiveSpaceWriter } from './windowState';
import { createDuplicateController, type DuplicateController } from './duplicateController';
import { createSharedDragController, type SharedDragController } from './sharedDrag';
import { saveHyperPreferences } from './bookmarkStorage';
import {
  createTabBookmarkLinkController,
  type TabBookmarkLinkController,
} from './tabBookmarkLinkController';
import { renameTabDocumentTitle } from './tabDocumentTitle';
import { createTabTitlePresenter } from './tabTitlePresenter';
import { createTimedMessages, type TimedMessages } from './timedMessages';

interface BackgroundModelRuntimeDependencies {
  queueMutation<Result>(operation: () => Promise<Result>): Promise<Result>;
  readRuntimeSignals(): Pick<RuntimeSignals, 'bookmarkImportActiveCount' | 'statuses'>;
}

export interface BackgroundModelRuntime {
  duplicateController: DuplicateController;
  inPageSidebar: InPageSidebarController;
  mediaController: MediaController;
  /** Resolves once the model has been observed, so no view is shown the empty seed model. */
  modelRead: Promise<void>;
  persistTabOwnership: (tabId: number, ownership: TabOwnership) => Promise<void>;
  persistWindowActiveSpace: (windowId: number, spaceId: string) => Promise<void>;
  reconciler: HyperModelReconciler;
  searchController: SearchController;
  sharedDrag: SharedDragController;
  store: HyperModelStore;
  tabBookmarkLinks: TabBookmarkLinkController;
  tabContentController: TabContentController;
  timedMessages: TimedMessages;
}

/**
 * Holds the circular controller/reconciler relationship outside the worker
 * entrypoint. Controllers retain only discardable caches; reconciliation is
 * still the sole route into the committed root snapshot.
 */
export function createBackgroundModelRuntime(
  dependencies: BackgroundModelRuntimeDependencies,
): BackgroundModelRuntime {
  const store = createHyperModelStore();
  let reconciler: HyperModelReconciler;
  const { queueMutation } = dependencies;
  const reconcile = () => reconciler.scheduleReconciliation();
  const tabContentController = createTabContentController({ reconcile, store });
  const mediaController = createMediaController({ queueMutation, reconcile, store });
  const searchController = createSearchController({ reconcile, store });
  const timedMessages = createTimedMessages({
    durationMs: () => store.get(hyperModelAtom).runtime.preferences.timedMessageSeconds * 1_000,
    reconcile,
  });
  const duplicateController = createDuplicateController({
    getTabOwnership,
    messages: timedMessages,
    queueMutation,
  });
  const tabBookmarkLinks = createTabBookmarkLinkController({
    messages: timedMessages,
    queueMutation,
    store,
  });
  const sharedDrag = createSharedDragController({
    readSnapshot: () => store.get(hyperModelAtom),
    reconcile,
  });
  reconciler = createHyperModelReconciler(
    store,
    createBrowserModelSourcesReader(() => ({
      ...dependencies.readRuntimeSignals(),
      ...mediaController.runtimeSignals(),
      ...searchController.runtimeSignals(),
      ...sharedDrag.runtimeSignals(),
      ...tabContentController.runtimeSignals(),
      ...timedMessages.runtimeSignals(),
    })),
  );
  const reconcileAfterPersistence = () => void reconcile().catch(() => undefined);
  const persistTabOwnership = createTabOwnershipWriter(reconcileAfterPersistence);
  const persistWindowActiveSpace = createWindowActiveSpaceWriter(
    reconcileAfterPersistence,
  );
  const modelRead = new Promise<void>((resolve) => {
    const unsubscribe = store.sub(hyperModelAtom, () => {
      if (store.get(hyperModelAtom).revision === 0) return;
      unsubscribe();
      resolve();
    });
  });
  const inPageSidebar = createInPageSidebarController({
    enabled: () => store.get(hyperModelAtom).runtime.preferences.inPageSidebar,
    modelRead,
    saveWidth: (inPageSidebarWidth) => saveHyperPreferences({ inPageSidebarWidth }),
    width: () => store.get(hyperModelAtom).runtime.preferences.inPageSidebarWidth,
  });
  store.sub(hyperModelAtom, () => inPageSidebar.refresh());
  const tabTitles = createTabTitlePresenter({ setDocumentTitle: renameTabDocumentTitle });
  store.sub(hyperModelAtom, () => {
    const snapshot = store.get(hyperModelAtom);
    tabBookmarkLinks.recordInferredLinks(snapshot);
    tabTitles.present(snapshot);
  });
  browser.runtime.onMessage.addListener((message: unknown, sender) => {
    const inPageSidebarState = inPageSidebar.handleMessage(message, sender);
    if (inPageSidebarState) return inPageSidebarState;
    if (!isMediaPlaybackChangedMessage(message)) return;
    const tabId = sender.tab?.id;
    if (tabId === undefined || sender.tab?.incognito) return;
    return mediaController.handlePlaybackChanged(tabId).catch(() => undefined);
  });
  browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    void mediaController.handleTabUpdated(tabId, changeInfo, tab).catch((error) => {
      console.error('Unable to update media controls.', error);
    });
  });
  const recheckMediaAccess = () => {
    void mediaController.handlePermissionsChanged().catch((error) => {
      console.error('Unable to recheck media access.', error);
    });
  };
  browser.permissions?.onAdded?.addListener(recheckMediaAccess);
  browser.permissions?.onRemoved?.addListener(recheckMediaAccess);
  createMediaAccessOffers({ media: mediaController, messages: timedMessages, store });
  browser.tabs.onRemoved.addListener((tabId) => {
    mediaController.removeTab(tabId);
    duplicateController.removeTab(tabId);
    inPageSidebar.removeTab(tabId);
    tabBookmarkLinks.removeTab(tabId);
    tabTitles.removeTab(tabId);
    timedMessages.removeTab(tabId);
  });
  return {
    duplicateController,
    inPageSidebar,
    mediaController,
    modelRead,
    persistTabOwnership,
    persistWindowActiveSpace,
    reconciler,
    searchController,
    sharedDrag,
    store,
    tabBookmarkLinks,
    tabContentController,
    timedMessages,
  };
}