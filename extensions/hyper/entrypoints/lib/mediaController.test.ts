import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createHyperModelStore,
  emptyBrowserObservation,
  emptyRuntimeMetadata,
} from './model';
import { createMediaController } from './mediaController';
import type { MediaControlTarget, MediaPlaybackState, TabMediaInspection } from './mediaControl';
import type { HyperModelPortClient } from './modelPort';
import { commitTestSources } from './testFixtures';

const client: HyperModelPortClient = {
  clientId: 'sidebar-client',
  role: 'sidebar',
  windowId: 3,
};

const mediaTab = {
  audible: true,
  id: 7,
  url: 'https://example.test',
  windowId: 3,
} as Browser.tabs.Tab;

const playing = (tabId: number): TabMediaInspection => ({
  reachable: true,
  target: { elementIndex: 2, frameId: 0, state: 'playing', tabId },
});

function controllerHarness(options: {
  inspect?: (tabId: number) => Promise<TabMediaInspection>;
  setPlayback?: (
    target: MediaControlTarget,
    state: MediaPlaybackState,
  ) => Promise<MediaControlTarget | undefined>;
  tabs?: Browser.tabs.Tab[];
} = {}) {
  const store = createHyperModelStore({
    browser: { ...emptyBrowserObservation, tabs: options.tabs ?? [mediaTab] },
    runtime: emptyRuntimeMetadata,
  });
  const reconcile = vi.fn(async () => undefined);
  const pauseOthers = vi.fn(async () => undefined);
  const scriptingReady = vi.fn(async () => true);
  const controller = createMediaController({
    canControl: () => true,
    inspect: options.inspect ?? vi.fn(async (tabId: number) => playing(tabId)),
    pauseOthers,
    queueMutation: (operation) => operation(),
    reconcile,
    scriptingReady,
    setPlayback: options.setPlayback ?? vi.fn(async (
      target: MediaControlTarget,
      state: MediaPlaybackState,
    ) => ({ ...target, state })),
    store,
  });
  return { controller, pauseOthers, reconcile, scriptingReady, store };
}

afterEach(() => vi.unstubAllGlobals());

