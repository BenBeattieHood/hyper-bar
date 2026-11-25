import { describe, expect, it } from 'vitest';
import { spaceDeletionQuestion } from './SpaceDeletePrompt';

describe('space deletion question', () => {
  it('counts the bookmarks the space holds', () => {
    expect(spaceDeletionQuestion('Work', 12))
      .toBe('Work has 12 bookmarks. Move these to your default space?');
    expect(spaceDeletionQuestion('Work', 1))
      .toBe('Work has 1 bookmark. Move it to your default space?');
  });
});
