import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isSplitViewFolder,
  parseBookmarkTitle,
  serializeBookmarkTitle,
  spaceLastActiveTabToken,
  splitViewFolderBookmarkTitle,
  tabBackingBookmarkLink,
  tabBackingBookmarkTitle,
  tabBackingInstallationId,
  tabBackingSpaceId,
  tabBackingTitleWithBookmarkLink,
  tabBackingToken,
  tabBackingWindowId,
  tabFolderBookmarkTitle,
  visibleBookmarkTitle,
  type BookmarkNode,
  type TabBookmarkLinkMetadata,
} from './bookmarks';
import { ensureSpaceBookmarksFolder, ensureSpaceTabsFolder, installationId } from './bookmarkStorage';
import { loadDurableOperations, type DurableOperation } from './operationJournal';
import { duplicateSpace, duplicateSpaceTitle, recoverSpaceDuplication } from './spaceDuplication';
import { createBookmarkTree, hyperBookmarkTree, type BookmarkSpec, type BookmarkTree } from './testBookmarkTree';

vi.mock('./bookmarkStorage', async (importOriginal) => ({
  ...await importOriginal<typeof import('./bookmarkStorage')>(),
  ensureSpaceBookmarksFolder: vi.fn(),
  ensureSpaceTabsFolder: vi.fn(),
  installationId: vi.fn(),
}));

const INSTALLATION = 'this-installation';
const WINDOW = 3;

const backing = (
  id: string,
  { installation = INSTALLATION, link = {}, windowId = WINDOW }: {
    installation?: string;
    link?: TabBookmarkLinkMetadata;
    windowId?: number;
  } = {},
): BookmarkSpec => ({
  id,
  title: tabBackingTitleWithBookmarkLink(
    tabBackingBookmarkTitle(id, undefined, `token-${id}`, 'work', undefined, { installationId: installation, windowId }),
    link,
  ),
  url: `https://example.test/${id}`,
});

const space = (
  id: string,
  title: string,
  { bookmarks = [], tabs = [] }: { bookmarks?: BookmarkSpec[]; tabs?: BookmarkSpec[] } = {},
): BookmarkSpec => ({
  children: [
    { children: tabs, id: `${id}-tabs`, title: serializeBookmarkTitle('tabs', { hyper: { spaceId: id, spaceTabs: true } }) },
    {
      children: bookmarks,
      id: `${id}-bookmarks`,
      title: serializeBookmarkTitle('bookmarks', { hyper: { spaceBookmarks: true, spaceId: id } }),
    },
  ],
  id,
  title,
});

/** The space folders' visible titles, in order. */
const spaceTitles = (tree: BookmarkTree) => tree.children('spaces').map(visibleBookmarkTitle);

function installBrowser() {
  const tree = createBookmarkTree(hyperBookmarkTree([
    space('work', serializeBookmarkTitle('Work', {
      hyper: { lastActiveTabToken: 'token-b', lastActiveTabTokensByWindow: { 3: 'token-b', 4: 'token-elsewhere' } },
    }), {
      bookmarks: [
        { id: 'docs', title: 'Docs', url: 'https://docs.test/' },
        { id: 'separator', title: '', type: 'separator', url: 'data:' },
        { children: [{ id: 'article', title: 'Article', url: 'https://news.test/a' }], id: 'reading', title: 'Reading' },
        backing('stray'),
      ],
      tabs: [
        backing('a', { link: { linkedBookmarkId: 'docs' } }),
        {
          children: [backing('b', { link: { linkedBookmarkId: 'mail' } }), backing('elsewhere', { windowId: 4 })],
          id: 'research',
          title: tabFolderBookmarkTitle('Research'),
        },
        {
          children: [backing('c'), backing('d', { link: { declinedBookmarkId: 'article' } })],
          id: 'pair',
          title: splitViewFolderBookmarkTitle(),
        },
        backing('synced', { installation: 'another-installation' }),
      ],
    }),
    space('work-2', 'Work 2'),
    space('home', 'Home'),
  ], [{ id: 'mail', title: 'Mail', url: 'https://mail.test/' }])[0]!);
  const journal = installJournal();
  vi.stubGlobal('browser', { bookmarks: tree.api, storage: { local: journal.local } });
  return { journal, tree };
}

