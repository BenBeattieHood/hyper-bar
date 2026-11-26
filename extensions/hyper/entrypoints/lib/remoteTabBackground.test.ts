import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEffectFence, createTargetLedger, tabTarget, windowTarget } from './modelGuards';

const mocks = vi.hoisted(() => ({
  advanceDurableOperation: vi.fn(),
  beginDurableOperation: vi.fn(),
  completeDurableOperation: vi.fn(),
  ensureTabBackingBookmark: vi.fn(),
  focusTabInWindow: vi.fn(),
  getTabOwnership: vi.fn(),
}));

vi.mock('./bookmarkStorage', () => ({
  ensureTabBackingBookmark: mocks.ensureTabBackingBookmark,
}));
vi.mock('./operationJournal', () => ({
  advanceDurableOperation: mocks.advanceDurableOperation,
  beginDurableOperation: mocks.beginDurableOperation,
  completeDurableOperation: mocks.completeDurableOperation,
}));
vi.mock('./tabOwnership', async (importOriginal) => ({
  ...await importOriginal<typeof import('./tabOwnership')>(),
  getTabOwnership: mocks.getTabOwnership,
}));
vi.mock('./tabs', async (importOriginal) => ({
  ...await importOriginal<typeof import('./tabs')>(),
  focusTabInWindow: mocks.focusTabInWindow,
}));

import { createRemoteTabBackgroundController } from './remoteTabBackground';
import { remoteSourceOwnership, remoteTabSnapshot } from './testFixtures';

const sourceOwnership = remoteSourceOwnership;
const snapshot = () => remoteTabSnapshot();

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('remote tab background controller', () => {
  it('persists the exact moved backing and consumes only its expected attachment', async () => {
    vi.useFakeTimers();
    let currentTab = { ...snapshot().browser.tabs[1]! } as Browser.tabs.Tab;
    let ownership = { ...sourceOwnership };
    const ledger = createTargetLedger();
    const effects = createEffectFence(ledger, 'move', [tabTarget(1), windowTarget(1)]);
    const get = vi.fn(async (tabId: number) => tabId === 1
      ? snapshot().browser.tabs[0]
      : currentTab);
    const move = vi.fn(async (tabId: number, options: Browser.tabs.MoveProperties) => {
      expect(tabId).toBe(2);
      currentTab = { ...currentTab, windowId: options.windowId! };
      ledger.observe(tabTarget(tabId), 'moved');
      return currentTab;
    });
    const getWindow = vi.fn(async (windowId: number) => snapshot().browser.windows.find(
      (window) => window.id === windowId,
    ));
    const persistTabOwnership = vi.fn(async (_tabId: number, next: typeof sourceOwnership) => {
      ownership = next;
    });
    mocks.getTabOwnership.mockImplementation(async () => ownership);
    mocks.beginDurableOperation.mockResolvedValue(undefined);
    mocks.advanceDurableOperation.mockResolvedValue(undefined);
    mocks.completeDurableOperation.mockResolvedValue(undefined);
    mocks.ensureTabBackingBookmark.mockImplementation(async (tab: Browser.tabs.Tab) => {
      ledger.observe(`bookmark:${sourceOwnership.backingId}`, 'updated');
      return { ...sourceOwnership, windowId: tab.windowId };
    });
    vi.stubGlobal('crypto', { randomUUID: () => 'move-1' });
    vi.stubGlobal('browser', {
      tabs: { get, move },
      windows: { get: getWindow },
    });
    const tabBackingLocations = new Map([[2, sourceOwnership]]);
    const placeMovedTab = vi.fn();
    const controller = createRemoteTabBackgroundController({
      closeTabs: vi.fn(async () => undefined),
      persistTabOwnership,
      placeMovedTab,
      readSnapshot: snapshot,
      tabBackingLocations,
    });

    await controller.move({
      source: { kind: 'tab', tabId: 1 },
      spaceId: 'two',
    }, { windowId: 1 }, effects);

    expect(mocks.ensureTabBackingBookmark).toHaveBeenCalledWith(
      expect.objectContaining({ id: 2, windowId: 1 }),
      'two',
      sourceOwnership,
    );
    expect(persistTabOwnership).toHaveBeenCalledWith(2, {
      ...sourceOwnership,
      windowId: 1,
    });
    expect(tabBackingLocations.get(2)).toEqual({ ...sourceOwnership, windowId: 1 });
    expect(placeMovedTab).toHaveBeenCalledWith(2, 'two');
    expect(controller.consumeExpectedAttachment(2, 2)).toBe(false);
    expect(controller.consumeExpectedAttachment(2, 1)).toBe(true);
    expect(controller.consumeExpectedAttachment(2, 1)).toBe(false);
  });

  it('closes the page in that space and claims its tabs before closing them', async () => {
    const closeTabs = vi.fn(async () => undefined);
    const controller = createRemoteTabBackgroundController({
      closeTabs,
      persistTabOwnership: vi.fn(async () => undefined),
      placeMovedTab: vi.fn(),
      readSnapshot: snapshot,
      tabBackingLocations: new Map(),
    });
    const effects = { check: vi.fn(), extend: vi.fn(), step: vi.fn() };
    const request = { source: { kind: 'tab' as const, tabId: 1 }, spaceId: 'two' };

    await controller.close(request, { windowId: 1 }, effects);
    expect(effects.extend).toHaveBeenCalledWith([tabTarget(2)]);
    expect(closeTabs).toHaveBeenCalledWith([2]);

    await expect(controller.close({ ...request, spaceId: 'one' }, { windowId: 1 }, effects))
      .rejects.toThrow('no longer open');
    expect(closeTabs).toHaveBeenCalledTimes(1);
  });
});