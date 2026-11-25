import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBrowserCommandIntentHandlers } from './browserCommandIntentHandlers';
import type { HyperModelPortClient } from './modelPort';

const client: HyperModelPortClient = {
  clientId: 'sidebar-client',
  role: 'sidebar',
  windowId: 3,
};

const queueMutation = <Result,>(operation: () => Promise<Result>) => operation();

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('browser command intent handlers', () => {
  it('runs palette tab and window effects through the background mutation lane', async () => {
    const create = vi.fn(async () => ({ id: 9 }));
    const get = vi.fn(async () => ({ id: 3, state: 'normal' }));
    const updateWindow = vi.fn(async () => undefined);
    const restore = vi.fn(async () => undefined);
    const update = vi.fn(async () => undefined);
    const reload = vi.fn(async () => undefined);
    const goBack = vi.fn(async () => undefined);
    const goForward = vi.fn(async () => undefined);
    const getZoom = vi.fn(async () => 1);
    const setZoom = vi.fn(async () => undefined);
    vi.stubGlobal('browser', {
      sessions: { restore },
      tabs: { getZoom, goBack, goForward, reload, setZoom, update },
      windows: { create, get, update: updateWindow },
    });
    const handlers = createBrowserCommandIntentHandlers({ queueMutation });

    await handlers.createWindow!.run({}, client);
    await handlers.createWindow!.run({ incognito: true }, client);
    await handlers.restoreClosedTab!.run({}, client);
    await handlers.restoreClosedTab!.run({ sessionId: 'closed-7' }, client);
    await handlers.setTabPinned!.run({ pinned: true, tabId: 7 }, client);
    await handlers.detachTab!.run({ tabId: 7 }, client);
    await handlers.reloadTab!.run({ tabId: 7 }, client);
    await handlers.navigateTabHistory!.run({ direction: 'back', tabId: 7 }, client);
    await handlers.navigateTabHistory!.run({ direction: 'forward', tabId: 7 }, client);
    await handlers.setTabZoom!.run({ mode: 'in', tabId: 7 }, client);
    await handlers.setTabZoom!.run({ mode: 'out', tabId: 7 }, client);
    await handlers.setTabZoom!.run({ mode: 'reset', tabId: 7 }, client);
    await handlers.toggleWindowFullscreen!.run({}, client);

    expect(create).toHaveBeenNthCalledWith(1, {});
    expect(create).toHaveBeenNthCalledWith(2, { incognito: true });
    expect(create).toHaveBeenNthCalledWith(3, { tabId: 7 });
    expect(restore).toHaveBeenNthCalledWith(1, undefined);
    expect(restore).toHaveBeenNthCalledWith(2, 'closed-7');
    expect(update).toHaveBeenCalledWith(7, { pinned: true });
    expect(reload).toHaveBeenCalledWith(7);
    expect(goBack).toHaveBeenCalledWith(7);
    expect(goForward).toHaveBeenCalledWith(7);
    expect(setZoom).toHaveBeenNthCalledWith(1, 7, 1.1);
    expect(setZoom).toHaveBeenNthCalledWith(2, 7, 0.9);
    expect(setZoom).toHaveBeenNthCalledWith(3, 7, 1);
    expect(get).toHaveBeenCalledWith(3);
    expect(updateWindow).toHaveBeenCalledWith(3, { state: 'fullscreen' });
    expect(handlers.detachTab!.targets({ tabId: 7 }, client))
      .toEqual(['tab:7', 'window:3']);
  });

  it('rejects malformed and unsupported commands before their effects run', async () => {
    vi.stubGlobal('browser', { tabs: {} });
    const handlers = createBrowserCommandIntentHandlers({ queueMutation });

    expect(() => handlers.setTabZoom!.targets({ mode: 'nearby', tabId: 7 }, client)).toThrow();
    await expect(handlers.restoreClosedTab!.run({}, client))
      .rejects.toThrow('Restoring closed tabs is unavailable');
    await expect(handlers.navigateTabHistory!.run({ direction: 'back', tabId: 7 }, client))
      .rejects.toThrow('Page back navigation is unavailable');
    await expect(handlers.setTabZoom!.run({ mode: 'in', tabId: 7 }, client))
      .rejects.toThrow('Page zoom is unavailable');
  });
});