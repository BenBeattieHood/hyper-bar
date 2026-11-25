import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SensorProps } from '@dnd-kit/core';
import type { DragEvent as ReactDragEvent, MouseEvent as ReactMouseEvent } from 'react';
import {
  carriesExternalDrag,
  HYPER_DRAG_TYPE,
  NativeDragSensor,
  PointerOnlyMouseSensor,
  startStandInDrag,
  type NativeDragSensorOptions,
} from './nativeDrag';

const transfer = (entries: Record<string, string> = {}) => {
  const data = new Map<string, string>(Object.entries(entries));
  return {
    clearData: vi.fn(() => data.clear()),
    dropEffect: 'none',
    effectAllowed: 'uninitialized',
    getData: (type: string) => data.get(type) ?? '',
    setData: (type: string, value: string) => void data.set(type, value),
    get types() { return [...data.keys()]; },
  };
};

const dragEvent = (type: string, init: Record<string, unknown> = {}) => Object.assign(
  new Event(type, { bubbles: true, cancelable: true }),
  { altKey: false, clientX: 0, clientY: 0, relatedTarget: undefined, ...init },
);

/** A row in a sidebar document, with the dragstart the browser fired on it. */
const startDrag = ({ started = true } = {}) => {
  const document = new EventTarget();
  const row = Object.assign(new EventTarget(), { ownerDocument: document });
  const dataTransfer = transfer();
  const start = dragEvent('dragstart', { clientX: 10, clientY: 20, dataTransfer });
  row.dispatchEvent(start);
  const options: NativeDragSensorOptions = {
    accepts: vi.fn(() => true),
    acceptsExternal: vi.fn(() => true),
    onLeave: vi.fn(),
    prepare: vi.fn((data: DataTransfer) => data.setData(HYPER_DRAG_TYPE, 'token')),
  };
  const activated = NativeDragSensor.activators[0]!.handler(
    { nativeEvent: start } as unknown as ReactDragEvent,
    options,
  );
  const props = {
    event: start,
    onCancel: vi.fn(),
    onEnd: vi.fn(),
    onMove: vi.fn(),
    onStart: vi.fn(),
    options,
  };
  new NativeDragSensor(props as unknown as SensorProps<NativeDragSensorOptions>);
  if (started) vi.runAllTimers();
  return { activated, dataTransfer, document, options, props, row };
};

