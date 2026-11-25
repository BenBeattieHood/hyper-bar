import {
  bookmarkTitleWithHyper,
  deriveSpaces,
  findHyperBookmarkStructure,
  hyperString,
  isBookmarkSeparator,
  isLocalBookmarkNode,
  isSpaceBookmarksFolder,
  isSpaceTabsFolder,
  isTabBackingBookmark,
  isTabFolder,
  spaceBookmarkTitleWithLastActiveTabToken,
  spaceLastActiveTabToken,
  tabBackingBookmarkLink,
  tabBackingInstallationId,
  tabBackingSpaceId,
  tabBackingTitleForSession,
  tabBackingTitleWithBookmarkLink,
  tabBackingToken,
  tabBackingWindowId,
  visibleBookmarkTitle,
  type BookmarkNode,
} from './bookmarks';
import {
  bookmarkById,
  ensureSpaceBookmarksFolder,
  ensureSpaceTabsFolder,
  installationId,
} from './bookmarkStorage';
import {
  advanceDurableOperation,
  beginDurableOperation,
  completeDurableOperation,
  type DurableOperation,
  type DurableOperationResolution,
} from './operationJournal';
import { rebuildTabTree } from './tabTreeRebuild';

/**
 * A copy's name: the source's with the first free number after it, so copying
 * "Work" twice makes "Work 2" and "Work 3", as does copying "Work 2". A name
 * ending in 1, such as the first space's "Space 1", starts such a series.
 */
export function duplicateSpaceTitle(title: string, existingTitles: readonly string[]): string {
  const taken = new Set(existingTitles.map((existing) => existing.trim().toLocaleLowerCase()));
  const source = title.trim() || 'Untitled space';
  const [, stem, number] = /^(.*\S)\s+(\d+)$/.exec(source) ?? [];
  const base = stem && (number === '1' || taken.has(stem.toLocaleLowerCase())) ? stem : source;
  for (let number = 2; ; number += 1) {
    const candidate = `${base} ${number}`;
    if (!taken.has(candidate.toLocaleLowerCase())) return candidate;
  }
}

function duplicateOperationId(node: Pick<BookmarkNode, 'title'>): string | undefined {
  return hyperString(node, 'duplicateOperationId');
}

/**
 * The copy's folder title while it is being filled: the source's metadata,
 * without the tab it last showed, and marked with the operation making it, so
 * recovery finds a copy even if the worker stopped before recording its ID.
 */
function copyFolderTitle(sourceTitle: string, title: string, operationId: string): string {
  return bookmarkTitleWithHyper(sourceTitle, {
    duplicateOperationId: operationId,
    lastActiveTabToken: undefined,
    lastActiveTabTokensByWindow: undefined,
  }, { visible: title });
}

/** A whole copy's title: unmarked, and showing the copy of the tab the source last showed. */
function finishedCopyTitle(title: string, rememberedTabToken: string | undefined, windowId: number): string {
  const unmarked = bookmarkTitleWithHyper(title, { duplicateOperationId: undefined });
  return rememberedTabToken
    ? spaceBookmarkTitleWithLastActiveTabToken({ title: unmarked }, rememberedTabToken, windowId)
    : unmarked;
}

/** Copies a space's own bookmarks and folders, answering each copy's ID keyed by its source's. */
async function copyBookmarks(
  nodes: readonly BookmarkNode[],
  parentId: string,
  copies: Map<string, string>,
): Promise<void> {
  for (const node of nodes) {
    if (isBookmarkSeparator(node) || !isLocalBookmarkNode(node)) continue;
    const copy = await browser.bookmarks.create({
      parentId,
      title: node.title,
      ...(node.url ? { url: node.url } : {}),
    });
    copies.set(node.id, copy.id);
    if (!node.url) await copyBookmarks(node.children ?? [], copy.id, copies);
  }
}

/**
 * Copies the window's tabs in a space, as backings of the copy that its first
 * showing in the window opens. Each copy has its own token, and follows the
 * copied bookmark its source showed. Answers the token of the copy of the tab
 * the source last showed in the window.
 */
async function copyWindowTabs(
  source: BookmarkNode,
  copyId: string,
  tabsFolderId: string,
  windowId: number,
  bookmarkCopies: ReadonlyMap<string, string>,
): Promise<string | undefined> {
  const sourceTabs = source.children?.find(isSpaceTabsFolder);
  if (!sourceTabs) return undefined;
  const localInstallationId = await installationId();
  const titles = new Map<string, string>();
  const tokens = new Map<string, string>();
  const copiedBookmarkId = (id: string | undefined) => id && (bookmarkCopies.get(id) ?? id);
  const visit = (folder: BookmarkNode) => {
    for (const node of folder.children ?? []) {
      if (isTabFolder(node)) visit(node);
      if (
        !isTabBackingBookmark(node) ||
        tabBackingInstallationId(node) !== localInstallationId ||
        tabBackingWindowId(node) !== windowId ||
        tabBackingSpaceId(node) !== source.id
      ) continue;
      const tabToken = crypto.randomUUID();
      const sourceToken = tabBackingToken(node);
      if (sourceToken) tokens.set(sourceToken, tabToken);
      const link = tabBackingBookmarkLink(node);
      titles.set(node.id, tabBackingTitleWithBookmarkLink(
        tabBackingTitleForSession(node.title, {
          installationId: localInstallationId,
          spaceId: copyId,
          tabToken,
          windowId,
        }),
        {
          declinedBookmarkId: copiedBookmarkId(link.declinedBookmarkId),
          linkedBookmarkId: copiedBookmarkId(link.linkedBookmarkId),
        },
      ));
    }
  };
  visit(sourceTabs);
  await rebuildTabTree(sourceTabs, tabsFolderId, {
    backingTitle: (node) => titles.get(node.id),
    keepEmptyFolders: true,
    present: new Set(),
  });
  const remembered = spaceLastActiveTabToken(source, windowId);
  return remembered === undefined ? undefined : tokens.get(remembered);
}

