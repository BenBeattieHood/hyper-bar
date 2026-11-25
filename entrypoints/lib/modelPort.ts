import { addToMapSet, isRecord } from './collections';
import {
  hyperModelAtom,
  normalWindowTabs,
  type HyperModelSnapshot,
  type HyperModelStore,
} from './model';
import {
  commandStatusesForClient,
  type CommandStatus,
  type HyperActionKind,
} from './modelActions';
import { groupIdsForWindow, groupOwnerships, liveSpaceColours } from './groupOwnership';
import { shownSpaces, type BookmarkNode, type Space } from './bookmarks';
import { projectSharedDrag, type ProjectedSharedDrag } from './sharedDrag';
import { pageIdentity, tabPageIdentity, tabUrl } from './urlIdentity';
import {
  HYPER_BUILD_ID,
  HYPER_MODEL_PORT_NAME,
  HYPER_MODEL_PROTOCOL_VERSION,
  createDeliveryCursor,
  parseClientMessage,
  type HelloMessage,
  type HyperModelClientRole,
  type IntentMessage,
  type ProtocolErrorReason,
  type SearchQueryMessage,
  type ServerMessage,
} from './modelProtocol';
import type { SharedSearchResult } from './searchIndex';
import { activationSpaceId, type TabDisposition } from './tabDisposition';
import type { TabBookmarkLink, TabName } from './tabBookmarkLink';
import type { TimedMessage } from './timedMessages';
import { backgroundMusicTabIds, mediaTargetForWindow, type TabMediaState } from './mediaState';

export {
  HYPER_MODEL_PORT_NAME,
  HYPER_MODEL_PROTOCOL_VERSION,
  type HyperModelClientRole,
} from './modelProtocol';
import { normalWindowIds } from './windowState';

export interface ModelPortSender {
  tab?: { id?: number; incognito?: boolean; windowId?: number };
  url?: string;
}

export interface HyperWindowProjection {
  activeSpaceId?: string;
  /** Music-site tabs left out of the favourites bar's recent tabs while Now Playing is shown. */
  backgroundMusicTabIds: readonly number[];
  focused: boolean;
  groupIdsBySpace: Readonly<Record<string, number>>;
  incognito: boolean;
  mediaControlAvailable: boolean;
  mediaRetainedTabId?: number;
  mediaTarget?: TabMediaState;
  tabBookmarkLinks: Readonly<Record<number, Pick<TabBookmarkLink, 'bookmarkId' | 'drifted'>>>;
  tabDispositions: Readonly<Record<number, TabDisposition>>;
  tabNames: Readonly<Record<number, TabName>>;
  tabTitles: Readonly<Record<number, string>>;
  tabOwnerships: Readonly<Record<number, HyperModelSnapshot['runtime']['tabOwnerships'][number]>>;
  tabs: HyperModelSnapshot['browser']['tabs'];
  timedMessage?: TimedMessage;
  windowId: number;
}

/**
 * Cross-window presence is keyed only by entities the client already received.
 * It deliberately carries neither a remote tab record nor a remote page identity.
 */
export interface HyperRemoteSpacePresence {
  bookmarkSpaceIds: Readonly<Record<string, readonly string[]>>;
  /** How many tabs each space lists in other windows, which the end of its Tabs list reports. */
  otherWindowTabCounts: Readonly<Record<string, number>>;
  tabSpaceIds: Readonly<Record<number, readonly string[]>>;
}

export interface HyperSidebarProjection {
  /**
   * The raw tree travels with the derived model so a view renders exactly the
   * bookmarks the background reconciled, rather than re-reading the browser and
   * racing it.
   */
  bookmarkImportInProgress: boolean;
  bookmarkTree: HyperModelSnapshot['browser']['bookmarkTree'];
  commandCapabilities: HyperModelSnapshot['runtime']['commandCapabilities'];
  commands: readonly CommandStatus[];
  hyper: HyperModelSnapshot['hyper'];
  installationId?: string;
  preferences: HyperModelSnapshot['runtime']['preferences'];
  recentlyClosedTabs: HyperModelSnapshot['browser']['recentlyClosedTabs'];
  remoteSpacePresence: HyperRemoteSpacePresence;
  revision: number;
  /** A drag offered from another window's sidebar, which this sidebar may take. */
  sharedDrag: ProjectedSharedDrag | null;
  structureHealth: HyperModelSnapshot['derived']['structureHealth'];
  tabOwnerships: Readonly<Record<number, HyperModelSnapshot['runtime']['tabOwnerships'][number]>>;
  tabs: HyperModelSnapshot['browser']['tabs'];
  window: HyperWindowProjection;
}

