import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import {
  useRef,
  useState,
  type MouseEvent,
  type PointerEvent,
  type RefObject,
} from 'react';
import { isWithin } from '../lib/listen';
import { popoverMotion } from './WorkspaceMotion';

/** Slot ids of tiles that name a page; placeholders and the bookmarks button do not. */
const isTileSlot = (slotId: string) =>
  slotId.startsWith('favourite:') || slotId.startsWith('recent:');

/**
 * Tracks which favourite or recent tile the mouse is over. The pointer may cross
 * the gaps between tiles and move onto the label, or a grouped tile's list,
 * without the tile losing hover.
 */
export function useFavouriteHover() {
  const [slotId, setSlotId] = useState<string>();
  const gridRef = useRef<HTMLDivElement>(null);
  const labelRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const leave = (event: PointerEvent, ...keepInside: RefObject<Element | null>[]) => {
    if (!keepInside.some((ref) => isWithin(ref.current, event.relatedTarget))) setSlotId(undefined);
  };

  return {
    slotId,
    gridRef,
    labelRef,
    listRef,
    gridHandlers: {
      onPointerOver: (event: PointerEvent<HTMLElement>) => {
        if (event.pointerType === 'touch' || !(event.target instanceof Element)) return;
        const slot = event.target.closest('.favourite-slot');
        if (!slot) return;
        const id = slot.getAttribute('data-slot-id');
        setSlotId(id && isTileSlot(id) ? id : undefined);
      },
      onPointerLeave: (event: PointerEvent) => leave(event, labelRef, listRef),
    },
    onLabelPointerLeave: (event: PointerEvent) => leave(event, gridRef),
    onListPointerLeave: (event: PointerEvent) => leave(event, gridRef),
  };
}

/** Repeats a mouse event on the hovered tile, so the label acts as part of it. */
function forwardToTile(
  event: MouseEvent<HTMLElement>,
  grid: HTMLElement | null,
  slotId: string,
) {
  event.preventDefault();
  const tile = grid?.querySelector(`[data-slot-id="${CSS.escape(slotId)}"] .favourite-tile`);
  const { altKey, button, buttons, clientX, clientY, ctrlKey, metaKey, screenX, screenY, shiftKey } = event;
  tile?.dispatchEvent(new globalThis.MouseEvent(event.type, {
    altKey, button, buttons, clientX, clientY, ctrlKey, metaKey, screenX, screenY, shiftKey,
    bubbles: true,
    cancelable: true,
    // Zero marks a click the tile did not see start, as keyboard clicks are.
    detail: 0,
    view: window,
  }));
}

export function FavouriteHoverLabel({
  grid,
  labelRef,
  onPointerLeave,
  slotId,
  text,
}: {
  grid: RefObject<HTMLElement | null>;
  labelRef: RefObject<HTMLDivElement | null>;
  onPointerLeave: (event: PointerEvent) => void;
  slotId?: string;
  text?: string;
}) {
  const reduceMotion = useReducedMotion();
  const forward = (event: MouseEvent<HTMLElement>) => {
    if (slotId) forwardToTile(event, grid.current, slotId);
  };
  return (
    <AnimatePresence>
      {slotId && text && (
        <motion.div
          key="label"
          ref={labelRef}
          className="favourite-hover-label"
          aria-hidden="true"
          {...popoverMotion(reduceMotion, 0.2, 0.24)}
          onPointerLeave={onPointerLeave}
          onClick={forward}
          onAuxClick={(event) => event.button === 1 && forward(event)}
          onMouseDown={(event) => event.button === 1 && event.preventDefault()}
          onContextMenu={forward}
        >
          <span>{text}</span>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
