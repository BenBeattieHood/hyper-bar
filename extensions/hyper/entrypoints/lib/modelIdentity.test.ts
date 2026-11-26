import { describe, expect, it } from 'vitest';
import { preserveIdentity } from './modelIdentity';

describe('preserveIdentity', () => {
  it('returns the previous value when nothing changed', () => {
    const previous = { children: [{ id: 'a' }], id: 'root' };
    const next = { children: [{ id: 'a' }], id: 'root' };

    expect(preserveIdentity(previous, next)).toBe(previous);
  });

  it('keeps untouched siblings while adopting the changed one', () => {
    const previous = { children: [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }] };
    const next = { children: [{ id: 'a', title: 'A' }, { id: 'b', title: 'B2' }] };

    const merged = preserveIdentity(previous, next);

    expect(merged).not.toBe(previous);
    expect(merged.children[0]).toBe(previous.children[0]);
    expect(merged.children[1]).toEqual({ id: 'b', title: 'B2' });
  });

  it('adopts a changed length and keeps the entries that survived', () => {
    const previous = { children: [{ id: 'a' }, { id: 'b' }] };
    const next = { children: [{ id: 'a' }] };

    const merged = preserveIdentity(previous, next);

    expect(merged.children).toHaveLength(1);
    expect(merged.children[0]).toBe(previous.children[0]);
  });

  it('does not treat a removed key as unchanged', () => {
    const previous = { id: 'a', url: 'https://example.com' };
    const next = { id: 'a' } as typeof previous;

    expect(preserveIdentity(previous, next)).toEqual({ id: 'a' });
  });

  it('preserves prototype-shaped keys as own data properties', () => {
    const previous = Object.fromEntries([['__proto__', { count: 1 }]]);
    const next = Object.fromEntries([['__proto__', { count: 2 }]]);

    const merged = preserveIdentity(previous, next);

    expect(Object.hasOwn(merged, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(merged)).toBe(Object.prototype);
    expect(merged.__proto__).toEqual({ count: 2 });
  });

  it('adopts an inherited-name key even when its inherited value matches', () => {
    const previous: Record<string, unknown> = { id: Object };
    const next = Object.fromEntries([['constructor', Object]]) as Record<string, unknown>;

    const merged = preserveIdentity(previous, next);

    expect(merged).not.toBe(previous);
    expect(Object.hasOwn(merged, 'constructor')).toBe(true);
    expect(Object.hasOwn(merged, 'id')).toBe(false);
  });

  it('does not confuse an array with an object', () => {
    expect(preserveIdentity({ 0: 'a' } as unknown as string[], ['a'])).toEqual(['a']);
  });

  it('adopts a changed map rather than reading it as an empty object', () => {
    // A Map has no own enumerable keys, so structural comparison by `Object.keys`
    // finds every map identical to every other. `hyper.backings` is a Map, and
    // treating it as unchanged froze it at the empty one from revision 0.
    const previous = new Map([['a', 1]]);
    const next = new Map([['a', 1], ['b', 2]]);

    expect(preserveIdentity(previous, next)).toBe(next);
  });

  it('keeps an unchanged map so identity still means change', () => {
    const previous = new Map([['a', 1]]);

    expect(preserveIdentity(previous, new Map([['a', 1]]))).toBe(previous);
  });

  it('adopts a changed set', () => {
    const next = new Set(['a', 'b']);

    expect(preserveIdentity(new Set(['a']), next)).toBe(next);
    const same = new Set(['a']);
    expect(preserveIdentity(same, new Set(['a']))).toBe(same);
  });

  it('adopts primitives and null directly', () => {
    expect(preserveIdentity(1, 2)).toBe(2);
    expect(preserveIdentity({ id: 'a' } as unknown as null, null)).toBe(null);
  });
});
