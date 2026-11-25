import {
  MouseSensor,
  type MouseSensorOptions,
  type SensorInstance,
  type SensorProps,
} from '@dnd-kit/core';
import type { DragEvent as ReactDragEvent, MouseEvent as ReactMouseEvent } from 'react';
import { copyModifierHeld } from './drag';
import { listen } from './listen';

/** The type a Hyper drag carries its token in; a drop without it is not Hyper's. */
export const HYPER_DRAG_TYPE = 'application/x-hyper-drag';

/** Dispatched on the document when a drag shared from another window ends there. */
export const SHARED_DRAG_ENDED = 'hyper-shared-drag-ended';

// dnd-kit draws the dragged item, so the browser draws nothing of its own.
const emptyDragImage = typeof Image === 'undefined'
  ? undefined
  : Object.assign(new Image(), {
      src: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
    });

// Far off the page, so nothing collides and every drop indicator clears.
const OUTSIDE = { x: -100_000, y: -100_000 };

/** What a hidden stand-in drags: another window's shared drag, or something from outside Hyper. */
export type StandInDrag = 'external' | 'shared';

const standInStarts = new WeakMap<Event, StandInDrag>();

// What a link, text, or file dragged from a page or another app carries.
const EXTERNAL_DRAG_TYPES = new Set(['Files', 'text/html', 'text/plain', 'text/uri-list', 'text/x-moz-url']);

export interface NativeDragSensorOptions {
  /** Whether a drop carries the token of the drag another window shared with this sidebar. */
  accepts(dataTransfer: DataTransfer): boolean;
  /** Takes what a drag from outside Hyper dropped, while the browser still shows it. */
  acceptsExternal(dataTransfer: DataTransfer): boolean;
  /** The pointer left this sidebar mid-drag, perhaps for another window's. */
  onLeave(): void;
  /** Writes the outgoing drag's data while the browser still allows it. */
  prepare(dataTransfer: DataTransfer): void;
}

export function carriesHyperDrag(event: DragEvent): boolean {
  return Boolean(event.dataTransfer?.types.includes(HYPER_DRAG_TYPE));
}

/** A drag from a page, another app, or the browser's own bookmarks or tabs, but never Hyper's. */
export function carriesExternalDrag(event: DragEvent): boolean {
  const types = event.dataTransfer?.types ?? [];
  return !types.includes(HYPER_DRAG_TYPE) && types.some((type) => EXTERNAL_DRAG_TYPES.has(type));
}

const carries = (drag: StandInDrag, event: DragEvent) =>
  drag === 'shared' ? carriesHyperDrag(event) : carriesExternalDrag(event);

/** Starts this sidebar's stand-in for a drag that began elsewhere, where the drag came in. */
export function startStandInDrag(standIn: Element, entry: DragEvent, drag: StandInDrag): void {
  const start = new DragEvent('dragenter', {
    altKey: entry.altKey,
    bubbles: true,
    clientX: entry.clientX,
    clientY: entry.clientY,
    ctrlKey: entry.ctrlKey,
    metaKey: entry.metaKey,
  });
  standInStarts.set(start, drag);
  standIn.dispatchEvent(start);
}

/**
 * Drives dnd-kit from the browser's own drag and drop, which, unlike pointer
 * events, can leave the sidebar for another window. A row dragged here is a
 * native drag; a drag shared from another window, or one from outside Hyper,
 * plays out on a stand-in draggable that `startStandInDrag` starts.
 */
export class NativeDragSensor implements SensorInstance {
  static activators = [
    {
      eventName: 'onDragStart' as const,
      handler: ({ nativeEvent }: ReactDragEvent, options: NativeDragSensorOptions) => {
        const transfer = nativeEvent.dataTransfer;
        if (!transfer) return false;
        transfer.clearData();
        transfer.effectAllowed = 'copyMove';
        options.prepare(transfer);
        if (emptyDragImage) transfer.setDragImage(emptyDragImage, 0, 0);
        return true;
      },
    },
    {
      eventName: 'onDragEnter' as const,
      handler: ({ nativeEvent }: ReactDragEvent) => standInStarts.has(nativeEvent),
    },
  ];

