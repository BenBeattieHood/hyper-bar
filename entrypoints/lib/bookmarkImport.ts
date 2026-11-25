import {
  containsNode,
  findHyperBookmarkStructure,
  isBookmarkFolder,
  isBookmarkSeparator,
  isSpaceBookmarksFolder,
  type BookmarkNode,
} from './bookmarks';
import { bookmarkById } from './bookmarkStorage';
import {
  advanceDurableOperation,
  beginDurableOperation,
  completeDurableOperation,
  type DurableOperation,
  type DurableOperationResolution,
} from './operationJournal';

export function bookmarkImportSourceIsWithin(
  root: BookmarkNode,
  sourceFolderId: string,
): boolean {
  return root.id === sourceFolderId || containsNode(root, sourceFolderId);
}

export interface BookmarkImportApi {
  getSubTree(id: string): Promise<BookmarkNode[]>;
  create(details: {
    parentId: string;
    title: string;
    url?: string;
  }): Promise<BookmarkNode>;
  removeTree(id: string): Promise<void>;
}

export interface BookmarkImportHooks {
  onCompleted?(importedRoot: BookmarkNode): Promise<void> | void;
  onRootCreated?(importedRoot: BookmarkNode): Promise<void> | void;
}

export async function runExclusiveBookmarkImport<T>(
  pendingSourceIds: Set<string>,
  sourceFolderId: string,
  operation: () => Promise<T>,
  onStateChange?: (activeCount: number) => Promise<void> | void,
): Promise<T> {
  if (pendingSourceIds.has(sourceFolderId)) {
    throw new Error('This bookmark folder is already being imported.');
  }
  pendingSourceIds.add(sourceFolderId);
  try {
    await onStateChange?.(pendingSourceIds.size);
    return await operation();
  } finally {
    pendingSourceIds.delete(sourceFolderId);
    await onStateChange?.(pendingSourceIds.size);
  }
}

export async function importBookmarkFolder(
  sourceFolderId: string,
  destinationParentId: string,
  bookmarksApi: BookmarkImportApi = browser.bookmarks,
  excludedSourceIds: ReadonlySet<string> = new Set(),
  hooks: BookmarkImportHooks = {},
): Promise<BookmarkNode> {
  const [source] = await bookmarksApi.getSubTree(sourceFolderId);
  if (!source || !isBookmarkFolder(source)) {
    throw new Error('Choose a bookmark folder to import.');
  }
  const importedRoot = await bookmarksApi.create({
    parentId: destinationParentId,
    title: source.title || 'Imported bookmarks',
  });
  const copyChildren = async (
    children: readonly BookmarkNode[],
    parentId: string,
  ): Promise<void> => {
    for (const child of children) {
      if (excludedSourceIds.has(child.id) || isBookmarkSeparator(child)) continue;
      const imported = await bookmarksApi.create({
        parentId,
        title: child.title,
        ...(child.url ? { url: child.url } : {}),
      });
      if (!child.url) await copyChildren(child.children ?? [], imported.id);
    }
  };
  try {
    await hooks.onRootCreated?.(importedRoot);
    await copyChildren(source.children ?? [], importedRoot.id);
    await hooks.onCompleted?.(importedRoot);
    return importedRoot;
  } catch (error) {
    try {
      await bookmarksApi.removeTree(importedRoot.id);
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        `Bookmark import failed and partial folder "${importedRoot.title || importedRoot.id}" (${importedRoot.id}) could not be removed.`,
      );
    }
    throw error;
  }
}

/**
 * Imports a browser folder into a space's or the global bookmarks as a journalled operation:
 * a worker suspended mid-copy rolls the partial copy back on its next start.
 */
export function createBookmarkFolderImport(
  recordImportState: (activeCount: number) => Promise<void>,
) {
  const pendingSourceIds = new Set<string>();
  const importFolder = (sourceFolderId: string, destinationParentId: string) => {
    if (pendingSourceIds.size > 0) {
      return Promise.reject(new Error('A bookmark folder is already being imported.'));
    }
    return runExclusiveBookmarkImport(pendingSourceIds, sourceFolderId, async () => {
      const structure = findHyperBookmarkStructure(await browser.bookmarks.getTree());
      const destination = await bookmarkById(destinationParentId);
      const importable = destination && (
        isSpaceBookmarksFolder(destination) || destination.id === structure?.bookmarks?.id
      );
      if (!structure || !importable) {
        throw new Error('The bookmarks folder is unavailable.');
      }
      if (bookmarkImportSourceIsWithin(structure.hyper, sourceFolderId)) {
        throw new Error('Choose a bookmark folder outside Hyper.');
      }
      const operationId = crypto.randomUUID();
      const proof = (importedRootId: string) => ({
        completionProof: { destinationParentId, importedRootId },
      });
      await beginDurableOperation({
        ...proof('pending'),
        id: operationId,
        idempotencyKey: `import-bookmark-folder:${sourceFolderId}:${destinationParentId}`,
        kind: 'import-bookmark-folder',
        payload: { destinationParentId, sourceFolderId },
        phase: 'prepared',
        recovery: 'rollback',
        startedAt: Date.now(),
        updatedAt: Date.now(),
      });
      const imported = await importBookmarkFolder(
        sourceFolderId,
        destinationParentId,
        browser.bookmarks,
        new Set([structure.hyper.id]),
        {
          onCompleted: (root) => advanceDurableOperation(operationId, 'verifying', proof(root.id)),
          onRootCreated: (root) =>
            advanceDurableOperation(operationId, 'effect-applied', proof(root.id)),
        },
      );
      const [verifiedRoot] = await browser.bookmarks.get(imported.id);
      if (verifiedRoot?.parentId !== destinationParentId) {
        throw new Error('The imported bookmark root could not be verified.');
      }
      await completeDurableOperation(operationId);
      return imported;
    }, recordImportState);
  };

  const recover = async (operation: DurableOperation): Promise<DurableOperationResolution> => {
    const { destinationParentId, importedRootId } = operation.completionProof;
    if (
      typeof destinationParentId !== 'string' ||
      typeof importedRootId !== 'string' ||
      importedRootId === 'pending'
    ) {
      return {
        reason: 'The imported bookmark root was not recorded before worker suspension.',
        status: 'abandoned',
      };
    }
    const importedRoot = await bookmarkById(importedRootId);
    if (!importedRoot) {
      return { status: operation.phase === 'verifying' ? 'completed' : 'rolled-back' };
    }
    if (importedRoot.parentId !== destinationParentId) {
      return {
        reason: 'The recorded import root was moved before recovery.',
        status: 'abandoned',
      };
    }
    if (operation.phase === 'verifying') return { status: 'completed' };
    await browser.bookmarks.removeTree(importedRootId);
    return { status: 'rolled-back' };
  };

  return { importFolder, recover };
}
