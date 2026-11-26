import { sessionStorageArea, type SessionStorageArea } from './sessionValues';
import {
  clampInPageSidebarWidth,
  inPageSidebarStateType,
  isInPageSidebarRequest,
  type InPageSidebarState,
} from './inPageSidebarProtocol';

const TOKENS_KEY = 'hyperInPageSidebarTokens';
// A reloading sidebar drops and reclaims its port; pages should not flash the mark meanwhile.
export const NATIVE_SIDEBAR_SETTLE_MS = 1_000;

export interface InPageSidebarControllerDependencies {
  enabled(): boolean;
  frameUrl?(token: string): string;
  /**
   * Settles once the model holds the user's preferences. A page can wake the
   * worker, which starts on the seed model and so would read the setting as off.
   */
  modelRead: Promise<void>;
  notifyTab?(tabId: number, state: InPageSidebarState): Promise<unknown>;
  /** Persists a width the user dragged a page's sidebar to. */
  saveWidth(width: number): Promise<void>;
  session?: Pick<SessionStorageArea, 'get' | 'set'>;
  tabIdsInWindow?(windowId: number): Promise<number[]>;
  width(): number;
  windowIds?(): Promise<number[]>;
}

export interface InPageSidebarController {
  authorize(tabId: number, token: string): boolean;
  handleMessage(
    message: unknown,
    sender: Pick<Browser.runtime.MessageSender, 'frameId' | 'tab'>,
  ): Promise<InPageSidebarState> | undefined;
  nativeSidebarPresence(windowId: number, present: boolean): void;
  /** Tokens are restored before any frame may reconnect with one. */
  ready: Promise<void>;
  refresh(): void;
  removeTab(tabId: number): void;
}

const tabIds = (tabs: Browser.tabs.Tab[]) =>
  tabs.flatMap((tab) => tab.id === undefined ? [] : [tab.id]);

/**
 * Offers the sidebar inside webpages while the browser's own sidebar is closed.
 *
 * Any website can frame `inpage.html`, so a frame is admitted only with the
 * token issued to Hyper's content script in that tab.
 */
export function createInPageSidebarController(
  dependencies: InPageSidebarControllerDependencies,
): InPageSidebarController {
  const frameUrl = dependencies.frameUrl ?? ((token) =>
    `${browser.runtime.getURL('/inpage.html')}?token=${encodeURIComponent(token)}`);
  const notifyTab = dependencies.notifyTab ??
    ((tabId, state) => browser.tabs.sendMessage(tabId, state, { frameId: 0 }));
  const tabIdsInWindow = dependencies.tabIdsInWindow ??
    (async (windowId) => tabIds(await browser.tabs.query({ windowId })));
  const windowIds = dependencies.windowIds ?? (async () =>
    (await browser.windows.getAll()).flatMap((window) => window.id === undefined ? [] : [window.id]));
  const session = dependencies.session ?? sessionStorageArea();
  const nativeSidebarWindows = new Set<number>();
  const settling = new Map<number, ReturnType<typeof setTimeout>>();
  const announced = new Map<number, string>();
  const tokens = new Map<number, string>();
  let enabled = dependencies.enabled();
  let width = dependencies.width();

  const ready = (session?.get(TOKENS_KEY) ?? Promise.resolve({} as Record<string, unknown>)).then((stored) => {
    const saved = stored[TOKENS_KEY];
    if (!saved || typeof saved !== 'object') return;
    for (const [tabId, token] of Object.entries(saved)) {
      if (typeof token === 'string' && !tokens.has(Number(tabId))) tokens.set(Number(tabId), token);
    }
  }).catch(() => undefined);
  const persist = () => void session?.set({ [TOKENS_KEY]: Object.fromEntries(tokens) })
    .catch(() => undefined);
  const answerable = Promise.all([ready, dependencies.modelRead]);
  const available = (windowId: number) =>
    dependencies.enabled() && !nativeSidebarWindows.has(windowId);
  const stateIn = (windowId: number): InPageSidebarState => available(windowId)
    ? { available: true, type: inPageSidebarStateType, width: dependencies.width() }
    : { available: false, type: inPageSidebarStateType };
  const announce = async (windowId: number) => {
    const state = stateIn(windowId);
    const key = JSON.stringify(state);
    if (announced.get(windowId) === key) return;
    announced.set(windowId, key);
    for (const tabId of await tabIdsInWindow(windowId).catch(() => [])) {
      void notifyTab(tabId, state).catch(() => undefined);
    }
  };

  return {
    authorize: (tabId, token) => tokens.get(tabId) === token,
    handleMessage(message, sender) {
      if (!isInPageSidebarRequest(message)) return undefined;
      const tab = sender.tab;
      if (tab?.id === undefined || sender.frameId !== 0 || tab.incognito) {
        return Promise.resolve({ available: false, type: inPageSidebarStateType });
      }
      return answerable.then(async (): Promise<InPageSidebarState> => {
        const state = stateIn(tab.windowId);
        if (!state.available || message.action === 'query') return state;
        if (message.action === 'resize') {
          const resized = clampInPageSidebarWidth(message.width);
          await dependencies.saveWidth(resized);
          return { ...state, width: resized };
        }
        let token = tokens.get(tab.id as number);
        if (!token) {
          token = crypto.randomUUID();
          tokens.set(tab.id as number, token);
          persist();
        }
        return { ...state, url: frameUrl(token) };
      });
    },
    nativeSidebarPresence(windowId, present) {
      clearTimeout(settling.get(windowId));
      settling.delete(windowId);
      if (present) {
        nativeSidebarWindows.add(windowId);
        void announce(windowId);
        return;
      }
      nativeSidebarWindows.delete(windowId);
      settling.set(windowId, setTimeout(() => {
        settling.delete(windowId);
        void announce(windowId);
      }, NATIVE_SIDEBAR_SETTLE_MS));
    },
    ready,
    refresh() {
      const next = { enabled: dependencies.enabled(), width: dependencies.width() };
      if (next.enabled === enabled && next.width === width) return;
      ({ enabled, width } = next);
      void windowIds().then((ids) => ids.forEach((windowId) => void announce(windowId)))
        .catch(() => undefined);
    },
    removeTab(tabId) {
      if (tokens.delete(tabId)) persist();
    },
  };
}
