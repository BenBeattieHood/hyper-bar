import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HyperModelPortClient } from './modelPort';
import { createBookmarkTree } from './testBookmarkTree';
import { createWorkspaceIntentHandlers, type WorkspaceIntentHandlerDependencies } from './workspaceIntentHandlers';

const client: HyperModelPortClient = { clientId: 'sidebar-client', role: 'sidebar', windowId: 3 };

/** The moveBookmark handler over one folder of the given bookmarks, its queue held until released. */
function installMoves(children: readonly string[]) {
  const tree = createBookmarkTree({
    children: [{
      children: children.map((id) => ({ id, title: id, url: `https://example.test/${id}` })),
      id: 'folder',
      title: 'folder',
    }],
    id: 'root',
    title: '',
  });
  vi.stubGlobal('browser', { bookmarks: tree.api });
  const offer = vi.fn();
  let queue = Promise.resolve();
  const queued: Array<() => void> = [];
  const queueMutation = <Result>(operation: () => Promise<Result>) => {
    const result = queue.then(() => new Promise<void>((release) => queued.push(release))).then(operation);
    queue = result.then(() => undefined, () => undefined);
    return result;
  };
  const handlers = createWorkspaceIntentHandlers({
    messages: { offer },
    queueMutation,
  } as unknown as WorkspaceIntentHandlerDependencies);
  return {
    children: () => tree.children('folder').map((node) => node.id),
    move: (payload: unknown) => handlers.moveBookmark!.run(payload, client),
    offer,
    /** Lets the queued mutation run once it is waiting. */
    release: async () => {
      await vi.waitFor(() => expect(queued.length).toBeGreaterThan(0));
      queued.shift()!();
    },
    tree,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('moveBookmark', () => {
  it('steps a bookmark past the sibling it has when the queued move runs', async () => {
    const store = installMoves(['a', 'b', 'c', 'd']);
    const step = store.move({ bookmarkId: 'b', offset: 1 });

    // Another window's move lands while the step waits its turn in the queue.
    await store.tree.api.move('a', { parentId: 'folder' });
    await store.release();
    await step;

    // Worked out before the move, the step would have put b at index 3 and past d.
    expect(store.children()).toEqual(['c', 'b', 'd', 'a']);
    expect(store.offer).toHaveBeenCalledOnce();
  });

  it('leaves a bookmark already at that end where it is, offering no undo', async () => {
    const store = installMoves(['a', 'b']);
    const step = store.move({ bookmarkId: 'b', offset: 1 });
    await store.release();

    expect(await step).toMatchObject({ id: 'b' });
    expect(store.children()).toEqual(['a', 'b']);
    expect(store.offer).not.toHaveBeenCalled();
  });
});