export type HyperModelPortMessage = ServerMessage<HyperSidebarProjection>;

interface HyperRuntimePort {
  disconnect(): void;
  name: string;
  onDisconnect: { addListener(listener: () => void): void };
  onMessage: { addListener(listener: (message: unknown) => void): void };
  postMessage(message: HyperModelPortMessage): void;
  sender?: ModelPortSender;
}

function sameExtensionPage(senderUrl: string | undefined, expectedUrl: string): boolean {
  if (!senderUrl) return false;
  try {
    const sender = new URL(senderUrl);
    const expected = new URL(expectedUrl);
    return sender.origin === expected.origin && sender.pathname === expected.pathname;
  } catch {
    return false;
  }
}

export function resolveHyperModelPortRole(
  sender: ModelPortSender,
  hello: HelloMessage,
  extensionUrl: (path: '/inpage.html' | '/newtab.html' | '/sidepanel.html') => string,
  authorizeInPageSidebar: (tabId: number, token: string) => boolean = () => false,
): HyperModelClientRole | undefined {
  if (hello.protocolVersion !== HYPER_MODEL_PROTOCOL_VERSION) return undefined;
  if (hello.role === 'sidebar') {
    if (sameExtensionPage(sender.url, extensionUrl('/sidepanel.html'))) {
      return hello.windowId !== undefined ? 'sidebar' : undefined;
    }
    // Any website can frame the in-page sidebar, so it must carry the token Hyper issued its tab.
    if (!sameExtensionPage(sender.url, extensionUrl('/inpage.html')) || sender.tab?.id === undefined) {
      return undefined;
    }
    try {
      const token = new URL(sender.url as string).searchParams.get('token');
      return token && authorizeInPageSidebar(sender.tab.id, token) ? 'sidebar' : undefined;
    } catch {
      return undefined;
    }
  }
  if (hello.role === 'newtab') {
    if (!sameExtensionPage(sender.url, extensionUrl('/newtab.html')) ||
      sender.tab?.windowId === undefined ||
      (hello.windowId !== undefined && sender.tab.windowId !== hello.windowId)) {
      return undefined;
    }
    try {
      return new URL(sender.url as string).searchParams.get('mode') === 'search-overlay'
        ? undefined
        : 'newtab';
    } catch {
      return undefined;
    }
  }
  if (hello.role === 'page-search') {
    if (!sameExtensionPage(sender.url, extensionUrl('/newtab.html'))) return undefined;
    if (sender.tab?.id === undefined || sender.tab.windowId === undefined) return undefined;
    try {
      const url = new URL(sender.url as string);
      return url.searchParams.get('mode') === 'search-overlay' &&
        Number(url.searchParams.get('sourceTabId')) === sender.tab.id &&
        Number(url.searchParams.get('sourceWindowId')) === sender.tab.windowId
        ? 'page-search'
        : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function remoteSpacePresenceForClient(
  snapshot: HyperModelSnapshot,
  windowId: number,
  tabs: HyperModelSnapshot['browser']['tabs'],
): HyperRemoteSpacePresence {
  const normalWindows = normalWindowIds(snapshot.browser.windows);
  const remoteSpaceIdsByPage = new Map<string, Set<string>>();
  const otherWindowTabCounts: Record<string, number> = {};
  for (const tab of snapshot.browser.tabs) {
    if (
      tab.id === undefined ||
      tab.windowId === windowId ||
      tab.incognito ||
      !normalWindows.has(tab.windowId)
    ) continue;
    const disposition = snapshot.derived.tabDispositions.get(tab.id);
    // A blank page has no backing yet but is listed; a pinned tab is in no space's list.
    const listedSpaceId = disposition && !tab.pinned ? activationSpaceId(disposition) : undefined;
    if (listedSpaceId) otherWindowTabCounts[listedSpaceId] = (otherWindowTabCounts[listedSpaceId] ?? 0) + 1;
    const spaceId = disposition?.status === 'owned' ? disposition.spaceId : undefined;
    const identity = tabPageIdentity(tab);
    if (!spaceId || !identity) continue;
    addToMapSet(remoteSpaceIdsByPage, identity, spaceId);
  }
  const spaceIdsFor = (url: string | undefined): string[] | undefined => {
    const identity = pageIdentity(url);
    const spaceIds = identity ? remoteSpaceIdsByPage.get(identity) : undefined;
    return spaceIds && spaceIds.size > 0 ? [...spaceIds].sort() : undefined;
  };
  const tabSpaceIds = Object.fromEntries(tabs.flatMap((tab) => {
    if (tab.id === undefined) return [];
    const spaceIds = spaceIdsFor(tabUrl(tab));
    return spaceIds ? [[tab.id, spaceIds] as const] : [];
  }));
  const activeSpaceId = snapshot.runtime.activeSpaceIds[windowId] ?? shownSpaces(snapshot.hyper.spaces)[0]?.id;
  const visibleBookmarks: readonly BookmarkNode[] = activeSpaceId
    ? snapshot.hyper.localBookmarksBySpaceId[activeSpaceId] ?? []
    : [];
  const bookmarkSpaceIds: Record<string, readonly string[]> = {};
  const visit = (nodes: readonly BookmarkNode[]) => {
    for (const node of nodes) {
      const spaceIds = spaceIdsFor(node.url);
      if (spaceIds) bookmarkSpaceIds[node.id] = spaceIds;
      visit(node.children ?? []);
    }
  };
  visit(visibleBookmarks);
  visit(snapshot.hyper.globalBookmarks);
  visit(snapshot.hyper.favourites);
  return { bookmarkSpaceIds, otherWindowTabCounts, tabSpaceIds };
}

/** The spaces as a window shows them: each wearing its group's colour in that window first. */
function spacesForWindow(snapshot: HyperModelSnapshot, windowId: number): Space[] {
  const colours = liveSpaceColours(
    snapshot.browser.tabGroups,
    groupOwnerships(snapshot.runtime.groupOwnership),
    windowId,
  );
  const spaces = snapshot.hyper.spaces;
  const recoloured = spaces.map((space) => {
    const colour = colours.get(space.id);
    return colour && colour !== space.colour ? { ...space, colour } : space;
  });
  return recoloured.every((space, index) => space === spaces[index]) ? spaces : recoloured;
}

export function projectHyperModelForClient(
  snapshot: HyperModelSnapshot,
  role: Exclude<HyperModelClientRole, 'page-search'>,
  windowId: number,
  clientId?: string,
): HyperSidebarProjection | undefined {
  const tabs = normalWindowTabs(snapshot, windowId);
  if (!tabs) return undefined;
  const ownedTabIds = new Set(tabs.flatMap((tab) => tab.id === undefined ? [] : [tab.id]));
  const owned = <Value, Projected = Value>(
    entries: Iterable<readonly [number | string, Value]>,
    project = (value: Value) => value as unknown as Projected,
  ) => Object.fromEntries([...entries].flatMap(
    ([tabId, value]) => ownedTabIds.has(Number(tabId)) ? [[tabId, project(value)] as const] : [],
  ));
  const tabOwnerships = owned(Object.entries(snapshot.runtime.tabOwnerships));
  const tabDispositions = owned(snapshot.derived.tabDispositions);
  const tabBookmarkLinks = owned(
    snapshot.derived.tabBookmarkLinks,
    ({ bookmarkId, drifted }) => ({ bookmarkId, drifted }),
  );
  const tabNames = owned(snapshot.derived.tabNames);
  const tabTitles = owned(snapshot.derived.tabTitles);
  const groupIdsBySpace = groupIdsForWindow(snapshot.runtime.groupOwnership, windowId);
  const remoteSpacePresence = remoteSpacePresenceForClient(snapshot, windowId, tabs);
  const mediaTarget = mediaTargetForWindow(
    tabs,
    windowId,
    snapshot.runtime.mediaStates,
    snapshot.runtime.mediaRetainedTabIds,
  );
  return {
    bookmarkImportInProgress: snapshot.runtime.bookmarkImportActiveCount > 0,
    bookmarkTree: snapshot.browser.bookmarkTree,
    commandCapabilities: snapshot.runtime.commandCapabilities,
    commands: clientId === undefined
      ? []
      : commandStatusesForClient(snapshot.commands, clientId),
    hyper: { ...snapshot.hyper, spaces: spacesForWindow(snapshot, windowId) },
    ...(snapshot.runtime.installationId ? { installationId: snapshot.runtime.installationId } : {}),
    preferences: snapshot.runtime.preferences,
    recentlyClosedTabs: snapshot.browser.recentlyClosedTabs,
    remoteSpacePresence,
    revision: snapshot.revision,
    sharedDrag: role === 'sidebar' ? projectSharedDrag(snapshot.runtime.sharedDrag, windowId) : null,
    structureHealth: snapshot.derived.structureHealth,
    tabOwnerships,
    tabs,
    window: {
      activeSpaceId: snapshot.runtime.activeSpaceIds[windowId],
      backgroundMusicTabIds: backgroundMusicTabIds(
        tabs,
        windowId,
        mediaTarget,
        snapshot.runtime.mediaRetainedTabIds[windowId],
      ),
      focused: snapshot.browser.focusedWindowId === windowId,
      groupIdsBySpace,
      incognito: false,
      mediaControlAvailable: snapshot.runtime.mediaControlAvailable,
      mediaRetainedTabId: snapshot.runtime.mediaRetainedTabIds[windowId],
      mediaTarget,
      tabBookmarkLinks,
      tabDispositions,
      tabNames,
      tabOwnerships,
      tabTitles,
      tabs,
      timedMessage: snapshot.runtime.timedMessages[windowId],
      windowId,
    },
  };
}

export interface HyperModelPortClient {
  clientId: string;
  role: HyperModelClientRole;
  tabId?: number;
  windowId: number;
}

export type IntentOutcome =
  | { reason: string; status: 'rejected' }
  | { revision: number; status: 'accepted' };

export interface SearchOutcome {
  results: SharedSearchResult[];
  revision: number;
}

export interface HyperModelPortHandlers {
  /**
   * Resolves once views may authenticate. A port is accepted before then, but
   * its messages wait, so the connection that wakes the worker is not refused.
   */
  admitted?: Promise<unknown>;
  authorizeInPageSidebar?(tabId: number, token: string): boolean;
  onDisconnect?(client: HyperModelPortClient): void;
  /** Whether the browser's own sidebar is showing Hyper in a window. */
  onNativeSidebarPresence?(windowId: number, present: boolean): void;
  search?(
    request: SearchQueryMessage,
    client: HyperModelPortClient,
  ): Promise<SearchOutcome | undefined>;
  submitIntent?(intent: IntentMessage, client: HyperModelPortClient): Promise<IntentOutcome>;
}

export interface HyperModelPortServer {
  dispose(): void;
}

const pageSearchIntentKinds: readonly HyperActionKind[] = [
  'activateTab',
  'closeTabs',
  'deleteHistory',
  'forgetSearchSelection',
  'navigateTab',
  'recordSearchSelection',
  'selectSpace',
  'setTabMediaPlayback',
  'setTabMuted',
];

export function canSubmitHyperModelIntent(
  role: HyperModelClientRole,
  kind: HyperActionKind,
  payload?: unknown,
): boolean {
  if (role !== 'page-search') return true;
  if (!pageSearchIntentKinds.includes(kind)) return false;
  const fields: Record<string, unknown> = isRecord(payload) ? payload : {};
  // Page Search never focuses another window's tab or names tabs to close; it may close a result's page in a space.
  if (kind === 'activateTab') return fields.operation !== 'remote';
  return kind !== 'closeTabs' || fields.condition === 'page-in-space';
}

/**
 * The root atom never crosses a runtime boundary. A client proves its
 * extension-page role, is issued an identity by the background rather than
 * claiming one, and then receives exactly one unacknowledged delivery at a time
 * so a wedged view cannot make the background queue snapshots without bound.
 *
 * Window identity comes from `sender.tab` whenever the platform supplies it. It
 * cannot for a side panel, so a sidebar claim is instead bounded by single
 * occupancy: claiming a window that already has a sidebar evicts the incumbent
 * rather than silently observing alongside it.
 */
export function startHyperModelPortServer(
  store: HyperModelStore,
  handlers: HyperModelPortHandlers = {},
): HyperModelPortServer {
  const sidebarPortsByWindow = new Map<number, HyperRuntimePort>();
  // The connection that wakes the worker reaches only the listeners registered
  // as it starts, so a port is accepted at once and its messages wait here.
  let held: (() => void)[] | undefined = handlers.admitted ? [] : undefined;
  void handlers.admitted?.then(() => {
    const waiting = held ?? [];
    held = undefined;
    for (const receive of waiting) receive();
  }, () => undefined);
  const connect = (port: HyperRuntimePort) => {
    if (port.name !== HYPER_MODEL_PORT_NAME) return;
    let client: HyperModelPortClient | undefined;
    let unsubscribe: (() => void) | undefined;
    let closed = false;
    const cursor = createDeliveryCursor();

    const closeBrokenPort = (error: unknown) => {
      unsubscribe?.();
      unsubscribe = undefined;
      console.error('Unable to deliver the Hyper model.', error);
      port.disconnect();
    };
    const send = (message: HyperModelPortMessage): boolean => {
      try {
        port.postMessage(message);
        return true;
      } catch (error) {
        closeBrokenPort(error);
        return false;
      }
    };
    const terminate = (reason: ProtocolErrorReason) => {
      if (send({ buildId: HYPER_BUILD_ID, reason, type: 'protocol-error' })) port.disconnect();
    };

    const deliver = (revision: number, sequence: number): boolean => {
      if (!client) return false;
      const snapshot = store.get(hyperModelAtom);
      if (client.role === 'page-search') {
        if (!snapshot.browser.windows.some((window) =>
          window.id === client!.windowId && !window.incognito)) {
          terminate('unauthenticated');
          return false;
        }
        return send({
          revision,
          sequence,
          statuses: commandStatusesForClient(snapshot.commands, client.clientId),
          type: 'command-status',
        });
      }
      const payload = projectHyperModelForClient(
        snapshot,
        client.role,
        client.windowId,
        client.clientId,
      );
      if (!payload) {
        terminate('unauthenticated');
        return false;
      }
      return send({ payload, revision, sequence, type: 'snapshot' });
    };

    const deliverSafely = (revision: number, sequence: number): boolean => {
      try {
        return deliver(revision, sequence);
      } catch (error) {
        closeBrokenPort(error);
        return false;
      }
    };
    const offer = (): boolean => {
      const instruction = cursor.offer(store.get(hyperModelAtom).revision);
      return instruction ? deliverSafely(instruction.revision, instruction.sequence) : true;
    };

    const handleHello = (message: HelloMessage) => {
      const role = resolveHyperModelPortRole(
        port.sender ?? {},
        message,
        (path) => browser.runtime.getURL(path),
        handlers.authorizeInPageSidebar,
      );
      const senderWindowId = port.sender?.tab?.windowId;
      // The browser fills in sender.tab, so a body that disagrees with it is forged.
      const claimsForeignWindow = senderWindowId !== undefined &&
        message.windowId !== undefined &&
        message.windowId !== senderWindowId;
      const windowId = senderWindowId ?? message.windowId;
      if (!role || windowId === undefined || claimsForeignWindow) {
        terminate('unauthenticated');
        return;
      }
      const senderTabId = port.sender?.tab?.id;
      client = {
        clientId: crypto.randomUUID(),
        role,
        ...(senderTabId === undefined ? {} : { tabId: senderTabId }),
        windowId,
      };
      if (role === 'sidebar' && sameExtensionPage(
        port.sender?.url,
        browser.runtime.getURL('/sidepanel.html'),
      )) {
        const incumbent = sidebarPortsByWindow.get(windowId);
        sidebarPortsByWindow.set(windowId, port);
        if (incumbent && incumbent !== port) incumbent.disconnect();
        handlers.onNativeSidebarPresence?.(windowId, true);
      }
      if (!send({
        buildId: HYPER_BUILD_ID,
        clientId: client.clientId,
        protocolVersion: HYPER_MODEL_PROTOCOL_VERSION,
        role,
        type: 'welcome',
      }) || !offer()) return;
      // A broken port closes so its view can reconnect without blocking other clients.
      unsubscribe = store.sub(hyperModelAtom, () => { offer(); });
    };

    const receive = (message: unknown) => {
      const parsed = parseClientMessage(message);
      if (parsed.status === 'rejected') {
        terminate(parsed.reason);
        return;
      }
      if (!client) {
        if (parsed.message.type !== 'hello') {
          terminate('unauthenticated');
          return;
        }
        handleHello(parsed.message);
        return;
      }
      switch (parsed.message.type) {
        case 'ack': {
          const result = cursor.ack(parsed.message.sequence);
          if (result.status === 'rejected') terminate(result.reason);
          else if (result.deliver) deliverSafely(result.deliver.revision, result.deliver.sequence);
          return;
        }
        case 'hello':
          terminate('duplicate-hello');
          return;
        case 'intent': {
          const intent = parsed.message;
          if (intent.baseRevision !== cursor.acknowledgedRevision()) {
            send({
              commandId: intent.commandId,
              reason: 'precondition-failed',
              type: 'rejected',
            });
            return;
          }
          if (!canSubmitHyperModelIntent(client.role, intent.kind, intent.payload)) {
            send({
              commandId: intent.commandId,
              reason: 'not-permitted',
              type: 'rejected',
            });
            return;
          }
          const submit = handlers.submitIntent;
          if (!submit) {
            send({
              commandId: intent.commandId,
              reason: 'unsupported',
              type: 'rejected',
            });
            return;
          }
          void submit(intent, client).then((outcome) => {
            send(outcome.status === 'accepted'
              ? { commandId: intent.commandId, revision: outcome.revision, type: 'accepted' }
              : { commandId: intent.commandId, reason: outcome.reason, type: 'rejected' });
          }, () => {
            send({
              commandId: intent.commandId,
              reason: 'browser-error',
              type: 'rejected',
            });
          });
          return;
        }
        case 'search-query': {
          const request = parsed.message;
          const search = handlers.search;
          if (!search) {
            send({
              reason: 'unsupported',
              requestId: request.requestId,
              type: 'search-error',
            });
            return;
          }
          void search(request, client).then((outcome) => {
            send(outcome
              ? {
                  requestId: request.requestId,
                  results: outcome.results,
                  revision: outcome.revision,
                  type: 'search-result',
                }
              : {
                  reason: 'unsupported',
                  requestId: request.requestId,
                  type: 'search-error',
                });
          }, () => {
            send({
              reason: 'browser-error',
              requestId: request.requestId,
              type: 'search-error',
            });
          });
          return;
        }
        case 'resync':
          // A reconnecting view discards its cache, so the cursor starts over.
          cursor.reset();
          offer();
          return;
      }
    };
    port.onMessage.addListener((message) => {
      if (held) held.push(() => { if (!closed) receive(message); });
      else receive(message);
    });
    port.onDisconnect.addListener(() => {
      closed = true;
      unsubscribe?.();
      if (client?.role === 'sidebar' && sidebarPortsByWindow.get(client.windowId) === port) {
        sidebarPortsByWindow.delete(client.windowId);
        handlers.onNativeSidebarPresence?.(client.windowId, false);
      }
      if (client) handlers.onDisconnect?.(client);
    });
  };

  const onConnect = (port: Browser.runtime.Port) =>
    connect(port as unknown as HyperRuntimePort);
  browser.runtime.onConnect.addListener(onConnect);
  return {
    dispose() {
      browser.runtime.onConnect.removeListener(onConnect);
      sidebarPortsByWindow.clear();
    },
  };
}