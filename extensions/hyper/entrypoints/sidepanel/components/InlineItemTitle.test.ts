import { describe, expect, it } from 'vitest';
import { titleClickIntervalStartsEditing } from '@hyper/ui';

describe('title rename click timing', () => {
  it('starts editing only between 200 and 800 milliseconds', () => {
    expect(titleClickIntervalStartsEditing(undefined, 500)).toBe(false);
    expect(titleClickIntervalStartsEditing(500, 700)).toBe(false);
    expect(titleClickIntervalStartsEditing(500, 701)).toBe(true);
    expect(titleClickIntervalStartsEditing(500, 1_299)).toBe(true);
    expect(titleClickIntervalStartsEditing(500, 1_300)).toBe(false);
  });

  it('does not treat reversed timestamps as a valid interval', () => {
    expect(titleClickIntervalStartsEditing(700, 500)).toBe(false);
  });
});
