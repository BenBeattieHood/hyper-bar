import { isRecord } from './collections';
import { sessionStorageArea } from './sessionValues';
import { createCoalescedAsyncRunner } from './async';
import type { BrowserTab } from './bookmarks';
import type { MediaController } from './mediaController';
import { mediaTargetForWindow, nowPlayingTab, tabMediaUrl } from './mediaState';
import { hyperModelAtom, type HyperModelSnapshot, type HyperModelStore } from './model';
import { scriptingReady, usesScriptingPermission } from './scriptingAccess';
import type { TimedMessages } from './timedMessages';
import { isHttpProtocol } from './urlIdentity';

/** How long Hyper waits before offering a site's access again while play and pause stay broken there. */
export const MEDIA_ACCESS_OFFER_INTERVAL_MS = 5 * 60_000;
// When each site was last offered, kept while the background sleeps.
const OFFERED_SITES_KEY = 'hyperMediaAccessOffers';

interface MediaSite {
  access: Browser.permissions.Permissions;
  host: string;
  origin: string;
}

interface ShownOffer {
  messageId: string;
  site: MediaSite;
  tabId: number;
}

export interface MediaAccessOffersDependencies {
  media: Pick<MediaController, 'reinspect'>;
  messages: Pick<TimedMessages, 'current' | 'dismiss' | 'offer'>;
  /** Settles once a newly granted scripting API can be used, however that turns out. */
  scriptingReady?: () => Promise<unknown>;
  store: HyperModelStore;
}

export interface MediaAccessOffers {
  /** Looks at every window now. Store commits and the offer interval look again on their own. */
  evaluate(): Promise<void>;
}

/** The access that lets Hyper script one site's pages once their own script is gone. */
export function mediaSiteAccess(url: string | undefined): MediaSite | undefined {
  if (!url) return undefined;
  try {
    const { hostname, protocol } = new URL(url);
    if (!isHttpProtocol(protocol) || !hostname) return undefined;
    const origin = `${protocol}//${hostname}/*`;
    return { access: { origins: [origin], permissions: ['scripting'] }, host: hostname, origin };
  } catch {
    return undefined;
  }
}

function nowPlaying(snapshot: HyperModelSnapshot, windowId: number): BrowserTab | undefined {
  const { tabs } = snapshot.browser;
  const { mediaRetainedTabIds, mediaStates } = snapshot.runtime;
  return nowPlayingTab(
    tabs,
    windowId,
    mediaTargetForWindow(tabs, windowId, mediaStates, mediaRetainedTabIds),
    mediaRetainedTabIds[windowId],
  );
}

/**
 * Now Playing's tab in a window when it can offer only mute, because Hyper can
 * neither reach the page's own script nor script the page itself.
 */
function unreachableMediaTab(snapshot: HyperModelSnapshot, windowId: number): BrowserTab | undefined {
  const tab = nowPlaying(snapshot, windowId);
  return tab?.id !== undefined &&
    snapshot.runtime.mediaStates[tab.id] === undefined &&
    snapshot.runtime.mediaUnreachableTabIds.includes(tab.id)
    ? tab
    : undefined;
}

function parseOfferedSites(value: unknown): Record<string, number> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(
    (entry): entry is [string, number] => Number.isFinite(entry[1]),
  ));
}

/**
 * Chrome does not run Hyper's page script again in pages already open when
 * Hyper reloads, so Now Playing can only mute them. This offers the one fix
 * that needs no page reload: access to script that site. It offers again every
 * five minutes while the page stays out of reach, and only ever into a window
 * showing no other message.
 */