/**
 * The journal's storage, which can stop the worker at its nth write: after the
 * write lands, or before it does. A stopped call never answers.
 */
function installJournal() {
  const items: Record<string, unknown> = {};
  let writes = 0;
  let stop: { at: number; lands: boolean } | undefined;
  const write = (apply: () => void): Promise<void> => {
    writes += 1;
    if (stop?.at !== writes) {
      apply();
      return Promise.resolve();
    }
    if (stop.lands) apply();
    return new Promise(() => undefined);
  };
  return {
    local: {
      get: vi.fn(async (key: string) => key in items ? { [key]: structuredClone(items[key]) } : {}),
      remove: vi.fn((key: string) => write(() => {
        delete items[key];
      })),
      set: vi.fn((values: Record<string, unknown>) => write(() => {
        Object.assign(items, structuredClone(values));
      })),
    },
    stopAtWrite(at: number, lands: boolean) {
      stop = { at, lands };
    },
    get writes() {
      return writes;
    },
  };
}

async function ensureFolder(spaceId: string, title: string, marker: 'spaceBookmarks' | 'spaceTabs') {
  const existing = (await browser.bookmarks.getChildren(spaceId))
    .find((node) => !node.url && visibleBookmarkTitle(node) === title);
  return existing ?? browser.bookmarks.create({
    parentId: spaceId,
    title: serializeBookmarkTitle(title, { hyper: { [marker]: true, spaceId } }),
  });
}

/** Runs a duplicate the worker stops partway through, and answers the operation it left. */
async function stoppedDuplicate(
  journal: ReturnType<typeof installJournal>,
  stop: { at: number; lands: boolean },
): Promise<DurableOperation> {
  journal.stopAtWrite(stop.at, stop.lands);
  void duplicateSpace({ sourceSpaceId: 'work', windowId: WINDOW, withTabs: true });
  await vi.waitFor(() => expect(journal.writes).toBe(stop.at));
  const [operation] = await loadDurableOperations();
  if (!operation) throw new Error('The stopped duplicate left no operation.');
  return operation;
}

/** Every node under a folder, depth first. */
const nodesUnder = (node: BookmarkNode): BookmarkNode[] =>
  (node.children ?? []).flatMap((child) => [child, ...nodesUnder(child)]);
const backingsUnder = (node: BookmarkNode) => nodesUnder(node).filter((child) => child.url);

beforeEach(() => {
  vi.mocked(installationId).mockResolvedValue(INSTALLATION);
  vi.mocked(ensureSpaceTabsFolder).mockImplementation((spaceId) => ensureFolder(spaceId, 'tabs', 'spaceTabs'));
  vi.mocked(ensureSpaceBookmarksFolder)
    .mockImplementation((spaceId) => ensureFolder(spaceId, 'bookmarks', 'spaceBookmarks'));
});

afterEach(() => vi.unstubAllGlobals());

describe('duplicateSpaceTitle', () => {
  it('numbers a copy past every name already taken, whatever its case', () => {
    expect(duplicateSpaceTitle('Work', ['Work', 'Home'])).toBe('Work 2');
    expect(duplicateSpaceTitle('Work', ['Work', 'work 2', 'WORK 3'])).toBe('Work 4');
  });

  it('numbers a copy of a numbered space from the name it was numbered after', () => {
    expect(duplicateSpaceTitle('Work 2', ['Work', 'Work 2'])).toBe('Work 3');
    expect(duplicateSpaceTitle('Plan 9', ['Plan 9'])).toBe('Plan 9 2');
  });

  it('continues a series a name ending in 1 starts, as the first space\'s does', () => {
    expect(duplicateSpaceTitle('Space 1', ['Space 1'])).toBe('Space 2');
    expect(duplicateSpaceTitle('Space 1', ['Space 1', 'Space 2'])).toBe('Space 3');
    expect(duplicateSpaceTitle('Windows 11', ['Windows 11'])).toBe('Windows 11 2');
  });

  it('names a copy of an untitled space as the space shows', () => {
    expect(duplicateSpaceTitle('  ', ['Untitled space'])).toBe('Untitled space 2');
  });
});

