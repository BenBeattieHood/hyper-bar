/** A DOM listener: where it listens, for what, and with which options. */
export type DomListener = readonly [
  target: EventTarget,
  type: string,
  listener: (event: never) => void,
  options?: boolean | AddEventListenerOptions,
];

/** Adds every listener, answering a function that removes them all, as an effect's cleanup does. */
export function listen(...listeners: readonly DomListener[]): () => void {
  for (const [target, type, listener, options] of listeners) {
    target.addEventListener(type, listener as EventListener, options);
  }
  return () => {
    for (const [target, type, listener, options] of listeners) {
      target.removeEventListener(type, listener as EventListener, options);
    }
  };
}

/**
 * Whether an event's target lies inside `element`, or is it. Duck-typed, since
 * nodes in another frame's document fail `instanceof Node` here.
 */
export function isWithin(element: Element | null, target: EventTarget | null): boolean {
  return Boolean(element && target && typeof (target as Partial<Node>).nodeType === 'number' &&
    element.contains(target as Node));
}
