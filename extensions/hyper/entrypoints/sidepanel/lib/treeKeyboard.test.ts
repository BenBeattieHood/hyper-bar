import { describe, expect, it } from 'vitest';
import { isTypeaheadKey, treeKeyAction, typeaheadMatch } from './treeKeyboard';

// docs/            (open)
//   guide          (bookmark)
//   api/           (closed)
// pane-row/        (a split view folder, drawn as its panes)
//   left, right
// notes            (bookmark)
const items = [
  { nodeId: 'docs', ancestorIds: [], isFolder: true },
  { nodeId: 'guide', ancestorIds: ['docs'], isFolder: false },
  { nodeId: 'api', ancestorIds: ['docs'], isFolder: true },
  { nodeId: 'left', ancestorIds: ['split'], isFolder: false },
  { nodeId: 'right', ancestorIds: ['split'], isFolder: false },
  { nodeId: 'notes', ancestorIds: [], isFolder: false },
];
const collapsed = (nodeId: string) => nodeId === 'api';

describe('treeKeyAction', () => {
  it('steps through the rows on show, stopping at either end', () => {
    expect(treeKeyAction(items, 'docs', 'ArrowDown', collapsed)).toEqual({ kind: 'focus', nodeId: 'guide' });
    expect(treeKeyAction(items, 'guide', 'ArrowUp', collapsed)).toEqual({ kind: 'focus', nodeId: 'docs' });
    expect(treeKeyAction(items, 'docs', 'ArrowUp', collapsed)).toBeUndefined();
    expect(treeKeyAction(items, 'notes', 'ArrowDown', collapsed)).toBeUndefined();
  });

  it('jumps to the first and last rows', () => {
    expect(treeKeyAction(items, 'api', 'Home', collapsed)).toEqual({ kind: 'focus', nodeId: 'docs' });
    expect(treeKeyAction(items, 'api', 'End', collapsed)).toEqual({ kind: 'focus', nodeId: 'notes' });
    expect(treeKeyAction(items, 'notes', 'End', collapsed)).toBeUndefined();
  });

  it('opens a closed folder with Right, then steps into it', () => {
    expect(treeKeyAction(items, 'api', 'ArrowRight', collapsed)).toEqual({ kind: 'expand', nodeId: 'api' });
    expect(treeKeyAction(items, 'docs', 'ArrowRight', collapsed)).toEqual({ kind: 'focus', nodeId: 'guide' });
    expect(treeKeyAction(items, 'guide', 'ArrowRight', collapsed)).toBeUndefined();
    expect(treeKeyAction(items, 'api', 'ArrowRight', () => false)).toBeUndefined();
  });

  it('closes an open folder with Left, else steps out to the folder holding the row', () => {
    expect(treeKeyAction(items, 'docs', 'ArrowLeft', collapsed)).toEqual({ kind: 'collapse', nodeId: 'docs' });
    expect(treeKeyAction(items, 'api', 'ArrowLeft', collapsed)).toEqual({ kind: 'focus', nodeId: 'docs' });
    expect(treeKeyAction(items, 'guide', 'ArrowLeft', collapsed)).toEqual({ kind: 'focus', nodeId: 'docs' });
    expect(treeKeyAction(items, 'notes', 'ArrowLeft', collapsed)).toBeUndefined();
    // A pane's split view folder is not a row, so Left has nowhere to go.
    expect(treeKeyAction(items, 'left', 'ArrowLeft', collapsed)).toBeUndefined();
  });

  it('opens the row with Enter and ignores rows it cannot find', () => {
    expect(treeKeyAction(items, 'guide', 'Enter', collapsed)).toEqual({ kind: 'activate', nodeId: 'guide' });
    expect(treeKeyAction(items, 'gone', 'ArrowDown', collapsed)).toBeUndefined();
    expect(treeKeyAction(items, 'guide', 'Tab', collapsed)).toBeUndefined();
  });
});

describe('type-ahead', () => {
  const titled = [
    { nodeId: 'a', title: 'Alpha' },
    { nodeId: 'b', title: 'beta' },
    { nodeId: 'c', title: '  Alpine' },
    { nodeId: 'd', title: 'Gamma' },
  ];

  it('takes printable characters but leaves space, slash and shortcuts to the sidebar', () => {
    const key = (value: string, modifiers: Partial<Record<'altKey' | 'ctrlKey' | 'metaKey', boolean>> = {}) =>
      isTypeaheadKey({ altKey: false, ctrlKey: false, key: value, metaKey: false, ...modifiers });
    expect(key('a')).toBe(true);
    expect(key('A')).toBe(true);
    expect(key(' ')).toBe(false);
    expect(key('/')).toBe(false);
    expect(key('ArrowDown')).toBe(false);
    expect(key('c', { metaKey: true })).toBe(false);
    expect(key('a', { altKey: true })).toBe(false);
  });

  it('moves to the next row starting with a character, wrapping round', () => {
    expect(typeaheadMatch(titled, 'a', 'a')).toBe('c');
    expect(typeaheadMatch(titled, 'c', 'a')).toBe('a');
    expect(typeaheadMatch(titled, 'a', 'B')).toBe('b');
    expect(typeaheadMatch(titled, undefined, 'g')).toBe('d');
    expect(typeaheadMatch(titled, 'a', 'z')).toBeUndefined();
  });

  it('matches a typed string from the current row, and cycles on a repeated character', () => {
    expect(typeaheadMatch(titled, 'a', 'alp')).toBe('a');
    expect(typeaheadMatch(titled, 'a', 'alpi')).toBe('c');
    expect(typeaheadMatch(titled, 'a', 'aa')).toBe('c');
  });
});
