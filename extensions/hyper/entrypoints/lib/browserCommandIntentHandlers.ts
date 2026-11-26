import type { HyperActionKind } from './modelActions';
import { intentHandler, runEachItem, type HyperIntentHandlers } from './modelIntents';
import {
  parseCreateWindowPayload,
  parseDetachTabPayload,
  parseNavigateTabHistoryPayload,
  parseReloadTabItems,
  parseRestoreClosedTabPayload,
  parseSetTabPinnedPayload,
  parseSetTabZoomPayload,
  parseToggleWindowFullscreenPayload,
} from './modelIntentPayloads';
import { tabTarget, windowTarget } from './modelGuards';

type BrowserCommandIntentKind = Extract<HyperActionKind,
  | 'createWindow'
  | 'detachTab'
  | 'navigateTabHistory'
  | 'reloadTab'
  | 'restoreClosedTab'
  | 'setTabPinned'
  | 'setTabZoom'
  | 'toggleWindowFullscreen'
>;

interface RuntimeTabCommands {
  getZoom?: (tabId?: number) => Promise<number>;
  goBack?: (tabId: number) => Promise<void>;
  goForward?: (tabId: number) => Promise<void>;
  setZoom?: (tabId: number, zoomFactor: number) => Promise<void>;
}

interface RuntimeSessions {
  restore?: (sessionId?: string) => Promise<unknown>;
}

export interface BrowserCommandIntentHandlerDependencies {
  queueMutation<Result>(operation: () => Promise<Result>): Promise<Result>;
}

function nextZoom(mode: 'in' | 'out' | 'reset', current: number): number {
  if (mode === 'in') return Math.min(5, Math.round((current + 0.1) * 10) / 10);
  if (mode === 'out') return Math.max(0.25, Math.round((current - 0.1) * 10) / 10);
  return 1;
}

export function createBrowserCommandIntentHandlers(
  dependencies: BrowserCommandIntentHandlerDependencies,
): Pick<HyperIntentHandlers, BrowserCommandIntentKind> {
  return {
    createWindow: intentHandler({
      parse: parseCreateWindowPayload,
      run: ({ incognito }) => dependencies.queueMutation(() => browser.windows.create(
        incognito ? { incognito: true } : {},
      )),
      targets: (_payload, client) => [windowTarget(client.windowId)],
    }),
    detachTab: intentHandler({
      parse: parseDetachTabPayload,
      run: ({ tabId }) => dependencies.queueMutation(
        () => browser.windows.create({ tabId }),
      ),
      targets: ({ tabId }, client) => [tabTarget(tabId), windowTarget(client.windowId)],
    }),
    navigateTabHistory: intentHandler({
      parse: parseNavigateTabHistoryPayload,
      run: ({ direction, tabId }) => dependencies.queueMutation(async () => {
        const tabs = browser.tabs as unknown as RuntimeTabCommands;
        if (direction === 'back') {
          if (!tabs.goBack) throw new Error('Page back navigation is unavailable in this browser.');
          await tabs.goBack(tabId);
          return;
        }
        if (!tabs.goForward) throw new Error('Page forward navigation is unavailable in this browser.');
        await tabs.goForward(tabId);
      }),
      targets: ({ tabId }) => [tabTarget(tabId)],
    }),
    reloadTab: intentHandler({
      parse: parseReloadTabItems,
      run: (reloads) => dependencies.queueMutation(
        () => runEachItem(reloads, ({ tabId }) => browser.tabs.reload(tabId)),
      ),
      targets: (reloads) => reloads.items.map(({ tabId }) => tabTarget(tabId)),
    }),
    restoreClosedTab: intentHandler({
      parse: parseRestoreClosedTabPayload,
      run: ({ sessionId }) => dependencies.queueMutation(async () => {
        const sessions = (browser as unknown as { sessions?: RuntimeSessions }).sessions;
        if (!sessions?.restore) throw new Error('Restoring closed tabs is unavailable in this browser.');
        await sessions.restore(sessionId);
      }),
      targets: (_payload, client) => [windowTarget(client.windowId)],
    }),
    setTabPinned: intentHandler({
      parse: parseSetTabPinnedPayload,
      run: ({ pinned, tabId }) => dependencies.queueMutation(
        () => browser.tabs.update(tabId, { pinned }),
      ),
      targets: ({ tabId }) => [tabTarget(tabId)],
    }),
    setTabZoom: intentHandler({
      parse: parseSetTabZoomPayload,
      run: ({ mode, tabId }) => dependencies.queueMutation(async () => {
        const tabs = browser.tabs as unknown as RuntimeTabCommands;
        if (!tabs.getZoom || !tabs.setZoom) {
          throw new Error('Page zoom is unavailable in this browser.');
        }
        const current = await tabs.getZoom(tabId);
        await tabs.setZoom(tabId, nextZoom(mode, current));
      }),
      targets: ({ tabId }) => [tabTarget(tabId)],
    }),
    toggleWindowFullscreen: intentHandler({
      parse: parseToggleWindowFullscreenPayload,
      run: (_payload, client) => dependencies.queueMutation(async () => {
        const current = await browser.windows.get(client.windowId);
        await browser.windows.update(client.windowId, {
          state: current.state === 'fullscreen' ? 'normal' : 'fullscreen',
        });
      }),
      targets: (_payload, client) => [windowTarget(client.windowId)],
    }),
  };
}