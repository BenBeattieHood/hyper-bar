import { useRef, type MouseEvent, type PointerEvent } from 'react';

export interface ItemGestureSnapshot {
  time: number;
  pointerX: number;
  pointerY: number;
  selectionModified: boolean;
}

const snapshot = (event: MouseEvent<HTMLElement>): ItemGestureSnapshot => ({
  time: event.timeStamp,
  pointerX: event.clientX,
  pointerY: event.clientY,
  selectionModified: event.metaKey || event.ctrlKey || event.shiftKey,
});

export function useItemGesture() {
  const start = useRef<ItemGestureSnapshot | undefined>(undefined);

  const onPointerDownCapture = (event: PointerEvent<HTMLElement>) => {
    if (
      event.button !== 0 ||
      (event.target instanceof Element && event.target.closest('input, textarea'))
    ) return;
    start.current = snapshot(event);
  };

  const isPointerClick = (event: MouseEvent<HTMLElement>) => {
    const initial = start.current;
    start.current = undefined;
    return initial !== undefined && isItemClick(initial, snapshot(event));
  };

  const isClick = (event: MouseEvent<HTMLElement>) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey) {
      start.current = undefined;
      return false;
    }
    return event.detail === 0 || isPointerClick(event);
  };

  return { onPointerDownCapture, isClick };
}

const DRAG_DISTANCE = 3;
const CLICK_DURATION = 800;

/**
 * Judges the pointer, not the item, so an item that slides under a still
 * pointer (a scroll, a row tweening above it) keeps the click. The browser only
 * sends the click here when press and release both land on this item.
 */
export function isItemClick(
  start: ItemGestureSnapshot,
  end: ItemGestureSnapshot,
): boolean {
  return !start.selectionModified && !end.selectionModified &&
    end.time - start.time < CLICK_DURATION &&
    Math.hypot(end.pointerX - start.pointerX, end.pointerY - start.pointerY) <=
      DRAG_DISTANCE;
}