describe('media controller', () => {
  it('reconciles before enforcing exclusive playback on the first worker observation', async () => {
    const first = { ...mediaTab, active: true };
    const second = { ...mediaTab, id: 8, url: 'https://second.example' };
    const { controller, pauseOthers, reconcile } = controllerHarness({ tabs: [first, second] });

    await controller.handlePlaybackChanged(7);

    expect(pauseOthers).toHaveBeenCalledWith([8]);
    expect(reconcile.mock.invocationCallOrder[0]).toBeLessThan(
      pauseOthers.mock.invocationCallOrder[0]!,
    );
    expect(controller.runtimeSignals().mediaRetainedTabIds).toEqual({ 3: 7 });
  });

  it('hands playback to a tab that starts playing after another is retained', async () => {
    const first = { ...mediaTab, active: true };
    const second = { ...mediaTab, audible: false, id: 8, url: 'https://second.example' };
    const { controller, pauseOthers, store } = controllerHarness({ tabs: [first, second] });
    await controller.handlePlaybackChanged(7);
    pauseOthers.mockClear();

    const audibleSecond = { ...second, audible: true };
    commitTestSources(store, { tabs: [first, audibleSecond] });
    await controller.handleTabUpdated(8, { audible: true }, audibleSecond);

    expect(pauseOthers).toHaveBeenCalledWith([7]);
    expect(controller.runtimeSignals().mediaRetainedTabIds).toEqual({ 3: 8 });
  });

  it('owns exclusive playback and captures an audible tab into runtime signals', async () => {
    const { controller, pauseOthers } = controllerHarness();

    await controller.handleTabUpdated(7, { audible: true }, mediaTab);

    expect(pauseOthers).toHaveBeenCalledWith([]);
    expect(controller.runtimeSignals()).toMatchObject({
      mediaRetainedTabIds: { 3: 7 },
      mediaStates: {
        7: {
          elementIndex: 2,
          frameId: 0,
          navigationVersion: 0,
          state: 'playing',
          tabId: 7,
          url: 'https://example.test',
        },
      },
    });
  });

  it('drops an inspection result that raced a navigation', async () => {
    let resolveInspection: ((inspection: TabMediaInspection) => void) | undefined;
    const inspection = new Promise<TabMediaInspection>((resolve) => {
      resolveInspection = resolve;
    });
    const { controller } = controllerHarness({ inspect: () => inspection });

    const updating = controller.handlePlaybackChanged(7);
    controller.markNavigation(7);
    resolveInspection?.(playing(7));
    await updating;

    expect(controller.runtimeSignals().mediaStates).toEqual({});
    expect(controller.runtimeSignals().mediaNavigationVersions).toEqual({ 7: 1 });
  });

  it('sets playback only through the current model-owned target', async () => {
    const setPlayback = vi.fn(async (
      target: MediaControlTarget,
      state: MediaPlaybackState,
    ) => ({ ...target, state }));
    const { controller } = controllerHarness({ setPlayback });
    await controller.handleTabUpdated(7, { audible: true }, mediaTab);

    await controller.handlers.setTabMediaPlayback!.run({ state: 'paused', tabId: 7 }, client);

    expect(setPlayback).toHaveBeenCalledWith(expect.objectContaining({ tabId: 7 }), 'paused');
    expect(controller.runtimeSignals().mediaStates[7]?.state).toBe('paused');
  });

  it('never retains, inspects, or pauses an incognito tab', async () => {
    const privateTab = { ...mediaTab, incognito: true };
    const inspect = vi.fn(async (tabId: number) => playing(tabId));
    const { controller, pauseOthers } = controllerHarness({ inspect, tabs: [privateTab] });

    await controller.handleTabUpdated(7, { audible: true }, privateTab);

    expect(inspect).not.toHaveBeenCalled();
    expect(pauseOthers).not.toHaveBeenCalled();
    expect(controller.runtimeSignals().mediaRetainedTabIds).toEqual({});
    expect(controller.runtimeSignals().mediaStates).toEqual({});
  });

  it('cancels silent-retention grace when navigation invalidates its media target', async () => {
    vi.useFakeTimers();
    try {
      const tab = { ...mediaTab };
      const { controller } = controllerHarness({ tabs: [tab] });

      await controller.handleTabUpdated(7, { audible: true }, tab);
      tab.audible = false;
      await controller.handleTabUpdated(7, { audible: false }, tab);
      expect(vi.getTimerCount()).toBe(1);

      controller.markNavigation(7);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('records a page it cannot reach until a grant lets it find the player', async () => {
    let inspection: TabMediaInspection = { reachable: false };
    const inspect = vi.fn(async () => inspection);
    const { controller, reconcile, scriptingReady } = controllerHarness({ inspect });

    await controller.handleTabUpdated(7, { audible: true }, mediaTab);
    expect(controller.runtimeSignals().mediaUnreachableTabIds).toEqual([7]);
    expect(controller.runtimeSignals().mediaStates).toEqual({});
    expect(reconcile).toHaveBeenCalled();

    inspection = playing(7);
    await controller.handlePermissionsChanged();

    expect(scriptingReady.mock.invocationCallOrder[0]).toBeLessThan(
      inspect.mock.invocationCallOrder[1]!,
    );
    expect(controller.runtimeSignals().mediaUnreachableTabIds).toEqual([]);
    expect(controller.runtimeSignals().mediaStates[7]?.state).toBe('playing');
  });

  it('reinspects one tab on demand and settles with what it found', async () => {
    let inspection: TabMediaInspection = { reachable: false };
    const { controller } = controllerHarness({ inspect: async () => inspection });
    await controller.handleTabUpdated(7, { audible: true }, mediaTab);

    await expect(controller.reinspect(7)).resolves.toEqual({ reachable: false });

    inspection = playing(7);

    await expect(controller.reinspect(7)).resolves.toMatchObject({
      reachable: true,
      target: { state: 'playing', tabId: 7 },
    });
    expect(controller.runtimeSignals().mediaUnreachableTabIds).toEqual([]);

    inspection = { reachable: true };

    await expect(controller.reinspect(7)).resolves.toEqual({ reachable: true });
  });

  it('drops a player once the access it was found through is removed', async () => {
    let inspection = playing(7);
    const { controller } = controllerHarness({ inspect: async () => inspection });
    await controller.handleTabUpdated(7, { audible: true }, mediaTab);
    expect(controller.runtimeSignals().mediaStates[7]).toBeDefined();

    inspection = { reachable: false };
    await controller.handlePermissionsChanged();

    expect(controller.runtimeSignals().mediaStates).toEqual({});
    expect(controller.runtimeSignals().mediaUnreachableTabIds).toEqual([7]);
  });

  it('forgets an unreachable page once it navigates or closes', async () => {
    const { controller } = controllerHarness({ inspect: async () => ({ reachable: false }) });
    await controller.handleTabUpdated(7, { audible: true }, mediaTab);

    controller.markNavigation(7);
    expect(controller.runtimeSignals().mediaUnreachableTabIds).toEqual([]);

    await controller.reinspect(7);
    expect(controller.runtimeSignals().mediaUnreachableTabIds).toEqual([7]);
    controller.removeTab(7);
    expect(controller.runtimeSignals().mediaUnreachableTabIds).toEqual([]);
  });

  it('keeps what it knew about reaching a page when an inspection fails outright', async () => {
    const inspect = vi.fn<(tabId: number) => Promise<TabMediaInspection>>()
      .mockResolvedValueOnce({ reachable: false })
      .mockRejectedValueOnce(new Error('Inspection failed'));
    const { controller } = controllerHarness({ inspect });
    await controller.handleTabUpdated(7, { audible: true }, mediaTab);

    await controller.reinspect(7);

    expect(inspect).toHaveBeenCalledTimes(2);
    expect(controller.runtimeSignals().mediaUnreachableTabIds).toEqual([7]);
  });
});