  autoScrollEnabled = true;
  private readonly document: Document;
  private finished = false;
  private last: { x: number; y: number } | undefined;
  private readonly unlisten: () => void;
  private readonly props: SensorProps<NativeDragSensorOptions>;
  private readonly source: EventTarget | null;
  private readonly standIn: StandInDrag | undefined;
  private started = false;

  constructor(props: SensorProps<NativeDragSensorOptions>) {
    this.props = props;
    const event = props.event as DragEvent;
    this.standIn = standInStarts.get(event);
    this.source = this.standIn ? null : event.target;
    this.document = (event.target as { ownerDocument?: Document | null } | null)?.ownerDocument ?? document;
    this.unlisten = listen(
      // A move onto another row can bring only its dragenter, so both follow the pointer.
      [this.document, 'dragenter', this.handleOver],
      [this.document, 'dragover', this.handleOver],
      [this.document, 'dragleave', this.handleLeave],
      [this.document, 'drop', this.handleDrop],
      // A row removed mid-drag no longer bubbles its dragend to the document.
      ...this.source ? [[this.source, 'dragend', this.handleEnd] as const] : [],
      ...this.standIn === 'shared' ? [[this.document, SHARED_DRAG_ENDED, this.handleEnd] as const] : [],
      // No mouse events reach a page during a native drag, so one means a drag from outside has ended.
      ...this.standIn === 'external' ? [[this.document, 'mousemove', this.handleEnd] as const] : [],
    );
    const start = () => {
      if (this.finished) return;
      this.started = true;
      props.onStart({ x: event.clientX, y: event.clientY });
    };
    // The browser abandons a drag whose row is no longer under the pointer once
    // dragstart returns, and starting collapses the row, so it starts a task later.
    if (this.standIn) start();
    else setTimeout(start, 0);
  }

  private readonly handleOver = (event: DragEvent) => {
    if (this.standIn && !carries(this.standIn, event)) return;
    event.preventDefault();
    if (event.dataTransfer) {
      // A drop from outside Hyper only ever adds links, so it always copies.
      event.dataTransfer.dropEffect = this.standIn === 'external' || copyModifierHeld(event) ? 'copy' : 'move';
    }
    if (!this.started || (this.last?.x === event.clientX && this.last.y === event.clientY)) return;
    this.last = { x: event.clientX, y: event.clientY };
    this.props.onMove(this.last);
  };

  private readonly handleLeave = (event: DragEvent) => {
    // Moving between rows names the row entered; only leaving the sidebar names none.
    if (event.relatedTarget !== null || !this.started) return;
    this.last = undefined;
    if (this.standIn) {
      this.handleEnd();
      return;
    }
    this.props.onMove(OUTSIDE);
    this.props.options.onLeave();
  };

  private readonly handleDrop = (event: DragEvent) => {
    event.preventDefault();
    const transfer = event.dataTransfer;
    const { options } = this.props;
    const accepted = this.started && (!this.standIn || Boolean(transfer && (this.standIn === 'shared'
      ? options.accepts(transfer)
      : options.acceptsExternal(transfer))));
    this.finish();
    if (accepted) this.props.onEnd();
    else this.props.onCancel();
  };

  private readonly handleEnd = () => {
    if (this.finished) return;
    this.finish();
    this.props.onCancel();
  };

  private finish() {
    this.finished = true;
    this.unlisten();
  }
}

/** The mouse drags only what the browser cannot drag natively, such as a space's dot. */
export class PointerOnlyMouseSensor extends MouseSensor {
  static override activators = [{
    eventName: 'onMouseDown' as const,
    handler: (event: ReactMouseEvent, options: MouseSensorOptions) => {
      const target = event.nativeEvent.target as Partial<Element> | null;
      if (target?.closest?.('[draggable="true"]')) return false;
      return MouseSensor.activators[0]!.handler(event, options);
    },
  }];
}
