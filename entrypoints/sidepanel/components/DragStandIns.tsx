import { useDraggable } from '@dnd-kit/core';
import type { RefObject } from 'react';
import type { DragItemData } from '../types';

interface StandInDrag<Incoming> {
  incoming?: Incoming;
  standInRef: RefObject<HTMLDivElement | null>;
}

/**
 * Invisible draggables that drags begun elsewhere play out on: one shared from
 * another window's sidebar, and one from outside Hyper.
 */
export function DragStandIns({
  external,
  shared,
}: {
  external: StandInDrag<{ id: string; item: DragItemData }>;
  shared: StandInDrag<{ id: string; items: readonly DragItemData[] }>;
}) {
  const sharedItem = shared.incoming?.items[0];
  return (
    <>
      {shared.incoming && sharedItem && (
        <StandIn id={shared.incoming.id} item={sharedItem} standInRef={shared.standInRef} />
      )}
      {external.incoming && <StandIn {...external.incoming} standInRef={external.standInRef} />}
    </>
  );
}

function StandIn({
  id,
  item,
  standInRef,
}: {
  id: string;
  item: DragItemData;
  standInRef: RefObject<HTMLDivElement | null>;
}) {
  const draggable = useDraggable({ data: item, id });
  return (
    <div
      ref={(node) => {
        draggable.setNodeRef(node);
        standInRef.current = node;
      }}
      className="shared-drag-stand-in"
      aria-hidden="true"
      {...draggable.listeners}
    />
  );
}
