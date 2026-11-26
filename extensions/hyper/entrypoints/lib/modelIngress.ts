/**
 * The complete list of ways state can enter the background model. Every entry
 * is routed onto the serial lane: an observation schedules reconciliation, an
 * intent becomes a command, and a lifecycle event re-establishes the worker.
 * History changes update background-owned runtime metadata, then reconcile it
 * into the same committed revision used to answer Search queries.
 * Nothing reaches browser state by any other path, and every named ingress
 * must declare its route.
 */

export type IngressRoute = 'intent' | 'lifecycle' | 'reconcile';

export type IngressCapability =
  | 'permissions'
  | 'sessions'
  | 'tabGroups'
  | 'webNavigation';

export type StorageAreaName = 'local' | 'session' | 'sync';

export interface IngressDescriptor {
  /** Absent on the target browser means the ingress simply never fires. */
  capability?: IngressCapability;
  route: IngressRoute;
  /** Only these areas carry model state; every other area is ignored. */
  storageAreas?: readonly StorageAreaName[];
}

export const ingressInventory = {
  'action.onClicked': { route: 'intent' },
  'bookmarks.onChanged': { route: 'reconcile' },
  'bookmarks.onChildrenReordered': { route: 'reconcile' },
  'bookmarks.onCreated': { route: 'reconcile' },
  'bookmarks.onImportBegan': { route: 'lifecycle' },
  'bookmarks.onImportEnded': { route: 'reconcile' },
  'bookmarks.onMoved': { route: 'reconcile' },
  'bookmarks.onRemoved': { route: 'reconcile' },
  'commands.onCommand': { route: 'intent' },
  'history.onTitleChanged': { route: 'reconcile' },
  'history.onVisitRemoved': { route: 'reconcile' },
  'history.onVisited': { route: 'reconcile' },
  'model.structureDegraded': { route: 'reconcile' },
  'permissions.onAdded': { capability: 'permissions', route: 'reconcile' },
  'permissions.onRemoved': { capability: 'permissions', route: 'reconcile' },
  'port.onConnect': { route: 'lifecycle' },
  'port.onDisconnect': { route: 'lifecycle' },
  'runtime.onInstalled': { route: 'lifecycle' },
  'runtime.onMessage': { route: 'intent' },
  'runtime.onStartup': { route: 'lifecycle' },
  'sessions.onChanged': { capability: 'sessions', route: 'reconcile' },
  'storage.onChanged': { route: 'reconcile', storageAreas: ['local', 'session'] },
  'tabGroups.onCreated': { capability: 'tabGroups', route: 'reconcile' },
  'tabGroups.onMoved': { capability: 'tabGroups', route: 'reconcile' },
  'tabGroups.onRemoved': { capability: 'tabGroups', route: 'reconcile' },
  'tabGroups.onUpdated': { capability: 'tabGroups', route: 'reconcile' },
  'tabs.onActivated': { route: 'reconcile' },
  'tabs.onAttached': { route: 'reconcile' },
  'tabs.onCreated': { route: 'reconcile' },
  'tabs.onDetached': { route: 'reconcile' },
  'tabs.onMoved': { route: 'reconcile' },
  'tabs.onRemoved': { route: 'reconcile' },
  'tabs.onReplaced': { route: 'reconcile' },
  'tabs.onUpdated': { route: 'reconcile' },
  'webNavigation.onBeforeNavigate': { capability: 'webNavigation', route: 'reconcile' },
  'webNavigation.onCommitted': { capability: 'webNavigation', route: 'reconcile' },
  'webNavigation.onCompleted': { capability: 'webNavigation', route: 'reconcile' },
  'webNavigation.onErrorOccurred': { capability: 'webNavigation', route: 'reconcile' },
  'webNavigation.onHistoryStateUpdated': { capability: 'webNavigation', route: 'reconcile' },
  'webNavigation.onReferenceFragmentUpdated': {
    capability: 'webNavigation',
    route: 'reconcile',
  },
  'windows.onCreated': { route: 'reconcile' },
  'windows.onFocusChanged': { route: 'reconcile' },
  'windows.onRemoved': { route: 'reconcile' },
} as const satisfies Readonly<Record<string, IngressDescriptor>>;

export type IngressName = keyof typeof ingressInventory;

export const ingressNames = Object.keys(ingressInventory) as readonly IngressName[];

export function ingressRoute(name: IngressName): IngressRoute {
  return ingressInventory[name].route;
}

export function isModelStorageArea(areaName: string): areaName is StorageAreaName {
  return (ingressInventory['storage.onChanged'].storageAreas as readonly string[]).includes(areaName);
}

export type IngressSource = 'browser' | 'command' | 'newtab' | 'page-search' | 'sidebar';

export interface ModelEnvelope<Payload> {
  id: string;
  ingress: IngressName;
  observedAt: number;
  payload: Payload;
  route: IngressRoute;
  source: IngressSource;
}

export function envelope<Payload>(
  id: string,
  ingress: IngressName,
  source: IngressSource,
  observedAt: number,
  payload: Payload,
): ModelEnvelope<Payload> {
  return { id, ingress, observedAt, payload, route: ingressRoute(ingress), source };
}
