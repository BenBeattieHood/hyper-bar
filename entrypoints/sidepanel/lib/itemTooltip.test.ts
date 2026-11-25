import { describe, expect, it } from 'vitest';
import { itemTooltip } from './itemTooltip';

describe('itemTooltip', () => {
  it('puts the title above the address', () => {
    expect(itemTooltip('Example Domain', 'https://example.com/'))
      .toBe('Example Domain\nhttps://example.com/');
  });

  it('shows the title alone when there is no address or the title is the address', () => {
    expect(itemTooltip('New folder')).toBe('New folder');
    expect(itemTooltip('Blank', '')).toBe('Blank');
    expect(itemTooltip('https://example.com/', 'https://example.com/')).toBe('https://example.com/');
  });
});
