import { describe, expect, it } from 'vitest';
import type { BookmarkNode } from './bookmarks';
import {
  assessStructureHealth,
  classifyBackingRelocation,
  isModelUsable,
  structuralRepairRoles,
} from './modelIntegrity';

function folder(id: string, title: string, children: BookmarkNode[] = []): BookmarkNode {
  return { children, id, title } as BookmarkNode;
}

function tree(hyperChildren: BookmarkNode[] | undefined, extra: BookmarkNode[] = []): BookmarkNode[] {
  const bar = folder('1', 'Bookmarks bar', [
    ...(hyperChildren === undefined ? [] : [folder('hyper', 'hyper', hyperChildren)]),
    ...extra,
  ]);
  return [folder('0', '', [bar])];
}

const completeRoots = [
  folder('favourites', 'favourites'),
  folder('bookmarks', 'bookmarks'),
  folder('spaces', 'spaces'),
];

describe('structural health', () => {
  it('treats a tree with no bookmark bar as unreadable rather than uninstalled', () => {
    expect(assessStructureHealth([])).toEqual({ status: 'unreadable' });
    expect(isModelUsable({ status: 'unreadable' })).toBe(false);
    expect(structuralRepairRoles({ status: 'unreadable' })).toEqual([]);
  });

  it('reports a fresh profile as absent and repairs it by creating every root', () => {
    const health = assessStructureHealth(tree(undefined));
    expect(health).toEqual({ status: 'absent' });
    expect(structuralRepairRoles(health)).toEqual([
      'hyper',
      'favourites',
      'spaces',
      'bookmarks',
    ]);
  });

  it('names exactly the roots that are missing and creates only those', () => {
    const health = assessStructureHealth(tree([
      folder('favourites', 'favourites'),
      folder('spaces', 'spaces'),
    ]));
    expect(health).toEqual({ missing: ['bookmarks'], status: 'incomplete' });
    expect(structuralRepairRoles(health)).toEqual(['bookmarks']);
    expect(isModelUsable(health)).toBe(true);
  });

  it('refuses to repair a duplicated root and never guesses which one is real', () => {
    const health = assessStructureHealth(tree([
      ...completeRoots,
      folder('spaces-copy', 'spaces'),
    ]));
    expect(health).toEqual({
      duplicates: [{ ids: ['spaces', 'spaces-copy'], role: 'spaces' }],
      status: 'ambiguous',
    });
    expect(structuralRepairRoles(health)).toEqual([]);
    expect(isModelUsable(health)).toBe(false);
  });

  it('detects two hyper folders before looking any deeper', () => {
    expect(assessStructureHealth(tree(completeRoots, [folder('hyper-copy', 'hyper')])))
      .toEqual({
        duplicates: [{ ids: ['hyper', 'hyper-copy'], role: 'hyper' }],
        status: 'ambiguous',
      });
  });

  it('accepts a complete structure', () => {
    expect(assessStructureHealth(tree(completeRoots))).toEqual({ status: 'healthy' });
  });
});

describe('backing relocation', () => {
  const tabsFolders = new Map([['tabs-1', 'space-1'], ['tabs-2', 'space-2']]);

  it('releases a backing the user dragged into a visible folder', () => {
    expect(classifyBackingRelocation('bookmarks', tabsFolders, 'space-1'))
      .toEqual({ status: 'released' });
    expect(classifyBackingRelocation(undefined, tabsFolders, 'space-1'))
      .toEqual({ status: 'released' });
  });

  it('reassigns a backing moved between hidden folders and retains one that stayed', () => {
    expect(classifyBackingRelocation('tabs-2', tabsFolders, 'space-1'))
      .toEqual({ spaceId: 'space-2', status: 'reassigned' });
    expect(classifyBackingRelocation('tabs-1', tabsFolders, 'space-1'))
      .toEqual({ status: 'retained' });
  });
});
