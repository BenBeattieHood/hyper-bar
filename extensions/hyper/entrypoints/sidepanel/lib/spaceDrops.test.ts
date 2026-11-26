import { describe, expect, it, vi } from 'vitest';
import type { BookmarkNode, Space } from '../../lib/bookmarks';
import { performSpaceDrop, type SpaceDropDependencies } from './spaceDrops';

const space = (id: string, archived?: true): Space => ({ id, title: id, ...(archived ? { archived } : {}) }) as Space;

// Folder order interleaves archived spaces between shown ones.
const folderOrder = ['a', 'x', 'b', 'y', 'c'];
const shown = [space('a'), space('b'), space('c')];
const archived = [space('x', true), space('y', true)];

function setup(spaces: readonly Space[] = shown) {
  const nodeMap = new Map<string, BookmarkNode>([
    ['spaces', { id: 'spaces', title: 'Spaces', children: folderOrder.map((id) => ({ id, title: id })) } as BookmarkNode],
    ...folderOrder.map((id) => [id, { id, title: id }] as [string, BookmarkNode]),
  ]);
  const deps = {
    archivedSpaces: archived,
    browserState: { moveBookmark: vi.fn(), setSpaceArchived: vi.fn(), spacesFolderId: 'spaces' },
    nodeMap,
    spaceDeletion: { request: vi.fn() },
    spaces,
  } satisfies SpaceDropDependencies;
  return deps;
}

const drag = (spaceId: string, isArchived = false) =>
  ({ kind: 'space' as const, spaceId, rootId: spaceId, ...(isArchived ? { archived: true as const } : {}) });

describe('performSpaceDrop', () => {
  it('reorders shown spaces beside the nearer edge of the dot, by real folder index around archived ones', async () => {
    const deps = setup();
    await performSpaceDrop(drag('a'), drag('c'), false, deps);
    expect(deps.browserState.moveBookmark).toHaveBeenCalledWith('a', { parentId: 'spaces', index: 4 });
    await performSpaceDrop(drag('a'), drag('c'), true, deps);
    expect(deps.browserState.moveBookmark).toHaveBeenLastCalledWith('a', { parentId: 'spaces', index: 5 });
    await performSpaceDrop(drag('c'), drag('a'), true, deps);
    expect(deps.browserState.moveBookmark).toHaveBeenLastCalledWith('c', { parentId: 'spaces', index: 2 });
    deps.browserState.moveBookmark.mockClear();
    // Either edge next to where the space already sits leaves it there.
    await performSpaceDrop(drag('a'), drag('b'), false, deps);
    await performSpaceDrop(drag('c'), drag('b'), true, deps);
    expect(deps.browserState.moveBookmark).not.toHaveBeenCalled();
  });

  it('archives last on the button and before a row in the list', async () => {
    const deps = setup();
    await performSpaceDrop(drag('a'), { kind: 'space-archive' }, false, deps);
    expect(deps.browserState.setSpaceArchived).toHaveBeenCalledWith('a', true);
    await performSpaceDrop(drag('a'), drag('y', true), false, deps);
    expect(deps.browserState.setSpaceArchived).toHaveBeenLastCalledWith('a', true, 'y');
  });

  it('places an archived row moved down after the row it was dropped on', async () => {
    const deps = setup();
    await performSpaceDrop(drag('x', true), drag('y', true), false, deps);
    expect(deps.browserState.setSpaceArchived).toHaveBeenCalledWith('x', true, undefined);
  });

  it('unarchives on either side of a pagination dot', async () => {
    const deps = setup();
    await performSpaceDrop(drag('x', true), drag('b'), false, deps);
    expect(deps.browserState.setSpaceArchived).toHaveBeenCalledWith('x', false, 'b');
    await performSpaceDrop(drag('x', true), drag('b'), true, deps);
    expect(deps.browserState.setSpaceArchived).toHaveBeenLastCalledWith('x', false, 'c');
  });

  it('never archives or deletes the last shown space, but deletes an archived one', async () => {
    const deps = setup([space('a')]);
    await performSpaceDrop(drag('a'), { kind: 'space-archive' }, false, deps);
    await performSpaceDrop(drag('a'), { kind: 'trash' }, false, deps);
    expect(deps.browserState.setSpaceArchived).not.toHaveBeenCalled();
    expect(deps.spaceDeletion.request).not.toHaveBeenCalled();
    await performSpaceDrop(drag('x', true), { kind: 'trash' }, false, deps);
    expect(deps.spaceDeletion.request).toHaveBeenCalledWith(deps.nodeMap.get('x'));
  });
});
