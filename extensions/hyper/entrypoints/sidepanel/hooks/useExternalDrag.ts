import { useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import {
  externalDragItem,
  snapshotExternalDrop,
  type ExternalDragItem,
  type ExternalDropSnapshot,
} from '../lib/externalDrop';
import { carriesExternalDrag, startStandInDrag } from '../lib/nativeDrag';
import { listen } from '../lib/listen';

const EXTERNAL_STAND_IN_ID = 'external-drag';

/**
 * Takes in links, text, and files dragged from a page, another app, or the
 * browser's own bookmarks and tabs. Such a drag plays out on a hidden stand-in,
 * so every drop target and its indicator serve it as they serve a row, and
 * what it holds is read once it drops, the only time the browser shows it.
 */
export function useExternalDrag({ dragging }: { dragging(): boolean }) {
  const latest = useRef(dragging);
  latest.current = dragging;
  const [item, setItem] = useState<ExternalDragItem>();
  const standInRef = useRef<HTMLDivElement | null>(null);
  const dropped = useRef<ExternalDropSnapshot | undefined>(undefined);

  useEffect(() => {
    // Text dragged within the sidebar, such as from a field, is the field's to drop.
    let localDrag = false;
    const started = () => {
      localDrag = true;
    };
    const ended = () => {
      localDrag = false;
    };
    const join = (event: DragEvent) => {
      if (localDrag || latest.current() || !carriesExternalDrag(event) || !event.dataTransfer) return;
      event.preventDefault();
      dropped.current = undefined;
      flushSync(() => setItem(externalDragItem(event.dataTransfer!)));
      const standIn = standInRef.current;
      if (standIn) startStandInDrag(standIn, event, 'external');
    };
    // A row removed mid-drag never bubbles its dragend, but mouse events resume once any drag is over.
    return listen(
      [document, 'dragstart', started, true],
      ...(['dragend', 'drop', 'mousemove'] as const).map((ending) => [document, ending, ended, true] as const),
      [document, 'dragenter', join, true],
      [document, 'dragover', join, true],
    );
  }, []);

  const incoming = useMemo(() => item && { id: EXTERNAL_STAND_IN_ID, item }, [item]);
  const actions = useMemo(() => ({
    /** Keeps what was dropped, as the browser hides it again once the drop event returns. */
    accept: (transfer: DataTransfer) => {
      dropped.current = snapshotExternalDrop(transfer);
      return true;
    },
    /** Ends the stand-in once its drag has dropped or gone. */
    finish: () => setItem(undefined),
    /** What the drag dropped, once. */
    take: () => {
      const snapshot = dropped.current;
      dropped.current = undefined;
      return snapshot;
    },
  }), []);

  return { ...actions, incoming, standInRef };
}
