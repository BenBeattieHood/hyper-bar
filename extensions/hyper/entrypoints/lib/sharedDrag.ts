import { buildNodeMap } from './bookmarks';
import type { HyperModelSnapshot } from './model';
import type { HyperActionKind } from './modelActions';
import { intentHandler, type HyperIntentHandlers } from './modelIntents';
import {
  parseShareDragPayload,
  type SharedDragReference,
} from './modelIntentPayloads';

/**
 * A drag that has left the sidebar it started in. The browser carries the drag
 * itself between windows, but a drop only reveals its data once it lands, so
 * the model carries what the drag holds.
 */
export interface SharedDrag {
  items: readonly SharedDragReference[];
  sourceWindowId: number;
  /** Also written into the drag, so a drop proves it is this drag and not a page's. */
  token: string;
}

/**
 * A shared drag as a sidebar in another window sees it: bookmarks by the IDs it
 * already has, and tabs only as tabs, since remote tab records stay in the worker.
 */
export interface ProjectedSharedDrag {
  items: ReadonlyArray<{ kind: 'favourite' | 'tree'; nodeId: string } | { kind: 'tab' }>;
  token: string;
}

export interface SharedDragController {
  handlers: Pick<HyperIntentHandlers, Extract<HyperActionKind, 'shareDrag'>>;
  /** A sidebar that goes away takes the drag it offered with it. */
  release(clientId: string): void;
  runtimeSignals(): { sharedDrag: SharedDrag | null };
  /** The tabs a shared drag holds, for a sidebar in another window to take. */
  tabIds(token: string, windowId: number): readonly number[] | undefined;
}

export function projectSharedDrag(
  drag: SharedDrag | null,
  windowId: number,
): ProjectedSharedDrag | null {
  if (!drag || drag.sourceWindowId === windowId) return null;
  return {
    items: drag.items.map((item) => item.kind === 'tab' ? { kind: 'tab' } : item),
    token: drag.token,
  };
}

/** Only tabs the offering sidebar's own window shows, or bookmarks every window shares. */
export function verifySharedDragItems(
  snapshot: HyperModelSnapshot,
  windowId: number,
  references: readonly SharedDragReference[],
): SharedDragReference[] {
  const tabs = new Map(snapshot.browser.tabs.flatMap((tab) =>
    tab.id === undefined ? [] : [[tab.id, tab] as const]));
  const nodes = buildNodeMap(snapshot.browser.bookmarkTree);
  for (const reference of references) {
    if (reference.kind !== 'tab') {
      if (!nodes.has(reference.nodeId)) throw new Error('That bookmark no longer exists.');
      continue;
    }
    const tab = tabs.get(reference.tabId);
    if (!tab || tab.windowId !== windowId || tab.incognito) {
      throw new Error('Only a tab in the sidebar\'s own window can be dragged from it.');
    }
  }
  return [...references];
}

export function createSharedDragController(dependencies: {
  readSnapshot(): HyperModelSnapshot;
  reconcile(): Promise<unknown>;
}): SharedDragController {
  // A drop in another window and the source's own dragend race to the worker, so a
  // withdrawn drag stops being shown but can still be taken until another replaces it.
  let current: { clientId: string; drag: SharedDrag; offered: boolean } | undefined;
  return {
    handlers: {
      shareDrag: intentHandler({
        parse: parseShareDragPayload,
        run: async (payload, client) => {
          if (payload.operation === 'withdraw') {
            if (current?.drag.token === payload.token && current.clientId === client.clientId) {
              current = { ...current, offered: false };
            }
            return;
          }
          if (client.role !== 'sidebar') throw new Error('Only a sidebar can offer a drag.');
          current = {
            clientId: client.clientId,
            drag: {
              items: verifySharedDragItems(dependencies.readSnapshot(), client.windowId, payload.items),
              sourceWindowId: client.windowId,
              token: payload.token,
            },
            offered: true,
          };
        },
        targets: () => [],
      }),
    },
    release(clientId) {
      if (current?.clientId !== clientId) return;
      current = undefined;
      void dependencies.reconcile().catch(() => undefined);
    },
    runtimeSignals: () => ({ sharedDrag: current?.offered ? current.drag : null }),
    tabIds(token, windowId) {
      const drag = current?.drag;
      if (drag?.token !== token || drag.sourceWindowId === windowId) return undefined;
      return drag.items.flatMap((item) => item.kind === 'tab' ? [item.tabId] : []);
    },
  };
}
