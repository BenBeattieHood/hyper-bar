import {
  ensureTabBackingBookmark,
  type TabBackingLocation,
} from './bookmarkStorage';
import type { HyperModelSnapshot } from './model';
import type { RemoteTabOperationPayload } from './modelIntentPayloads';
import { tabTarget, type EffectFence } from './modelGuards';
import {
  advanceDurableOperation,
  beginDurableOperation,
  completeDurableOperation,
  type DurableOperation,
  type DurableOperationResolution,
} from './operationJournal';
import {
  activateRemoteTab,
  moveRemoteTabToWindow,
  recoverMovedTabToWindowOperation,
  type CompleteTabOwnership,
} from './remoteTabOperations';
import { spacePageTabIds } from './remoteTab';
import { getTabOwnership, sameTabOwnership, type TabOwnership } from './tabOwnership';
import { focusTabInWindow, tabById } from './tabs';
import { windowById } from './windowState';

interface RemoteTabClient {
  windowId: number;
}

export interface RemoteTabBackgroundDependencies {
  closeTabs(tabIds: number[]): Promise<void>;
  persistTabOwnership(tabId: number, ownership: TabOwnership): Promise<void>;
  /** Groups a moved tab into its kept space, which incidental routing leaves to the move. */
  placeMovedTab(tabId: number, spaceId: string): void;
  readSnapshot(): HyperModelSnapshot;
  tabBackingLocations: Map<number, TabBackingLocation>;
}

export interface RemoteTabBackgroundController {
  activate(
    payload: RemoteTabOperationPayload,
    client: RemoteTabClient,
    effects: EffectFence,
  ): Promise<void>;
  /** Closes the source's page wherever the space has it open, this window included. */
  close(
    payload: RemoteTabOperationPayload,
    client: RemoteTabClient,
    effects: EffectFence,
  ): Promise<void>;
  consumeExpectedAttachment(tabId: number, windowId: number): boolean;
  /** Marks a tab Hyper is moving to a window and will place there itself. */
  expectAttachment(tabId: number, windowId: number): void;
  move(
    payload: RemoteTabOperationPayload,
    client: RemoteTabClient,
    effects: EffectFence,
  ): Promise<void>;
  recover(operation: DurableOperation): Promise<DurableOperationResolution>;
}

/** Binds private remote targets to the worker without letting views see them. */
export function createRemoteTabBackgroundController(
  dependencies: RemoteTabBackgroundDependencies,
): RemoteTabBackgroundController {
  const expectedAttachmentWindows = new Map<number, number>();
  const persistMovedOwnership = async (
    tabId: number,
    source: CompleteTabOwnership,
    destination: CompleteTabOwnership,
  ) => {
    const tab = await tabById(tabId);
    if (!tab || tab.incognito || tab.windowId !== destination.windowId) {
      throw new Error('The moved tab is unavailable in its destination window.');
    }
    const location = await ensureTabBackingBookmark(tab, source.spaceId, source);
    if (!location || !sameTabOwnership(location, destination)) {
      throw new Error('The moved tab backing could not preserve its exact ownership.');
    }
    await dependencies.persistTabOwnership(tabId, location);
    dependencies.tabBackingLocations.set(tabId, location);
    dependencies.placeMovedTab(tabId, location.spaceId);
  };
  const expectAttachment = (tabId: number, windowId: number) => {
    expectedAttachmentWindows.set(tabId, windowId);
    setTimeout(() => {
      if (expectedAttachmentWindows.get(tabId) === windowId) {
        expectedAttachmentWindows.delete(tabId);
      }
    }, 5_000);
  };
  const moveTab = async (tabId: number, destinationWindowId: number) => {
    expectAttachment(tabId, destinationWindowId);
    try {
      return await browser.tabs.move(tabId, { index: -1, windowId: destinationWindowId });
    } catch (error) {
      expectedAttachmentWindows.delete(tabId);
      throw error;
    }
  };
  const readDependencies = { getTab: tabById, getTabOwnership, getWindow: windowById };
  return {
    activate(payload, client, effects) {
      return activateRemoteTab(
        dependencies.readSnapshot(),
        client.windowId,
        payload,
        effects,
        { ...readDependencies, focusTab: focusTabInWindow },
      );
    },
    async close(payload, client, effects) {
      const tabIds = spacePageTabIds(dependencies.readSnapshot(), client.windowId, payload);
      if (tabIds.length === 0) throw new Error('That page is no longer open in that space.');
      effects.extend(tabIds.map(tabTarget));
      await dependencies.closeTabs(tabIds);
    },
    consumeExpectedAttachment(tabId, windowId) {
      if (expectedAttachmentWindows.get(tabId) !== windowId) return false;
      expectedAttachmentWindows.delete(tabId);
      return true;
    },
    expectAttachment,
    move(payload, client, effects) {
      return moveRemoteTabToWindow(
        dependencies.readSnapshot(),
        client.windowId,
        payload,
        effects,
        {
          ...readDependencies,
          advanceOperation: advanceDurableOperation,
          beginOperation: beginDurableOperation,
          completeOperation: completeDurableOperation,
          createOperationId: () => crypto.randomUUID(),
          moveTab,
          now: () => Date.now(),
          persistMovedOwnership,
        },
      );
    },
    recover(operation) {
      return recoverMovedTabToWindowOperation(operation, readDependencies);
    },
  };
}