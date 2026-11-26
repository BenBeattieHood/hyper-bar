/**
 * Rebuilds `next` reusing every part of `previous` that did not change.
 *
 * Each reconciliation reads the browser afresh, so an unchanged bookmark tree
 * still arrives as new arrays and objects. A view that renders from the model
 * cannot tell that apart from a real edit, and would rebuild on every passing
 * navigation event. Returning the previous reference wherever the value is
 * equal makes identity mean what a reader assumes it means: this is the same
 * thing you were shown last time.
 *
 * The comparison is structural rather than a hash, so it is exact, and it
 * preserves identity at every depth: an untouched space keeps its reference
 * even when a sibling changes.
 */
export function preserveIdentity<T>(previous: T, next: T): T {
  if (Object.is(previous, next)) return previous;
  if (
    typeof previous !== 'object' || previous === null ||
    typeof next !== 'object' || next === null
  ) return next;
  if (Array.isArray(previous) !== Array.isArray(next)) return next;

  if (Array.isArray(previous) && Array.isArray(next)) {
    if (previous.length !== next.length) {
      return next.map((entry, index) => preserveIdentity(previous[index], entry)) as T;
    }
    const merged = next.map((entry, index) => preserveIdentity(previous[index], entry));
    return merged.every((entry, index) => Object.is(entry, previous[index]))
      ? previous
      : merged as T;
  }

  // A Map or Set holds nothing in its own enumerable keys, so the structural
  // walk below would find every one of them equal to every other and hand back
  // the previous value forever. `hyper.backings` is a Map, so that silently
  // pinned it to the empty one built at revision 0.
  if (previous instanceof Map || next instanceof Map) {
    if (!(previous instanceof Map) || !(next instanceof Map)) return next;
    if (previous.size !== next.size) return next;
    for (const [key, value] of next) {
      if (!previous.has(key)) return next;
      if (!Object.is(preserveIdentity(previous.get(key), value), previous.get(key))) return next;
    }
    return previous;
  }

  if (previous instanceof Set || next instanceof Set) {
    if (!(previous instanceof Set) || !(next instanceof Set)) return next;
    if (previous.size !== next.size) return next;
    for (const entry of next) if (!previous.has(entry)) return next;
    return previous;
  }

  const previousKeys = Object.keys(previous);
  const nextKeys = Object.keys(next);
  const merged: Record<string, unknown> = {};
  let identical = previousKeys.length === nextKeys.length;
  for (const key of nextKeys) {
    const previousValue = (previous as Record<string, unknown>)[key];
    const nextValue = (next as Record<string, unknown>)[key];
    const hasPreviousKey = Object.hasOwn(previous, key);
    const value = hasPreviousKey
      ? preserveIdentity(previousValue, nextValue)
      : nextValue;
    // Assignment to an own `__proto__` key would invoke Object.prototype's
    // setter; define it as data so persisted records remain inert.
    Object.defineProperty(merged, key, {
      configurable: true,
      enumerable: true,
      value,
      writable: true,
    });
    if (identical && (!hasPreviousKey || !Object.is(value, previousValue))) identical = false;
  }
  return identical ? previous : merged as T;
}
