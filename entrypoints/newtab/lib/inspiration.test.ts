import { describe, expect, it } from 'vitest';
import { INSPIRATION_LINES, randomInspiration } from './inspiration';

describe('new-tab inspiration', () => {
  it('provides a substantial local set without duplicates', () => {
    expect(INSPIRATION_LINES.length).toBeGreaterThanOrEqual(30);
    expect(new Set(INSPIRATION_LINES)).toHaveLength(INSPIRATION_LINES.length);
  });

  it('selects a stable line from the supplied random value', () => {
    expect(randomInspiration(() => 0)).toBe(INSPIRATION_LINES[0]);
    expect(randomInspiration(() => 0.999)).toBe(INSPIRATION_LINES.at(-1));
  });
});