/** A drag from outside Hyper entering a sidebar document, played out on its stand-in. */
const enterExternalDrag = () => {
  const document = new EventTarget();
  const standIn = Object.assign(new EventTarget(), { ownerDocument: document });
  let start: Event | undefined;
  standIn.addEventListener('dragenter', (event) => {
    start = event;
  });
  startStandInDrag(standIn as unknown as Element, dragEvent('dragenter', { clientX: 5, clientY: 6 }) as unknown as DragEvent, 'external');
  const options: NativeDragSensorOptions = {
    accepts: vi.fn(() => true),
    acceptsExternal: vi.fn(() => true),
    onLeave: vi.fn(),
    prepare: vi.fn(),
  };
  const activated = NativeDragSensor.activators[1]!.handler(
    { nativeEvent: start } as unknown as ReactDragEvent,
    options,
  );
  const props = { event: start, onCancel: vi.fn(), onEnd: vi.fn(), onMove: vi.fn(), onStart: vi.fn(), options };
  new NativeDragSensor(props as unknown as SensorProps<NativeDragSensorOptions>);
  return { activated, document, options, props };
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('DragEvent', class extends Event {
    clientX: number;
    clientY: number;
    constructor(type: string, init: MouseEventInit = {}) {
      super(type, init);
      this.clientX = init.clientX ?? 0;
      this.clientY = init.clientY ?? 0;
    }
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('native drag sensor', () => {
  it('starts where the browser began the drag, carrying only this drag\'s token', () => {
    const { activated, dataTransfer, options, props } = startDrag();

    expect(activated).toBe(true);
    expect(dataTransfer.clearData).toHaveBeenCalled();
    expect(dataTransfer.effectAllowed).toBe('copyMove');
    expect(options.prepare).toHaveBeenCalledWith(dataTransfer);
    expect(dataTransfer.types).toEqual([HYPER_DRAG_TYPE]);
    expect(props.onStart).toHaveBeenCalledWith({ x: 10, y: 20 });
  });

  it('follows the pointer while it is over the sidebar and lets go of it when it leaves', () => {
    const { document, options, props } = startDrag();
    const over = dragEvent('dragover', { clientX: 15, clientY: 25, dataTransfer: transfer() });

    document.dispatchEvent(over);
    document.dispatchEvent(dragEvent('dragover', { clientX: 15, clientY: 25 }));
    document.dispatchEvent(dragEvent('dragleave', { relatedTarget: {} }));
    expect(over.defaultPrevented).toBe(true);
    expect(props.onMove).toHaveBeenCalledExactlyOnceWith({ x: 15, y: 25 });
    expect(options.onLeave).not.toHaveBeenCalled();

    document.dispatchEvent(dragEvent('dragleave', { relatedTarget: null }));
    expect(props.onMove).toHaveBeenLastCalledWith({ x: -100_000, y: -100_000 });
    expect(options.onLeave).toHaveBeenCalledOnce();
  });

  it('ends on a drop here, and cancels when the drag ends anywhere else', () => {
    const dropped = startDrag();
    dropped.document.dispatchEvent(dragEvent('drop'));
    dropped.row.dispatchEvent(dragEvent('dragend'));
    expect(dropped.props.onEnd).toHaveBeenCalledOnce();
    expect(dropped.props.onCancel).not.toHaveBeenCalled();

    const elsewhere = startDrag();
    elsewhere.row.dispatchEvent(dragEvent('dragend'));
    elsewhere.document.dispatchEvent(dragEvent('dragover', { clientX: 30, clientY: 30 }));
    expect(elsewhere.props.onCancel).toHaveBeenCalledOnce();
    expect(elsewhere.props.onEnd).not.toHaveBeenCalled();
    expect(elsewhere.props.onMove).not.toHaveBeenCalled();
  });

  it('starts only once the browser has kept the drag, which hiding the row could cancel', () => {
    const abandoned = startDrag({ started: false });
    expect(abandoned.props.onStart).not.toHaveBeenCalled();

    abandoned.row.dispatchEvent(dragEvent('dragend'));
    vi.runAllTimers();
    expect(abandoned.props.onCancel).toHaveBeenCalledOnce();
    expect(abandoned.props.onStart).not.toHaveBeenCalled();
  });

  it('tells a drag from outside Hyper from its own', () => {
    const carrying = (entries: Record<string, string>) =>
      carriesExternalDrag(dragEvent('dragenter', { dataTransfer: transfer(entries) }) as unknown as DragEvent);

    expect(carrying({ 'text/uri-list': 'https://example.com/' })).toBe(true);
    expect(carrying({ Files: '' })).toBe(true);
    expect(carrying({ [HYPER_DRAG_TYPE]: 'token', 'text/plain': 'x' })).toBe(false);
    expect(carrying({ 'application/x-custom': 'x' })).toBe(false);
    expect(carriesExternalDrag(dragEvent('dragenter') as unknown as DragEvent)).toBe(false);
  });

  it('plays a drag from outside Hyper on its stand-in, as a copy, and takes what it drops', () => {
    const { activated, document, options, props } = enterExternalDrag();
    expect(activated).toBe(true);
    expect(props.onStart).toHaveBeenCalledWith({ x: 5, y: 6 });

    const shared = dragEvent('dragover', { clientX: 9, clientY: 9, dataTransfer: transfer({ [HYPER_DRAG_TYPE]: 't' }) });
    document.dispatchEvent(shared);
    expect(shared.defaultPrevented).toBe(false);

    const over = transfer({ 'text/uri-list': 'https://example.com/' });
    const overEvent = dragEvent('dragover', { clientX: 15, clientY: 25, dataTransfer: over });
    document.dispatchEvent(overEvent);
    expect(overEvent.defaultPrevented).toBe(true);
    expect(over.dropEffect).toBe('copy');
    expect(props.onMove).toHaveBeenCalledExactlyOnceWith({ x: 15, y: 25 });

    const dropped = transfer({ 'text/uri-list': 'https://example.com/' });
    document.dispatchEvent(dragEvent('drop', { dataTransfer: dropped }));
    expect(options.acceptsExternal).toHaveBeenCalledWith(dropped);
    expect(options.accepts).not.toHaveBeenCalled();
    expect(props.onEnd).toHaveBeenCalledOnce();
  });

  it('cancels a drag from outside Hyper that leaves the sidebar or ends elsewhere', () => {
    const left = enterExternalDrag();
    left.document.dispatchEvent(dragEvent('dragleave', { relatedTarget: null }));
    expect(left.props.onCancel).toHaveBeenCalledOnce();
    expect(left.options.onLeave).not.toHaveBeenCalled();

    const gone = enterExternalDrag();
    gone.document.dispatchEvent(new Event('mousemove'));
    expect(gone.props.onCancel).toHaveBeenCalledOnce();
    gone.document.dispatchEvent(dragEvent('drop', { dataTransfer: transfer() }));
    expect(gone.props.onEnd).not.toHaveBeenCalled();
  });

  it('leaves rows the browser drags to the native sensor', () => {
    const press = (draggable: boolean) => PointerOnlyMouseSensor.activators[0]!.handler(
      { nativeEvent: { button: 0, target: { closest: () => (draggable ? {} : null) } } } as unknown as ReactMouseEvent,
      {},
    );

    expect(press(true)).toBe(false);
    expect(press(false)).toBe(true);
  });
});