export function createMediaAccessOffers(
  dependencies: MediaAccessOffersDependencies,
): MediaAccessOffers {
  if (!usesScriptingPermission() || !browser.permissions?.request) {
    return { evaluate: async () => undefined };
  }
  const whenScriptingReady = dependencies.scriptingReady ?? scriptingReady;
  const shown = new Map<number, ShownOffer>();
  let wakeTimer: ReturnType<typeof setTimeout> | undefined;
  const offeredSites = (async () => {
    const stored = await sessionStorageArea()?.get(OFFERED_SITES_KEY).catch(() => undefined);
    return parseOfferedSites(stored?.[OFFERED_SITES_KEY]);
  })();
  // A site Hyper cannot check is left alone rather than offered blind.
  const allowed = (site: MediaSite) =>
    browser.permissions.contains(site.access).catch(() => true);

  /** Asks for the site while the press still counts as the user's gesture, then looks at the page again. */
  const fix = (tabId: number, site: MediaSite) => async () => {
    const granted = await browser.permissions.request(site.access);
    if (!granted) throw new Error(`Hyper was not allowed on ${site.host}.`);
    await whenScriptingReady();
    const inspection = await dependencies.media.reinspect(tabId);
    if (inspection.target) return;
    throw new Error(inspection.reachable
      ? `Hyper found no player it can control on ${site.host}.`
      : `Hyper still can't reach ${site.host}. Reload the page to fix play/pause.`);
  };

  /**
   * Takes an offer down only on evidence the page is fine now, never on a
   * passing gap in what Hyper knows, such as just after the page changes its address.
   */
  const settled = async (offer: ShownOffer, windowId: number) => {
    const snapshot = dependencies.store.get(hyperModelAtom);
    if (snapshot.runtime.mediaStates[offer.tabId]) return true;
    const tab = nowPlaying(snapshot, windowId);
    if (tab && tab.id !== offer.tabId) return true;
    return allowed(offer.site);
  };

  const evaluate = createCoalescedAsyncRunner(async () => {
    const sites = await offeredSites;
    const snapshot = dependencies.store.get(hyperModelAtom);
    const now = Date.now();
    let sitesChanged = false;
    for (const [origin, offeredAt] of Object.entries(sites)) {
      if (offeredAt > now - MEDIA_ACCESS_OFFER_INTERVAL_MS && offeredAt <= now) continue;
      delete sites[origin];
      sitesChanged = true;
    }
    const windowIds = new Set(shown.keys());
    for (const tabId of snapshot.runtime.mediaUnreachableTabIds) {
      const tab = snapshot.browser.tabs.find((candidate) => candidate.id === tabId);
      if (tab) windowIds.add(tab.windowId);
    }
    for (const windowId of windowIds) {
      const offer = shown.get(windowId);
      if (offer && dependencies.messages.current(windowId)?.id === offer.messageId) {
        if (await settled(offer, windowId)) {
          dependencies.messages.dismiss(windowId, offer.messageId);
          shown.delete(windowId);
        }
        continue;
      }
      shown.delete(windowId);
      // Another message keeps its window; its expiry commits and looks here again.
      if (dependencies.messages.current(windowId)) continue;
      const tab = unreachableMediaTab(snapshot, windowId);
      const site = mediaSiteAccess(tab && tabMediaUrl(tab));
      if (tab?.id === undefined || !site || sites[site.origin] !== undefined) continue;
      if (await allowed(site)) continue;
      // The window may have moved on while the browser answered.
      if (
        dependencies.messages.current(windowId) ||
        unreachableMediaTab(dependencies.store.get(hyperModelAtom), windowId)?.id !== tab.id
      ) continue;
      const messageId = dependencies.messages.offer(windowId, {
        act: fix(tab.id, site),
        detail: `Allow Hyper to control media on ${site.host}`,
        gesture: true,
        kind: 'opt-in',
        tabId: tab.id,
        text: 'Fix play/pause?',
      });
      shown.set(windowId, { messageId, site, tabId: tab.id });
      sites[site.origin] = now;
      sitesChanged = true;
    }
    if (sitesChanged) {
      void sessionStorageArea()?.set({ [OFFERED_SITES_KEY]: { ...sites } }).catch(() => undefined);
    }
    // Wakes as the oldest offer falls due, in case nothing else commits by then.
    const wakeAt = Math.min(...Object.values(sites).map((offeredAt) =>
      offeredAt + MEDIA_ACCESS_OFFER_INTERVAL_MS));
    clearTimeout(wakeTimer);
    wakeTimer = Number.isFinite(wakeAt)
      ? setTimeout(() => void run(), Math.max(0, wakeAt - Date.now()))
      : undefined;
  });
  const run = () => evaluate().catch((error) => {
    console.error('Unable to offer media access.', error);
  });
  dependencies.store.sub(hyperModelAtom, () => void run());
  return { evaluate };
}
