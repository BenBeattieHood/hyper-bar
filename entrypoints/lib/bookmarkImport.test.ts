import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createBookmarkFolderImport,
  importBookmarkFolder,
  bookmarkImportSourceIsWithin,
  runExclusiveBookmarkImport,
  type BookmarkImportApi,
} from './bookmarkImport';
import type { BookmarkNode } from './bookmarks';
import type { DurableOperation } from './operationJournal';
import { testBookmark as bookmark, testFolder as folder } from './testBookmarkTree';

describe('importBookmarkFolder', () => {
  /** An API that reads `source` and creates nodes with sequential IDs, unless `create` stands in. */
  const importApi = (source: BookmarkNode, create?: BookmarkImportApi['create']) => {
    let nextId = 0;
    const api = {
      getSubTree: vi.fn().mockResolvedValue([source]),
      create: vi.fn(create ?? (async (details) => ({ ...details, id: `created-${++nextId}`, syncing: false } as BookmarkNode))),
      removeTree: vi.fn().mockResolvedValue(undefined),
    };
    return { api, created: () => api.create.mock.calls.map(([details]) => details) };
  };
  const failingSecondCreate = () => vi.fn()
    .mockResolvedValueOnce({ id: 'imported', title: 'Recipes' })
    .mockRejectedValueOnce(new Error('create failed'));
  const recipes = (...children: BookmarkNode[]) => folder('source', 'Recipes', 'toolbar', children);
  const one = bookmark('one', 'One', 'https://one.example', 'source');

  it('copies a folder and nested children in browser order', async () => {
    const { api, created } = importApi(recipes(one, folder('nested', 'Desserts', 'source', [
      bookmark('two', 'Two', 'https://two.example', 'nested'),
    ])));

    await expect(importBookmarkFolder('source', 'destination', api))
      .resolves.toMatchObject({ id: 'created-1', title: 'Recipes' });
    expect(created()).toEqual([
      { parentId: 'destination', title: 'Recipes' },
      { parentId: 'created-1', title: 'One', url: 'https://one.example' },
      { parentId: 'created-1', title: 'Desserts' },
      { parentId: 'created-3', title: 'Two', url: 'https://two.example' },
    ]);
    expect(api.removeTree).not.toHaveBeenCalled();
  });

  it('removes the imported root when a descendant copy fails', async () => {
    const { api } = importApi(recipes(one), failingSecondCreate());

    await expect(importBookmarkFolder('source', 'destination', api)).rejects.toThrow('create failed');
    expect(api.removeTree).toHaveBeenCalledWith('imported');
  });

  it('reports the root before copying descendants and completion afterward', async () => {
    const events: string[] = [];

    await importBookmarkFolder('source', 'destination', importApi(recipes(one)).api, new Set(), {
      onCompleted: (root) => { events.push(`completed:${root.id}`); },
      onRootCreated: (root) => { events.push(`created:${root.id}`); },
    });

    expect(events).toEqual(['created:created-1', 'completed:created-1']);
  });

  it('reports the partial folder when copying and rollback both fail', async () => {
    const { api } = importApi(recipes(one), failingSecondCreate());
    api.removeTree.mockRejectedValue(new Error('remove failed'));

    await expect(importBookmarkFolder('source', 'destination', api)).rejects.toThrow('partial folder "Recipes" (imported) could not be removed');
  });

  it('skips Firefox separators while preserving surrounding bookmarks', async () => {
    const separator = {
      id: 'separator',
      title: '',
      parentId: 'source',
      type: 'separator',
      syncing: false,
    } as BookmarkNode & { type: 'separator' };
    const { api, created } = importApi(recipes(separator, one));

    await importBookmarkFolder('source', 'destination', api);

    expect(created()).toEqual([
      { parentId: 'destination', title: 'Recipes' },
      { parentId: 'created-1', title: 'One', url: 'https://one.example' },
    ]);
  });

  it('excludes Hyper when importing one of its ancestor browser folders', async () => {
    const source = folder('toolbar', 'Bookmarks Bar', 'root', [
      folder('hyper', 'hyper', 'toolbar', [
        folder('spaces', 'spaces', 'hyper', []),
      ]),
      folder('recipes', 'Recipes', 'toolbar', []),
    ]);
    const { api, created } = importApi(source);

    await importBookmarkFolder('toolbar', 'destination', api, new Set(['hyper']));

    expect(created()).toEqual([
      { parentId: 'destination', title: 'Bookmarks Bar' },
      { parentId: 'created-1', title: 'Recipes' },
    ]);
  });
});

