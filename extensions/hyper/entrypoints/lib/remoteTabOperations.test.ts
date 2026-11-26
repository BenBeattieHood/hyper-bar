import { describe, expect, it, vi } from 'vitest';
import {
  bookmarkTarget,
  createEffectFence,
  createTargetLedger,
  tabTarget,
  windowTarget,
} from './modelGuards';
import type { DurableOperation } from './operationJournal';
import {
  activateRemoteTab,
  moveRemoteTabToWindow,
  recoverMovedTabToWindowOperation,
} from './remoteTabOperations';
import { remoteSourceOwnership, remoteTabSnapshot } from './testFixtures';

const sourceOwnership = remoteSourceOwnership;
const model = () => remoteTabSnapshot();

function moveOperation(overrides: Partial<DurableOperation> = {}): DurableOperation {
  return {
    completionProof: {
      destinationWindowId: 1,
      sourceWindowId: 2,
      spaceId: 'two',
      tabId: 2,
    },
    id: 'move-1',
    idempotencyKey: 'move-tab-to-window:2:2:1:token-2',
    kind: 'move-tab-to-window',
    payload: {
      destinationOwnership: { ...sourceOwnership, windowId: 1 },
      destinationWindowId: 1,
      sourceIndex: 3,
      sourceOwnership,
      sourceWindowId: 2,
      tabId: 2,
    },
    phase: 'prepared',
    recovery: 'abandon',
    startedAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe('remote tab operations', () => {
  it('focuses the exact remote target through declared target effects', async () => {
    const ledger = createTargetLedger();
    const effects = createEffectFence(ledger, 'focus', [tabTarget(1), windowTarget(1)]);
    const focusTab = vi.fn(async () => {
      ledger.observe(tabTarget(2), 'updated');
      ledger.observe(windowTarget(2), 'updated');
      return true;
    });
    const getTab = vi.fn(async (tabId: number) => model().browser.tabs.find((tab) => tab.id === tabId));
    const getWindow = vi.fn(async (windowId: number) =>
      model().browser.windows.find((window) => window.id === windowId));

    await activateRemoteTab(model(), 1, {
      source: { kind: 'tab', tabId: 1 },
      spaceId: 'two',
    }, effects, {
      focusTab,
      getTab,
      getTabOwnership: async () => sourceOwnership,
      getWindow,
    });

    expect(focusTab).toHaveBeenCalledWith(2, 2, 1);
  });

  it('journals, moves, preserves, and verifies one exact remote tab', async () => {
    const ledger = createTargetLedger();
    const effects = createEffectFence(ledger, 'move', [tabTarget(1), windowTarget(1)]);
    const currentTab = { ...model().browser.tabs[1]!, windowId: 2 } as Browser.tabs.Tab;
    let currentOwnership = { ...sourceOwnership };
    const beginOperation = vi.fn(async () => undefined);
    const advanceOperation = vi.fn(async () => undefined);
    const completeOperation = vi.fn(async () => undefined);
    const moveTab = vi.fn(async () => {
      currentTab.windowId = 1;
      ledger.observe(tabTarget(2), 'moved');
      return currentTab;
    });
    const persistMovedOwnership = vi.fn(async (_tabId, _source, destination) => {
      currentOwnership = destination;
      ledger.observe(bookmarkTarget(sourceOwnership.backingId), 'updated');
    });

    await moveRemoteTabToWindow(model(), 1, {
      source: { kind: 'tab', tabId: 1 },
      spaceId: 'two',
    }, effects, {
      advanceOperation,
      beginOperation,
      completeOperation,
      createOperationId: () => 'move-1',
      getTab: async (tabId) => tabId === 1 ? model().browser.tabs[0] : currentTab,
      getTabOwnership: async () => currentOwnership,
      getWindow: async (windowId) => model().browser.windows.find((window) => window.id === windowId),
      moveTab,
      now: () => 1,
      persistMovedOwnership,
    });

    expect(beginOperation).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'move-tab-to-window',
      payload: expect.objectContaining({ sourceIndex: 3, sourceOwnership }),
    }));
    expect(moveTab).toHaveBeenCalledWith(2, 1);
    expect(persistMovedOwnership).toHaveBeenCalledWith(2, sourceOwnership, {
      ...sourceOwnership,
      windowId: 1,
    });
    expect(advanceOperation).toHaveBeenNthCalledWith(1, 'move-1', 'effect-applied');
    expect(advanceOperation).toHaveBeenNthCalledWith(2, 'move-1', 'verifying');
    expect(completeOperation).toHaveBeenCalledWith('move-1');
  });
});

describe('move tab recovery', () => {
  it('completes only the exact destination ownership', async () => {
    await expect(recoverMovedTabToWindowOperation(moveOperation(), {
      getTab: async () => ({ incognito: false, windowId: 1 }),
      getTabOwnership: async () => ({ ...sourceOwnership, windowId: 1 }),
    })).resolves.toEqual({ status: 'completed' });
    await expect(recoverMovedTabToWindowOperation(moveOperation(), {
      getTab: async () => ({ incognito: false, windowId: 1 }),
      getTabOwnership: async () => sourceOwnership,
    })).resolves.toMatchObject({ status: 'abandoned' });
  });

  it('rolls back only an untouched source and abandons mixed locations', async () => {
    await expect(recoverMovedTabToWindowOperation(moveOperation(), {
      getTab: async () => ({ incognito: false, windowId: 2 }),
      getTabOwnership: async () => sourceOwnership,
    })).resolves.toEqual({ status: 'rolled-back' });
    await expect(recoverMovedTabToWindowOperation(moveOperation(), {
      getTab: async () => ({ incognito: false, windowId: 3 }),
      getTabOwnership: async () => sourceOwnership,
    })).resolves.toMatchObject({ status: 'abandoned' });
  });
});