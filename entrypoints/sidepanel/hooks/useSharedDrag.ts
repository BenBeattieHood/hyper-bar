import { useEffect, useMemo, useRef } from 'react';
import type { BookmarkNode } from '../../lib/bookmarks';
import type { SharedDragReference } from '../../lib/modelIntentPayloads';
import type { ProjectedSharedDrag } from '../../lib/sharedDrag';
import {
  carriesHyperDrag,
  HYPER_DRAG_TYPE,
  SHARED_DRAG_ENDED,
  startStandInDrag,
  type NativeDragSensorOptions,
} from '../lib/nativeDrag';
import {
  sharedDragItems,
  sharedDragReferences,
  sharedDragStandInId,
} from '../lib/sharedDragDrops';
import type { SelectableDragItem } from '../types';
import { listen } from '../lib/listen';

interface SharedDragOptions {
  /** Whether this sidebar already has a drag going. */
  dragging(): boolean;
  favouriteSlots: readonly (BookmarkNode | undefined)[];
  nodes: ReadonlyMap<string, BookmarkNode>;
  offer(token: string, items: readonly SharedDragReference[]): Promise<void>;
  /** What this sidebar's own drag holds. */
  outgoingItems(): readonly SelectableDragItem[];
  /** A drag another window's sidebar shared, as the model projects it. */
  shared: ProjectedSharedDrag | null;
  withdraw(token: string): Promise<void>;
}

/**
 * Carries drags between the sidebars of different windows. The browser moves
 * the drag itself; the model holds what it carries, offered once the drag
 * leaves this sidebar and withdrawn when it ends.
 */
export function useSharedDrag(options: SharedDragOptions) {
  const latest = useRef(options);
  latest.current = options;
  const outgoing = useRef<{ offered: boolean; token: string } | undefined>(undefined);
  const standInRef = useRef<HTMLDivElement | null>(null);
  const { favouriteSlots, nodes, shared } = options;
  const incoming = useMemo(() => {
    if (!shared) return undefined;
    const items = sharedDragItems(shared, nodes, favouriteSlots);
    return items.length > 0
      ? { id: sharedDragStandInId(shared.token), items, token: shared.token }
      : undefined;
  }, [favouriteSlots, nodes, shared]);

  const sensorOptions = useMemo<Omit<NativeDragSensorOptions, 'acceptsExternal'>>(() => ({
    accepts: (transfer) => {
      const token = latest.current.shared?.token;
      return token !== undefined && transfer.getData(HYPER_DRAG_TYPE) === token;
    },
    onLeave: () => {
      const drag = outgoing.current;
      const items = drag && !drag.offered
        ? sharedDragReferences(latest.current.outgoingItems())
        : undefined;
      if (!drag || !items) return;
      drag.offered = true;
      void latest.current.offer(drag.token, items).catch(() => undefined);
    },
    prepare: (transfer) => {
      const token = crypto.randomUUID();
      outgoing.current = { offered: false, token };
      transfer.setData(HYPER_DRAG_TYPE, token);
    },
  }), []);

  const incomingToken = incoming?.token;
  useEffect(() => {
    if (!incomingToken) return;
    const join = (event: DragEvent) => {
      const standIn = standInRef.current;
      if (!standIn || latest.current.dragging() || !carriesHyperDrag(event)) return;
      event.preventDefault();
      startStandInDrag(standIn, event, 'shared');
    };
    const unlisten = listen([document, 'dragenter', join, true], [document, 'dragover', join, true]);
    return () => {
      unlisten();
      document.dispatchEvent(new Event(SHARED_DRAG_ENDED));
    };
  }, [incomingToken]);

  return {
    /** Ends this sidebar's part in its drag, withdrawing it from other windows if it was offered. */
    finish: () => {
      const drag = outgoing.current;
      outgoing.current = undefined;
      if (drag?.offered) void latest.current.withdraw(drag.token).catch(() => undefined);
    },
    incoming,
    sensorOptions,
    standInRef,
  };
}