describe('bookmarkImportSourceIsWithin', () => {
  const hyper = folder('hyper', 'hyper', 'toolbar', [
    folder('bookmarks', 'bookmarks', 'hyper', []),
  ]);

  it('rejects the canonical Hyper root and its descendants', () => {
    expect(bookmarkImportSourceIsWithin(hyper, 'hyper')).toBe(true);
    expect(bookmarkImportSourceIsWithin(hyper, 'bookmarks')).toBe(true);
    expect(bookmarkImportSourceIsWithin(hyper, 'toolbar')).toBe(false);
  });
});

describe('runExclusiveBookmarkImport', () => {
  it('rejects a concurrent import from the same source and releases its lock', async () => {
    let finishFirst: (() => void) | undefined;
    const pending = new Set<string>();
    const first = runExclusiveBookmarkImport(
      pending,
      'source',
      () => new Promise<void>((resolve) => {
        finishFirst = resolve;
      }),
    );

    await expect(runExclusiveBookmarkImport(pending, 'source', async () => undefined))
      .rejects.toThrow('already being imported');
    finishFirst?.();
    await first;
    expect(pending.size).toBe(0);

    await expect(runExclusiveBookmarkImport(pending, 'source', async () => 'done'))
      .resolves.toBe('done');
    expect(pending.size).toBe(0);
  });

  it('publishes counts after acquisition and actual release for concurrent sources', async () => {
    const pending = new Set<string>();
    const counts: number[] = [];
    let finishFirst: (() => void) | undefined;
    let finishSecond: (() => void) | undefined;
    const publish = async (count: number) => {
      counts.push(count);
    };
    const first = runExclusiveBookmarkImport(
      pending,
      'first',
      () => new Promise<void>((resolve) => { finishFirst = resolve; }),
      publish,
    );
    const second = runExclusiveBookmarkImport(
      pending,
      'second',
      () => new Promise<void>((resolve) => { finishSecond = resolve; }),
      publish,
    );
    await Promise.resolve();
    finishFirst?.();
    await first;
    finishSecond?.();
    await second;

    expect(counts).toEqual([1, 2, 1, 0]);
    expect(pending.size).toBe(0);
  });

  it('publishes idle after preflight failure', async () => {
    const counts: number[] = [];

    await expect(runExclusiveBookmarkImport(
      new Set<string>(),
      'source',
      async () => { throw new Error('preflight failed'); },
      async (count) => { counts.push(count); },
    )).rejects.toThrow('preflight failed');

    expect(counts).toEqual([1, 0]);
  });
});

describe('interrupted folder import recovery', () => {
  afterEach(() => vi.unstubAllGlobals());

  const operation = (
    phase: DurableOperation['phase'],
    importedRootId: string,
  ): DurableOperation => ({
    completionProof: { destinationParentId: 'space-bookmarks', importedRootId },
    id: 'operation',
    idempotencyKey: 'import-bookmark-folder:source:space-bookmarks',
    kind: 'import-bookmark-folder',
    payload: { destinationParentId: 'space-bookmarks', sourceFolderId: 'source' },
    phase,
    recovery: 'rollback',
    startedAt: 0,
    updatedAt: 0,
  });
  const install = (roots: Record<string, BookmarkNode>) => {
    const removeTree = vi.fn(async () => undefined);
    vi.stubGlobal('browser', {
      bookmarks: {
        get: vi.fn(async (id: string) => roots[id] ? [roots[id]] : []),
        removeTree,
      },
    });
    return { recover: createBookmarkFolderImport(async () => undefined).recover, removeTree };
  };

  it('rolls back a partial copy and keeps one that was being verified', async () => {
    const { recover, removeTree } = install({
      imported: folder('imported', 'Reading', 'space-bookmarks', []),
    });

    await expect(recover(operation('effect-applied', 'imported')))
      .resolves.toEqual({ status: 'rolled-back' });
    expect(removeTree).toHaveBeenCalledWith('imported');
    await expect(recover(operation('verifying', 'imported')))
      .resolves.toEqual({ status: 'completed' });
    expect(removeTree).toHaveBeenCalledTimes(1);
  });

  it('abandons rather than guesses when the root is unknown or was moved', async () => {
    const { recover, removeTree } = install({
      moved: folder('moved', 'Reading', 'elsewhere', []),
    });

    await expect(recover(operation('prepared', 'pending')))
      .resolves.toMatchObject({ status: 'abandoned' });
    await expect(recover(operation('effect-applied', 'moved')))
      .resolves.toMatchObject({ status: 'abandoned' });
    await expect(recover(operation('effect-applied', 'gone')))
      .resolves.toEqual({ status: 'rolled-back' });
    expect(removeTree).not.toHaveBeenCalled();
  });
});
