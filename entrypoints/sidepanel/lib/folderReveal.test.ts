import { describe, expect, it } from 'vitest';
import { openFolderPath, toggleFolder } from './folderReveal';

const parents: Record<string, string | undefined> = {
  root: undefined,
  docs: 'root',
  guides: 'docs',
  inbox: 'root',
};
const parentOf = (id: string) => parents[id];

describe('openFolderPath', () => {
  it('opens a collapsed folder that a bookmark was made in', () => {
    expect(openFolderPath(new Set(['docs', 'inbox']), 'docs', parentOf))
      .toEqual(new Set(['inbox']));
  });

  it('opens the closed folders above a nested folder too', () => {
    expect(openFolderPath(new Set(['docs', 'guides', 'inbox']), 'guides', parentOf))
      .toEqual(new Set(['inbox']));
  });

  it('keeps the same set when the folder already shows', () => {
    const collapsed = new Set(['inbox']);
    expect(openFolderPath(collapsed, 'guides', parentOf)).toBe(collapsed);
    // The space root is never collapsed, so the toolbar's root target changes nothing.
    expect(openFolderPath(collapsed, 'root', parentOf)).toBe(collapsed);
  });

  it('stops at a parent cycle rather than looping', () => {
    const cyclic = (id: string) => (id === 'a' ? 'b' : 'a');
    expect(openFolderPath(new Set(['a', 'b', 'c']), 'a', cyclic)).toEqual(new Set(['c']));
  });
});

describe('toggleFolder', () => {
  it('opens a collapsed folder and collapses an open one, leaving the set it was given alone', () => {
    const collapsed = new Set(['docs']);
    expect(toggleFolder(collapsed, 'docs')).toEqual(new Set());
    expect(toggleFolder(collapsed, 'inbox')).toEqual(new Set(['docs', 'inbox']));
    expect(collapsed).toEqual(new Set(['docs']));
  });
});
