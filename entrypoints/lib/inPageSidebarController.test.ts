import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createInPageSidebarController,
  NATIVE_SIDEBAR_SETTLE_MS,
} from './inPageSidebarController';
import { inPageSidebarRequestType, inPageSidebarStateType } from './inPageSidebarProtocol';
import { fakeStorageArea } from './testFixtures';

afterEach(() => {
  vi.useRealTimers();
});

const sender = (tabId: number, windowId = 1, frameId = 0) => ({
  frameId,
  tab: { id: tabId, incognito: false, windowId } as Browser.tabs.Tab,
});
const open = { action: 'open', type: inPageSidebarRequestType } as const;
const query = { action: 'query', type: inPageSidebarRequestType } as const;

function setup(
  enabled = true,
  stored: Record<string, string> = {},
  modelRead: Promise<void> = Promise.resolve(),
) {
  let preference = enabled;
  let width = 360;
  const session = fakeStorageArea({ hyperInPageSidebarTokens: stored });
  const notifyTab = vi.fn(async () => undefined);
  const saveWidth = vi.fn(async () => undefined);
  const controller = createInPageSidebarController({
    enabled: () => preference,
    frameUrl: (token) => `inpage.html?token=${token}`,
    modelRead,
    notifyTab,
    saveWidth,
    session,
    tabIdsInWindow: async (windowId) => (windowId === 1 ? [10, 11] : [20]),
    width: () => width,
    windowIds: async () => [1, 2],
  });
  return {
    controller,
    notifyTab,
    saved: session.values,
    saveWidth,
    setEnabled: (next: boolean) => { preference = next; },
    setWidth: (next: number) => { width = next; },
  };
}

const shown = { available: true, type: inPageSidebarStateType, width: 360 };

describe('in-page sidebar controller', () => {
  it('issues a frame token only to a top-level page while the setting is on', async () => {
    const { controller, saved } = setup();

    const state = await controller.handleMessage(open, sender(10));

    const token = state?.url?.split('token=')[1];
    expect(state).toMatchObject(shown);
    expect(token).toBeTruthy();
    expect(controller.authorize(10, token as string)).toBe(true);
    expect(controller.authorize(11, token as string)).toBe(false);
    expect(saved.get('hyperInPageSidebarTokens')).toEqual({ 10: token });
    await expect(controller.handleMessage(open, sender(10, 1, 3)))
      .resolves.toEqual({ available: false, type: inPageSidebarStateType });
    expect(controller.handleMessage({ type: 'other' }, sender(10))).toBeUndefined();

    controller.removeTab(10);
    expect(controller.authorize(10, token as string)).toBe(false);
  });

  it('keeps tokens across a worker restart', async () => {
    const { controller } = setup(true, { 10: 'restored-token' });
    await controller.ready;

    expect(controller.authorize(10, 'restored-token')).toBe(true);
  });

  it('withholds the sidebar while the setting is off', async () => {
    const { controller } = setup(false);

    await expect(controller.handleMessage(open, sender(10)))
      .resolves.toEqual({ available: false, type: inPageSidebarStateType });
  });

  it('answers a page that woke the worker only once the model has read the setting', async () => {
    let markRead!: () => void;
    const { controller, setEnabled } = setup(
      false,
      {},
      new Promise((resolve) => { markRead = resolve; }),
    );
    let answered = false;

    const state = controller.handleMessage(open, sender(10));
    void state?.then(() => { answered = true; });
    await controller.ready;
    expect(answered).toBe(false);

    setEnabled(true);
    markRead();
    await expect(state).resolves.toMatchObject({ available: true, url: expect.any(String) });
  });

  it('hides the mark at once when the browser sidebar opens and shows it once a close settles', async () => {
    vi.useFakeTimers();
    const { controller, notifyTab } = setup();

    controller.nativeSidebarPresence(1, true);
    await vi.waitFor(() => expect(notifyTab).toHaveBeenCalledTimes(2));
    expect(notifyTab).toHaveBeenCalledWith(10, { available: false, type: inPageSidebarStateType });
    await expect(controller.handleMessage(query, sender(10)))
      .resolves.toEqual({ available: false, type: inPageSidebarStateType });

    controller.nativeSidebarPresence(1, false);
    controller.nativeSidebarPresence(1, true);
    vi.advanceTimersByTime(NATIVE_SIDEBAR_SETTLE_MS);
    expect(notifyTab).toHaveBeenCalledTimes(2);

    controller.nativeSidebarPresence(1, false);
    vi.advanceTimersByTime(NATIVE_SIDEBAR_SETTLE_MS);
    await vi.waitFor(() => expect(notifyTab).toHaveBeenCalledTimes(4));
    expect(notifyTab).toHaveBeenLastCalledWith(11, shown);
  });

  it('saves a width a page was resized to and answers with it', async () => {
    const { controller, saveWidth } = setup();
    const resize = (width: number, from = sender(10)) => controller.handleMessage(
      { action: 'resize', type: inPageSidebarRequestType, width },
      from,
    );

    await expect(resize(480.4)).resolves.toEqual({ ...shown, width: 480 });
    await expect(resize(10)).resolves.toEqual({ ...shown, width: 38 });
    await expect(resize(480, sender(10, 1, 3)))
      .resolves.toEqual({ available: false, type: inPageSidebarStateType });

    expect(saveWidth.mock.calls).toEqual([[480], [38]]);
    expect(controller.handleMessage(
      { action: 'resize', type: inPageSidebarRequestType, width: 'wide' },
      sender(10),
    )).toBeUndefined();
  });

  it('tells every window when the saved width changes', async () => {
    const { controller, notifyTab, setWidth } = setup();

    setWidth(480);
    controller.refresh();

    await vi.waitFor(() => expect(notifyTab).toHaveBeenCalledTimes(3));
    expect(notifyTab).toHaveBeenCalledWith(20, { ...shown, width: 480 });
  });

  it('tells every window when the setting changes', async () => {
    const { controller, notifyTab, setEnabled } = setup(false);

    setEnabled(true);
    controller.refresh();

    await vi.waitFor(() => expect(notifyTab).toHaveBeenCalledTimes(3));
    expect(notifyTab).toHaveBeenCalledWith(20, shown);
  });
});