describe('duplicateSpace', () => {
  it('copies a space\'s own bookmarks beside it, under the next free name', async () => {
    const { tree } = installBrowser();

    const copy = await duplicateSpace({ sourceSpaceId: 'work', windowId: WINDOW, withTabs: false });

    expect(spaceTitles(tree)).toEqual(['Work', 'Work 3', 'Work 2', 'Home']);
    expect(tree.node(copy.id)).toMatchObject({ index: 1, parentId: 'spaces', title: 'Work 3' });
    expect(tree.outline(copy.id)).toEqual([
      ['tabs', []],
      ['bookmarks', ['Docs', ['Reading', ['Article']]]],
    ]);
    expect(copy.children?.map((child) => child.id)).toEqual(tree.children(copy.id).map((child) => child.id));
    expect(tree.outline('work-bookmarks')).toEqual(['Docs', '', ['Reading', ['Article']], 'stray']);
    await expect(loadDurableOperations()).resolves.toEqual([]);
  });

  it('copies the window\'s tabs as the copy\'s own, arranged and linked as they were', async () => {
    const { tree } = installBrowser();
    const before = tree.subTree('work');

    const copy = await duplicateSpace({ sourceSpaceId: 'work', windowId: WINDOW, withTabs: true });

    const [tabs, bookmarks] = tree.subTree(copy.id).children!;
    expect(tree.outline(tabs!.id)).toEqual(['a', ['Research', ['b']], ['Side by side', ['c', 'd']]]);
    expect(isSplitViewFolder(tabs!.children![2]!)).toBe(true);
    const copies = backingsUnder(tabs!);
    expect(copies.map((node) => ({
      installation: tabBackingInstallationId(node),
      space: tabBackingSpaceId(node),
      window: tabBackingWindowId(node),
    }))).toEqual(Array(4).fill({ installation: INSTALLATION, space: copy.id, window: WINDOW }));
    const tokens = copies.map(tabBackingToken);
    expect(new Set(tokens).size).toBe(4);
    expect(tokens.filter((token) => token?.startsWith('token-'))).toEqual([]);
    const copied = (title: string) => nodesUnder(bookmarks!).find((node) => node.title === title)!.id;
    expect(copies.map(tabBackingBookmarkLink)).toEqual([
      { linkedBookmarkId: copied('Docs') },
      { linkedBookmarkId: 'mail' },
      {},
      { declinedBookmarkId: copied('Article') },
    ]);
    const [, copyOfB] = copies;
    expect(spaceLastActiveTabToken(tree.node(copy.id), WINDOW)).toBe(tabBackingToken(copyOfB!));
    expect(spaceLastActiveTabToken(tree.node(copy.id), 4)).toBeUndefined();
    expect(parseBookmarkTitle(tree.node(copy.id).title).title).toBe('Work 3');
    expect(tree.subTree('work')).toEqual(before);
  });

  it('removes a copy that fails partway, and forgets the operation', async () => {
    const { tree } = installBrowser();
    const create = tree.api.create.getMockImplementation()!;
    tree.api.create.mockImplementation(async (details) => {
      if (details.title === 'Reading') throw new Error('The bookmark quota is full.');
      return create(details);
    });

    await expect(duplicateSpace({ sourceSpaceId: 'work', windowId: WINDOW, withTabs: true }))
      .rejects.toThrow('The bookmark quota is full.');

    expect(spaceTitles(tree)).toEqual(['Work', 'Work 2', 'Home']);
    await expect(loadDurableOperations()).resolves.toEqual([]);
  });

  it('keeps the operation for recovery when a failed copy cannot be removed', async () => {
    const { tree } = installBrowser();
    const create = tree.api.create.getMockImplementation()!;
    tree.api.create.mockImplementation(async (details) => {
      if (details.title === 'Reading') throw new Error('The bookmark quota is full.');
      return create(details);
    });
    tree.api.removeTree.mockRejectedValueOnce(new Error('Bookmarks are busy.'));

    await expect(duplicateSpace({ sourceSpaceId: 'work', windowId: WINDOW, withTabs: false }))
      .rejects.toBeInstanceOf(AggregateError);

    await expect(loadDurableOperations()).resolves.toMatchObject([{ kind: 'duplicate-space', phase: 'effect-applied' }]);
  });

  it('refuses a space that no longer exists before it journals anything', async () => {
    const { journal } = installBrowser();

    await expect(duplicateSpace({ sourceSpaceId: 'gone', windowId: WINDOW, withTabs: false }))
      .rejects.toThrow('This space no longer exists.');

    expect(journal.writes).toBe(0);
  });
});

