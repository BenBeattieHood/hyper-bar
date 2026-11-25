import {
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent,
} from 'react';
import type { SelectableDragItem } from '../types';
import { dragSelectionId } from '../lib/dragSelection';

const MARQUEE_ACTIVATION_DISTANCE = 5;

interface MarqueeSession {
  active: boolean;
  additive: boolean;
  baseIds: Set<string>;
  originX: number;
  originY: number;
  pointerId: number;
}

interface UseMarqueeSelectionOptions {
  items: readonly SelectableDragItem[];
  selectedItemIds: ReadonlySet<string>;
  onSelectionChange: (items: readonly SelectableDragItem[]) => void;
}

function rectanglesIntersect(left: DOMRect, right: DOMRect): boolean {
  return left.left <= right.right && left.right >= right.left &&
    left.top <= right.bottom && left.bottom >= right.top;
}

export function useMarqueeSelection({
  items,
  selectedItemIds,
  onSelectionChange,
}: UseMarqueeSelectionOptions) {
  const sessionRef = useRef<MarqueeSession | undefined>(undefined);
  const [marqueeStyle, setMarqueeStyle] = useState<CSSProperties>();

  const endSelection = (
    event: PointerEvent<HTMLElement>,
    cancelled: boolean,
  ) => {
    const session = sessionRef.current;
    if (!session || session.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (session.active) {
      event.preventDefault();
      event.stopPropagation();
    } else if (!cancelled && !session.additive) {
      onSelectionChange([]);
    }
    sessionRef.current = undefined;
    setMarqueeStyle(undefined);
  };

  return {
    marqueeSelecting: marqueeStyle !== undefined,
    marqueeStyle,
    marqueeHandlers: {
      onPointerDownCapture: (event: PointerEvent<HTMLElement>) => {
        if (
          event.button !== 0 ||
          event.pointerType !== 'mouse' ||
          !(event.target instanceof Element) ||
          event.target.closest(
            'button, input, textarea, [contenteditable="true"], [data-drag-selection-id], [draggable="true"]',
          )
        ) return;
        const additive = event.metaKey || event.ctrlKey;
        sessionRef.current = {
          active: false,
          additive,
          baseIds: additive ? new Set(selectedItemIds) : new Set(),
          originX: event.clientX,
          originY: event.clientY,
          pointerId: event.pointerId,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
      },
      onPointerMove: (event: PointerEvent<HTMLElement>) => {
        const session = sessionRef.current;
        if (!session || session.pointerId !== event.pointerId) return;
        if (
          !session.active &&
          Math.hypot(
            event.clientX - session.originX,
            event.clientY - session.originY,
          ) < MARQUEE_ACTIVATION_DISTANCE
        ) return;
        session.active = true;
        event.preventDefault();
        event.stopPropagation();
        const surfaceBounds = event.currentTarget.getBoundingClientRect();
        const currentX = Math.min(
          Math.max(event.clientX, surfaceBounds.left),
          surfaceBounds.right,
        );
        const currentY = Math.min(
          Math.max(event.clientY, surfaceBounds.top),
          surfaceBounds.bottom,
        );
        const selectionBounds = new DOMRect(
          Math.min(session.originX, currentX),
          Math.min(session.originY, currentY),
          Math.abs(currentX - session.originX),
          Math.abs(currentY - session.originY),
        );
        setMarqueeStyle({
          left: selectionBounds.left - surfaceBounds.left + event.currentTarget.scrollLeft,
          top: selectionBounds.top - surfaceBounds.top + event.currentTarget.scrollTop,
          width: selectionBounds.width,
          height: selectionBounds.height,
        });
        const overlappingIds = new Set<string>();
        event.currentTarget
          .querySelectorAll<HTMLElement>('[data-drag-selection-id]')
          .forEach((element) => {
            const id = element.dataset.dragSelectionId;
            const bounds = element.getBoundingClientRect();
            if (
              id && bounds.width > 0 && bounds.height > 0 &&
              rectanglesIntersect(selectionBounds, bounds)
            ) overlappingIds.add(id);
          });
        const nextIds = new Set(session.baseIds);
        for (const id of overlappingIds) {
          if (session.additive && nextIds.has(id)) nextIds.delete(id);
          else nextIds.add(id);
        }
        onSelectionChange(items.filter((item) => nextIds.has(dragSelectionId(item))));
      },
      onPointerUp: (event: PointerEvent<HTMLElement>) => {
        endSelection(event, false);
      },
      onPointerCancel: (event: PointerEvent<HTMLElement>) => {
        endSelection(event, true);
      },
    },
  };
}