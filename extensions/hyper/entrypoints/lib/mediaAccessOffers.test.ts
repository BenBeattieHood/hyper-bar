import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createHyperModelStore,
  emptyBrowserObservation,
  emptyRuntimeMetadata,
  type RuntimeMetadata,
} from './model';
import {
  createMediaAccessOffers,
  MEDIA_ACCESS_OFFER_INTERVAL_MS,
  mediaSiteAccess,
} from './mediaAccessOffers';
import type { TabMediaInspection } from './mediaControl';
import type { HyperModelPortClient } from './modelPort';
import { commitTestSources, fakeStorageArea } from './testFixtures';
import { createTimedMessages } from './timedMessages';

const client: HyperModelPortClient = {
  clientId: 'sidebar-client',
  role: 'sidebar',
  windowId: 3,
};

const musicTab = {
  audible: true,
  id: 7,
  url: 'https://music.example.test/watch?v=1',
  windowId: 3,
} as Browser.tabs.Tab;

const siteAccess = { origins: ['https://music.example.test/*'], permissions: ['scripting'] };
const offersKey = 'hyperMediaAccessOffers';
const unreachable: Partial<RuntimeMetadata> = { mediaUnreachableTabIds: [7] };
const playing = {
  elementIndex: 0,
  frameId: 0,
  navigationVersion: 0,
  state: 'playing' as const,
  tabId: 7,
  url: musicTab.url!,
};

