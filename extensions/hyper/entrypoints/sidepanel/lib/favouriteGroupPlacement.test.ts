import { describe, expect, it } from 'vitest';
import { tileListBox } from './favouriteGroupPlacement';

describe('tileListBox', () => {
  const section = { bottom: 900, left: 0, right: 250, top: 100 };
  const viewport = { bottom: 892, top: 8 };

  it('drops from the tile, shifted left to stay inside the section padding', () => {
    expect(tileListBox(section, { bottom: 150, left: 20, right: 60, top: 110 }, 10, viewport))
      .toEqual({ left: 10, maxHeight: 742, top: 50, width: 230 });
  });

  it('opens above a tile too near the bottom to list below it', () => {
    expect(tileListBox(section, { bottom: 850, left: 10, right: 50, top: 810 }, 10, viewport))
      .toEqual({ bottom: 90, left: 10, maxHeight: 802, width: 230 });
  });
});
