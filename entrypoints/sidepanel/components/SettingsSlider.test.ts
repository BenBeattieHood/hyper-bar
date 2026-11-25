import { describe, expect, it } from 'vitest';
import { sliderStops } from './SettingsSlider';

describe('slider stops', () => {
  it('marks each value a stepped slider can take, spread evenly over the thumb travel', () => {
    const stops = sliderStops(3, 15, 1);

    expect(stops.map((stop) => stop.value)).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
    expect(stops[0]?.share).toBe(0);
    expect(stops[6]?.share).toBe(0.5);
    expect(stops.at(-1)?.share).toBe(1);
  });

  it('ends at the last value a step reaches when it falls short of the maximum', () => {
    expect(sliderStops(0, 10, 3)).toEqual([
      { share: 0, value: 0 },
      { share: 0.3, value: 3 },
      { share: 0.6, value: 6 },
      { share: 0.9, value: 9 },
    ]);
  });
});