function harness(options: {
  granted?: boolean;
  runtime?: Partial<RuntimeMetadata>;
  scripting?: boolean;
  stored?: Record<string, unknown>;
  tabs?: Browser.tabs.Tab[];
} = {}) {
  const contains = vi.fn(async (_access: Browser.permissions.Permissions) => options.granted ?? false);
  const request = vi.fn(async (_access: Browser.permissions.Permissions) => true);
  const session = fakeStorageArea(options.stored);
  const { set } = session;
  vi.stubGlobal('browser', {
    permissions: { contains, request },
    runtime: {
      getManifest: () => ({ optional_permissions: options.scripting === false ? [] : ['scripting'] }),
    },
    storage: { session },
  });
  vi.stubGlobal('chrome', {});
  const sources = (tabs: Browser.tabs.Tab[], runtime: Partial<RuntimeMetadata>) => ({
    browser: { ...emptyBrowserObservation, tabs },
    runtime: { ...emptyRuntimeMetadata, ...runtime },
  });
  const store = createHyperModelStore(sources(options.tabs ?? [musicTab], options.runtime ?? unreachable));
  const messages = createTimedMessages({ reconcile: async () => undefined });
  const reinspect = vi.fn(async (_tabId: number): Promise<TabMediaInspection> => ({
    reachable: true,
    target: playing,
  }));
  const scriptingReady = vi.fn(async () => true);
  const offers = createMediaAccessOffers({ media: { reinspect }, messages, scriptingReady, store });
  const commit = (tabs: Browser.tabs.Tab[], runtime: Partial<RuntimeMetadata>) =>
    commitTestSources(store, { tabs }, runtime);
  const press = (messageId: string) => {
    const handler = messages.handlers.actOnTimedMessage;
    const payload = { messageId };
    return handler.run(payload, client, undefined, handler.admit!(payload, client));
  };
  return { commit, contains, messages, offers, press, reinspect, request, scriptingReady, set };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(60 * 60_000);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('media access offers', () => {
  it('names the access one site needs', () => {
    expect(mediaSiteAccess('https://music.example.test:8443/watch')).toEqual({
      access: siteAccess,
      host: 'music.example.test',
      origin: 'https://music.example.test/*',
    });
    expect(mediaSiteAccess('file:///music.mp3')).toBeUndefined();
    expect(mediaSiteAccess('not a url')).toBeUndefined();
  });

  it('offers to fix play and pause, asking for the site while the press still counts', async () => {
    const { messages, offers, press, reinspect, request, scriptingReady } = harness();

    await offers.evaluate();

    const offer = messages.current(3);
    expect(offer).toMatchObject({
      detail: 'Allow Hyper to control media on music.example.test',
      kind: 'opt-in',
      tabId: 7,
      text: 'Fix play/pause?',
    });
    const pressed = press(offer!.id);
    expect(request).toHaveBeenCalledWith(siteAccess);
    await pressed;
    expect(scriptingReady.mock.invocationCallOrder[0]).toBeLessThan(
      reinspect.mock.invocationCallOrder[0]!,
    );
    expect(reinspect).toHaveBeenCalledWith(7);
    expect(messages.current(3)).toBeUndefined();
  });

  it('says why play and pause are still broken after the press', async () => {
    const refused = harness();
    refused.request.mockResolvedValueOnce(false);
    await refused.offers.evaluate();

    await expect(refused.press(refused.messages.current(3)!.id))
      .rejects.toThrow('Hyper was not allowed on music.example.test.');
    expect(refused.messages.current(3)).toMatchObject({ tone: 'error' });
    expect(refused.reinspect).not.toHaveBeenCalled();

    const outOfReach = harness();
    outOfReach.reinspect.mockResolvedValueOnce({ reachable: false });
    await outOfReach.offers.evaluate();
    await expect(outOfReach.press(outOfReach.messages.current(3)!.id)).rejects.toThrow(
      "Hyper still can't reach music.example.test. Reload the page to fix play/pause.",
    );

    const noPlayer = harness();
    noPlayer.reinspect.mockResolvedValueOnce({ reachable: true });
    await noPlayer.offers.evaluate();
    await expect(noPlayer.press(noPlayer.messages.current(3)!.id))
      .rejects.toThrow('Hyper found no player it can control on music.example.test.');
  });

  it('offers again every five minutes while play and pause stay broken, never acting on expiry', async () => {
    const { messages, offers, request, set } = harness();
    await offers.evaluate();
    const first = messages.current(3)!;
    expect(set).toHaveBeenLastCalledWith({
      [offersKey]: { 'https://music.example.test/*': Date.now() },
    });

    await vi.advanceTimersByTimeAsync(first.durationMs);
    expect(messages.current(3)).toBeUndefined();
    await offers.evaluate();
    expect(messages.current(3)).toBeUndefined();
    expect(request).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(MEDIA_ACCESS_OFFER_INTERVAL_MS - first.durationMs);
    await offers.evaluate();

    expect(messages.current(3)).toMatchObject({ text: 'Fix play/pause?' });
    expect(messages.current(3)!.id).not.toBe(first.id);
  });

  it('keeps to the interval when the background wakes again', async () => {
    const { messages, offers } = harness({
      stored: { [offersKey]: { 'https://music.example.test/*': Date.now() - 60_000 } },
    });

    await offers.evaluate();
    expect(messages.current(3)).toBeUndefined();

    await vi.advanceTimersByTimeAsync(MEDIA_ACCESS_OFFER_INTERVAL_MS - 60_000);
    await offers.evaluate();
    expect(messages.current(3)).toMatchObject({ text: 'Fix play/pause?' });
  });

  it('waits for another message to go rather than covering it', async () => {
    const { contains, messages, offers } = harness();
    messages.notify(3, 'Moved to Work');

    await offers.evaluate();
    expect(messages.current(3)).toMatchObject({ text: 'Moved to Work' });

    await vi.advanceTimersByTimeAsync(messages.current(3)!.durationMs);
    contains.mockImplementationOnce(async () => {
      messages.notify(3, 'Closed 2 tabs');
      return false;
    });
    await offers.evaluate();
    expect(messages.current(3)).toMatchObject({ text: 'Closed 2 tabs' });

    await vi.advanceTimersByTimeAsync(messages.current(3)!.durationMs);
    await offers.evaluate();
    expect(messages.current(3)).toMatchObject({ text: 'Fix play/pause?' });
  });

  it('leaves alone a site Hyper may script, and a browser without the scripting permission', async () => {
    const granted = harness({ granted: true });
    await granted.offers.evaluate();
    expect(granted.messages.current(3)).toBeUndefined();

    const firefox = harness({ scripting: false });
    await firefox.offers.evaluate();
    expect(firefox.messages.current(3)).toBeUndefined();
    expect(firefox.contains).not.toHaveBeenCalled();
  });

  it('leaves alone a page Hyper reaches or Now Playing does not show', async () => {
    const reached = harness({ runtime: {} });
    await reached.offers.evaluate();
    expect(reached.messages.current(3)).toBeUndefined();

    const silent = harness({ tabs: [{ ...musicTab, audible: false }] });
    await silent.offers.evaluate();
    expect(silent.messages.current(3)).toBeUndefined();
  });

  it('takes its offer down once the page is fine, but not for a passing gap', async () => {
    const { commit, messages, offers } = harness();
    await offers.evaluate();

    commit([musicTab], {});
    await offers.evaluate();
    expect(messages.current(3)).toMatchObject({ text: 'Fix play/pause?' });

    commit([musicTab], { mediaStates: { 7: playing } });
    await offers.evaluate();
    expect(messages.current(3)).toBeUndefined();
  });

  it('takes its offer down once Now Playing moves to another tab or Hyper gains the site', async () => {
    const other = { ...musicTab, id: 8, url: 'https://radio.example.test/' };
    const moved = harness();
    await moved.offers.evaluate();

    moved.commit([musicTab, other], { ...unreachable, mediaRetainedTabIds: { 3: 8 } });
    await moved.offers.evaluate();
    expect(moved.messages.current(3)).toBeUndefined();

    const allowed = harness();
    await allowed.offers.evaluate();

    allowed.contains.mockResolvedValue(true);
    allowed.commit([musicTab], unreachable);
    await allowed.offers.evaluate();
    expect(allowed.messages.current(3)).toBeUndefined();
  });
});
