import {
  closestCenter,
  pointerWithin,
  rectIntersection,
  type CollisionDetection,
  type DragEndEvent,
  type DragMoveEvent,
  type DragOverEvent,
  type Modifier,
} from '@dnd-kit/core';
import {
  excludeForegroundDropTargets,
  indexedRootDropTarget,
  prioritiseForegroundDropTargets,
} from './drag';
import type { DragItemData } from '../types';

export function dragData(value: unknown): DragItemData | undefined {
  if (!value || typeof value !== 'object' || !('kind' in value)) return undefined;
  return value as DragItemData;
}

const DEFAULT_TREE_INDENT = 16;

/** How far a tree indents each level, as the rendered rows say. */
export function treeIndentationWidth(): number {
  const row = document.querySelector<HTMLElement>('.tree-row');
  if (!row) return DEFAULT_TREE_INDENT;
  const indentation = Number.parseFloat(
    window.getComputedStyle(row).getPropertyValue('--tree-indent'),
  );
  return Number.isFinite(indentation) && indentation > 0
    ? indentation
    : DEFAULT_TREE_INDENT;
}

export const centerOverlayOnPointer: Modifier = ({
  activatorEvent,
  activeNodeRect,
  overlayNodeRect,
  transform,
}) => {
  if (!(activatorEvent instanceof MouseEvent) || !activeNodeRect || !overlayNodeRect) {
    return transform;
  }
  return {
    ...transform,
    x: transform.x + activatorEvent.clientX - activeNodeRect.left - overlayNodeRect.width / 2,
    y: transform.y + activatorEvent.clientY - activeNodeRect.top - overlayNodeRect.height / 2,
  };
};

// The pointer collision detection last used, so drop placement reads the same point.
let collisionPointer: { x: number; y: number } | null = null;

export const dragCollisionDetection: CollisionDetection = (args) => {
  collisionPointer = args.pointerCoordinates;
  const source = dragData(args.active.data.current);
  const keyboardTreeDrag = !args.pointerCoordinates && source?.kind === 'tree';
  const droppableContainers = keyboardTreeDrag
    ? args.droppableContainers.filter((container) =>
        dragData(container.data.current)?.kind === 'tree')
    : args.droppableContainers;
  // A lifted row collapses after its drag begins, moving the sessions below it, which are measured only once.
  const droppableRects = new Map(args.droppableRects);
  for (const container of droppableContainers) {
    const rect = dragData(container.data.current)?.kind === 'session-zone'
      ? container.node.current?.getBoundingClientRect()
      : undefined;
    if (rect) droppableRects.set(container.id, rect);
  }
  const collisionArgs = { ...args, droppableContainers, droppableRects };
  const collisions = (args.pointerCoordinates
    ? pointerWithin(collisionArgs)
    : rectIntersection(collisionArgs))
    .filter((collision) => collision.id !== args.active.id);
  if (!args.pointerCoordinates && collisions.length === 0) {
    return closestCenter({
      ...collisionArgs,
      droppableContainers: excludeForegroundDropTargets(
        droppableContainers.filter((container) => container.id !== args.active.id),
        (container) => dragData(container.data.current),
      ),
    });
  }
  const prioritisedCollisions = prioritiseForegroundDropTargets(
    collisions,
    (collision) => dragData(collision.data?.droppableContainer.data.current),
  );
  if (prioritisedCollisions !== collisions) return prioritisedCollisions;
  const treeCollisions = collisions.filter((collision) =>
    dragData(collision.data?.droppableContainer.data.current)?.kind === 'tree');
  const tabTreeCollisions = collisions.filter((collision) => {
    const target = dragData(collision.data?.droppableContainer.data.current);
    return target?.kind === 'tab-folder' ||
      target?.kind === 'tab' && target.nodeId !== undefined;
  });
  const rootAppendCollisions = collisions.filter((collision) => {
    const target = dragData(collision.data?.droppableContainer.data.current);
    return indexedRootDropTarget(target);
  });
  if (treeCollisions.length > 0) return treeCollisions;
  if (tabTreeCollisions.length > 0) return tabTreeCollisions;
  if (rootAppendCollisions.length > 0) return rootAppendCollisions;
  const insideTreeZone = collisions.some((collision) =>
    dragData(collision.data?.droppableContainer.data.current)?.kind === 'tree-zone');
  if (insideTreeZone) {
    const pointerY = args.pointerCoordinates?.y;
    const nearestTreeRow = pointerY === undefined
      ? []
      : droppableContainers
          .flatMap((container) => {
            if (container.id === args.active.id) return [];
            if (dragData(container.data.current)?.kind !== 'tree') return [];
            const rect = container.rect.current;
            if (!rect) return [];
            return [{
              id: container.id,
              data: {
                droppableContainer: container,
                value: Math.abs(pointerY - (rect.top + rect.height / 2)),
              },
            }];
          })
          .sort((left, right) => left.data.value - right.data.value)
          .slice(0, 1);
    if (nearestTreeRow.length > 0) return nearestTreeRow;
  }
  return collisions;
};

export function dragPointer(
  event: DragMoveEvent | DragOverEvent | DragEndEvent,
): { x: number; y: number } | undefined {
  // The event's delta discounts scrolling and the source row's own movement, so it can
  // place the pointer over a different row from the one the collision found.
  if (collisionPointer) return collisionPointer;
  const pointerEvent = event.activatorEvent as PointerEvent;
  if (typeof pointerEvent.clientY === 'number') {
    return {
      x: pointerEvent.clientX + event.delta.x,
      y: pointerEvent.clientY + event.delta.y,
    };
  }
  const touchEvent = event.activatorEvent as TouchEvent;
  const touch = touchEvent.touches?.[0] ?? touchEvent.changedTouches?.[0];
  return touch
    ? { x: touch.clientX + event.delta.x, y: touch.clientY + event.delta.y }
    : undefined;
}

export function dragPointerY(
  event: DragMoveEvent | DragOverEvent | DragEndEvent,
): number | undefined {
  return dragPointer(event)?.y;
}
