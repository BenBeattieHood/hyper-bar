import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  commitHyperModelAtom,
  createHyperModelStore,
  emptyBrowserObservation,
  emptyRuntimeMetadata,
  type HyperModelSources,
} from './model';
import { defaultHyperPreferences } from './preferences';
import { createTabContentController } from './tabContentController';

afterEach(() => vi.unstubAllGlobals());

function sources(
  pageTextSearch: boolean,
  status: Browser.tabs.Tab['status'] = 'complete',
): HyperModelSources {
  return {
    browser: {
      ...emptyBrowserObservation,
      tabs: [{ id: 7, status, url: 'https://example.test' } as Browser.tabs.Tab],
    },
    runtime: {
      ...emptyRuntimeMetadata,
      preferences: { ...defaultHyperPreferences, pageTextSearch },
      tabContentVersions: { 7: 4 },
    },
  };
}

function controllerHarness(initial: HyperModelSources) {
  const store = createHyperModelStore(initial);
  const reconcile = vi.fn(async () => undefined);
  const controller = createTabContentController({ reconcile, store });
  const commit = async (next: HyperModelSources) => {
    store.set(commitHyperModelAtom, { sources: next });
    await controller.refresh();
  };
  return { commit, controller, reconcile };
}

const capturedPage = { text: 'A captured page', url: 'https://example.test' };

describe('tab content controller', () => {
  it('reads no page while page text search is off', async () => {
    const sendMessage = vi.fn(async () => capturedPage);
    vi.stubGlobal('browser', { tabs: { sendMessage } });
    const { controller, reconcile } = controllerHarness(sources(false));

    await controller.refresh();

    expect(sendMessage).not.toHaveBeenCalled();
    expect(controller.runtimeSignals().contentSnapshots).toEqual({});
    expect(reconcile).not.toHaveBeenCalled();
  });

  it('captures open pages once page text search is on and clears them when it goes off', async () => {
    const sendMessage = vi.fn(async () => capturedPage);
    vi.stubGlobal('browser', { tabs: { sendMessage } });
    const { commit, controller, reconcile } = controllerHarness(sources(false));

    await commit(sources(true));
    expect(controller.runtimeSignals().contentSnapshots).toEqual({
      7: { ...capturedPage, navigationVersion: 4 },
    });

    await commit(sources(false));
    expect(controller.runtimeSignals().contentSnapshots).toEqual({});
    expect(reconcile).toHaveBeenCalledTimes(2);
  });

  it('asks a page again once it loads when its script was not yet listening', async () => {
    const sendMessage = vi.fn()
      .mockRejectedValueOnce(new Error('Could not establish connection. Receiving end does not exist.'))
      .mockResolvedValue(capturedPage);
    vi.stubGlobal('browser', { tabs: { sendMessage } });
    const { commit, controller } = controllerHarness(sources(false));

    await commit(sources(true, 'loading'));
    await commit(sources(true, 'loading'));
    expect(sendMessage).toHaveBeenCalledOnce();

    await commit(sources(true, 'complete'));
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(controller.runtimeSignals().contentSnapshots).toEqual({
      7: { ...capturedPage, navigationVersion: 4 },
    });
  });
});