describe('recoverSpaceDuplication', () => {
  it('removes a copy the worker made but did not record, found by its mark', async () => {
    const { journal, tree } = installBrowser();
    const operation = await stoppedDuplicate(journal, { at: 2, lands: false });
    expect(operation.completionProof.duplicateSpaceId).toBe('pending');
    expect(spaceTitles(tree)).toEqual(['Work', 'Work 3', 'Work 2', 'Home']);

    await expect(recoverSpaceDuplication(operation)).resolves.toEqual({ status: 'rolled-back' });

    expect(spaceTitles(tree)).toEqual(['Work', 'Work 2', 'Home']);
  });

  it('removes a recorded copy the worker stopped filling', async () => {
    const { journal, tree } = installBrowser();
    const operation = await stoppedDuplicate(journal, { at: 2, lands: true });
    expect(operation.phase).toBe('effect-applied');

    await expect(recoverSpaceDuplication(operation)).resolves.toEqual({ status: 'rolled-back' });

    expect(spaceTitles(tree)).toEqual(['Work', 'Work 2', 'Home']);
  });

  it('keeps a whole copy, finishing its title as the duplicate would have', async () => {
    const { journal, tree } = installBrowser();
    const operation = await stoppedDuplicate(journal, { at: 3, lands: true });
    expect(operation.phase).toBe('verifying');
    const copyId = String(operation.completionProof.duplicateSpaceId);
    expect(tree.node(copyId).title).toContain(operation.id);

    await expect(recoverSpaceDuplication(operation)).resolves.toEqual({ status: 'completed' });

    const copy = tree.node(copyId);
    expect(copy.title).not.toContain(operation.id);
    expect(visibleBookmarkTitle(copy)).toBe('Work 3');
    expect(spaceLastActiveTabToken(copy, WINDOW)).toBe(operation.completionProof.rememberedTabToken);
    expect(tree.outline(copyId)[0]).toEqual(['tabs', ['a', ['Research', ['b']], ['Side by side', ['c', 'd']]]]);
  });

  it('settles an operation whose copy is already gone', async () => {
    const { journal, tree } = installBrowser();
    const operation = await stoppedDuplicate(journal, { at: 3, lands: true });
    await tree.api.removeTree(String(operation.completionProof.duplicateSpaceId));

    await expect(recoverSpaceDuplication(operation)).resolves.toEqual({ status: 'completed' });
    await expect(recoverSpaceDuplication({ ...operation, phase: 'effect-applied' }))
      .resolves.toEqual({ status: 'rolled-back' });
  });

  it('leaves alone a copy moved out of the spaces, and spaces it did not make', async () => {
    const { journal, tree } = installBrowser();
    const operation = await stoppedDuplicate(journal, { at: 2, lands: true });
    const copyId = String(operation.completionProof.duplicateSpaceId);
    await tree.api.move(copyId, { parentId: 'home-bookmarks' });

    await expect(recoverSpaceDuplication(operation)).resolves.toMatchObject({ status: 'abandoned' });
    await expect(recoverSpaceDuplication({ ...operation, completionProof: {} }))
      .resolves.toMatchObject({ status: 'abandoned' });
    await expect(recoverSpaceDuplication({ ...operation, completionProof: { ...operation.completionProof, duplicateSpaceId: 'pending' } }))
      .resolves.toEqual({ status: 'rolled-back' });

    expect(tree.has(copyId)).toBe(true);
    expect(spaceTitles(tree)).toEqual(['Work', 'Work 2', 'Home']);
  });
});
