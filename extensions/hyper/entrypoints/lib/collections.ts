export type NonEmptyArray<T> = readonly [T, ...T[]];

/**
 * Encodes non-emptiness in the type so a modular index needs no cast and no
 * unreachable fallback branch invented at the call site.
 */
export function pickCyclic<T>(items: NonEmptyArray<T>, index: number): T {
  const [first] = items;
  return items[Math.abs(Math.trunc(index)) % items.length] ?? first;
}

/** The item `text` always maps to, by the sum of its character codes. */
export function pickByText<T>(items: NonEmptyArray<T>, text: string): T {
  return pickCyclic(items, Array.from(text).reduce((sum, character) => sum + character.charCodeAt(0), 0));
}

/** A plain object, so neither `null` nor an array. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Appends `value` to the list kept under `key`, starting the list if there is none. */
export function addToMapList<Key, Value>(map: Map<Key, Value[]>, key: Key, value: Value): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/** Adds `value` to the set kept under `key`, starting the set if there is none. */
export function addToMapSet<Key, Value>(map: Map<Key, Set<Value>>, key: Key, value: Value): void {
  const set = map.get(key);
  if (set) set.add(value);
  else map.set(key, new Set([value]));
}

/** A number that is neither NaN nor infinite. */
export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** `value` held within `min` and `max`, inclusive. */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** A whole number from zero up, as counts and indexes are. */
export function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