export interface SpaceDuplicationRequest {
  sourceSpaceId: string;
  /** The window asking, whose tabs in the space a copy with tabs takes. */
  windowId: number;
  withTabs: boolean;
}

/**
 * Copies a space beside it as a journalled operation: its bookmarks, and with
 * `withTabs` the asking window's tabs in it, arranged as they were. A copy
 * that fails, or that a stopped worker left part made, is removed whole.
 */
export async function duplicateSpace({
  sourceSpaceId,
  windowId,
  withTabs,
}: SpaceDuplicationRequest): Promise<BookmarkNode> {
  const tree = await browser.bookmarks.getTree();
  const structure = findHyperBookmarkStructure(tree);
  const source = structure?.spaces.children?.find((node) => !node.url && node.id === sourceSpaceId);
  if (!structure || !source) throw new Error('This space no longer exists.');
  const title = duplicateSpaceTitle(
    visibleBookmarkTitle(source),
    deriveSpaces(tree).map((space) => space.title),
  );
  const operationId = crypto.randomUUID();
  const proof = (duplicateSpaceId: string, rememberedTabToken?: string) => ({
    completionProof: {
      duplicateSpaceId,
      ...(rememberedTabToken ? { rememberedTabToken } : {}),
      spacesFolderId: structure.spaces.id,
      windowId,
    },
  });
  await beginDurableOperation({
    ...proof('pending'),
    id: operationId,
    idempotencyKey: `duplicate-space:${sourceSpaceId}`,
    kind: 'duplicate-space',
    payload: { sourceSpaceId, windowId, withTabs },
    phase: 'prepared',
    recovery: 'rollback',
    startedAt: Date.now(),
    updatedAt: Date.now(),
  });
  let copy: BookmarkNode;
  try {
    copy = await browser.bookmarks.create({
      index: (source.index ?? 0) + 1,
      parentId: structure.spaces.id,
      title: copyFolderTitle(source.title, title, operationId),
    });
  } catch (error) {
    await completeDurableOperation(operationId).catch(() => undefined);
    throw error;
  }
  try {
    await advanceDurableOperation(operationId, 'effect-applied', proof(copy.id));
    const tabsFolder = await ensureSpaceTabsFolder(copy.id);
    const bookmarksFolder = await ensureSpaceBookmarksFolder(copy.id);
    const bookmarkCopies = new Map<string, string>();
    await copyBookmarks(
      source.children?.find(isSpaceBookmarksFolder)?.children ?? [],
      bookmarksFolder.id,
      bookmarkCopies,
    );
    const rememberedTabToken = withTabs
      ? await copyWindowTabs(source, copy.id, tabsFolder.id, windowId, bookmarkCopies)
      : undefined;
    await advanceDurableOperation(operationId, 'verifying', proof(copy.id, rememberedTabToken));
    const [current] = await browser.bookmarks.get(copy.id);
    if (!current) throw new Error('The space copy no longer exists.');
    const finished = await browser.bookmarks.update(copy.id, {
      title: finishedCopyTitle(current.title, rememberedTabToken, windowId),
    });
    await completeDurableOperation(operationId);
    return { ...finished, children: [tabsFolder, bookmarksFolder] };
  } catch (error) {
    try {
      await browser.bookmarks.removeTree(copy.id);
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        `Duplicating the space failed and its partial copy (${copy.id}) could not be removed.`,
      );
    }
    await completeDurableOperation(operationId).catch(() => undefined);
    throw error;
  }
}

/**
 * Finishes or removes a copy a stopped worker left: a whole one, recorded as
 * verifying, only loses its mark; any other is removed. Only the recorded copy,
 * or the one marked with this operation, is ever touched.
 */
export async function recoverSpaceDuplication(
  operation: DurableOperation,
): Promise<DurableOperationResolution> {
  const { duplicateSpaceId, rememberedTabToken, spacesFolderId, windowId } = operation.completionProof;
  if (typeof duplicateSpaceId !== 'string' || typeof spacesFolderId !== 'string' || typeof windowId !== 'number') {
    return { reason: 'The space copy was not recorded before worker suspension.', status: 'abandoned' };
  }
  const recorded = duplicateSpaceId === 'pending' ? undefined : await bookmarkById(duplicateSpaceId);
  const copy = recorded ?? (await browser.bookmarks.getChildren(spacesFolderId).catch(() => []))
    .find((node) => !node.url && duplicateOperationId(node) === operation.id);
  if (!copy) return { status: operation.phase === 'verifying' ? 'completed' : 'rolled-back' };
  if (copy.parentId !== spacesFolderId) {
    return { reason: 'The space copy was moved before recovery.', status: 'abandoned' };
  }
  if (operation.phase === 'verifying') {
    if (duplicateOperationId(copy) === operation.id) {
      await browser.bookmarks.update(copy.id, {
        title: finishedCopyTitle(
          copy.title,
          typeof rememberedTabToken === 'string' ? rememberedTabToken : undefined,
          windowId,
        ),
      });
    }
    return { status: 'completed' };
  }
  await browser.bookmarks.removeTree(copy.id);
  return { status: 'rolled-back' };
}
