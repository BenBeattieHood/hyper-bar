import type { CommandSettlementOutcome, HyperActionKind } from '../../lib/modelActions';
import type { BrowserCommandIntent } from '../../lib/browserCommands';
import { bookmarkStepIndex, findBookmarkNode, spaceBookmarkTitleWithArchived, type BookmarkNode, type BrowserTab } from '../../lib/bookmarks';
import type {
  DeleteBookmarkPayload,
  IntentItemPayloads,
  MoveBookmarkPayload,
  MoveTabsPayload,
  SharedDragReference,
} from '../../lib/modelIntentPayloads';
import type { RemoteTabReference } from '../../lib/remoteTab';
import type { TimedMessageTone } from '../../lib/timedMessages';
import {
  moveBookmarkOptimistically,
  removeBookmarkOptimistically,
  updateBookmarkOptimistically,
} from './backingOperations';

export interface BookmarkCreationResult {
  created: boolean;
  node: BookmarkNode;
}

/** An intent's result as `Value`, when it is an object that `valid` accepts. */
function parseResult<Value>(result: unknown, valid: (value: Partial<Value>) => boolean): Value | undefined {
  return result && typeof result === 'object' && valid(result as Partial<Value>) ? result as Value : undefined;
}

export const asBookmarkNode = (result: unknown) => parseResult<BookmarkNode>(result, (node) =>
  typeof node.id === 'string' && typeof node.title === 'string');

export const asBrowserTab = (result: unknown) => parseResult<BrowserTab>(result, (tab) =>
  (tab.id === undefined || typeof tab.id === 'number') && typeof tab.index === 'number' &&
  typeof tab.windowId === 'number');

/** What an intent created, or the failure the view shows when it created nothing. */
export function required<Result>(result: Result | undefined, failure: string): Result {
  if (!result) throw new Error(failure);
  return result;
}

export function asBookmarkCreationResult(result: unknown): BookmarkCreationResult | undefined {
  const value = parseResult<{ created: unknown; node: unknown }>(result, () => true);
  const node = asBookmarkNode(value?.node);
  return node && typeof value?.created === 'boolean' ? { created: value.created, node } : undefined;
}

type IntentSubmitter = (
  kind: HyperActionKind,
  payload: unknown,
  optimistic?: undefined,
  options?: { awaitSettlement?: boolean },
) => Promise<boolean>;

/** Submits an intent, optionally shown at once, and fails with `errorMessage` unless it settles successfully. */
export function createSettledIntentSubmitter<State>(submitIntent: (
  kind: HyperActionKind,
  payload: unknown,
  optimistic: ((current: State) => State) | undefined,
  options: { awaitSettlement: boolean },
) => Promise<boolean>) {
  return async (
    kind: HyperActionKind,
    payload: unknown,
    errorMessage: string,
    optimistic?: (current: State) => State,
  ): Promise<void> => {
    if (!await submitIntent(kind, payload, optimistic, { awaitSettlement: true })) {
      throw new Error(errorMessage);
    }
  };
}

interface AdmissionClient {
  submitIntent(
    kind: HyperActionKind,
    payload: unknown,
    commandId: string,
  ): Promise<{ status: 'accepted' | 'rejected' }>;
}

interface SettlementWaiters {
  waitFor(commandId: string): Promise<{ succeeded: boolean }>;
}

/** Resolves once the model admits a space choice, carrying whether it later succeeded. */
export function createSpaceSelectionAdmitter(
  client: () => AdmissionClient | undefined,
  settlement: SettlementWaiters,
) {
  return async (spaceId: string): Promise<{ settled: Promise<boolean> } | undefined> => {
    const active = client();
    if (!active) return undefined;
    const commandId = crypto.randomUUID();
    if ((await active.submitIntent('selectSpace', { spaceId }, commandId)).status === 'rejected') {
      return undefined;
    }
    return { settled: settlement.waitFor(commandId).then((outcome) => outcome.succeeded) };
  };
}

type BackingOperationRunner = (operation: () => Promise<void>) => Promise<void>;
type SettledIntentSubmitter = (
  kind: HyperActionKind,
  payload: unknown,
  errorMessage: string,
) => Promise<void>;

export function createBrowserFeatureIntentSubmitters(
  submitSettledIntent: SettledIntentSubmitter,
) {
  return {
    setTabMediaPlayback: (tabId: number, state: 'paused' | 'playing') => submitSettledIntent(
      'setTabMediaPlayback',
      { state, tabId },
      'Playback could not be changed.',
    ),
  };
}

export function createBrowserCommandSubmitter(
  closeTabs: (tabIds: readonly number[]) => Promise<void>,
  runBackingOperation: BackingOperationRunner,
  submitSettledIntent: SettledIntentSubmitter,
) {
  return (intent: BrowserCommandIntent): Promise<void> => {
    if (intent.kind === 'closeTabs') return closeTabs(intent.payload.tabIds);
    return runBackingOperation(() => submitSettledIntent(
      intent.kind,
      intent.payload,
      'That browser action could not be completed.',
    ));
  };
}

type ResultSubmitter = <Result>(
  kind: HyperActionKind,
  payload: unknown,
  parse: (result: unknown) => Result | undefined,
) => Promise<Result | undefined>;

/** Bookmarks the view asks for; each answers with the node it made, and a favourite takes its slot in the same intent. */
export function createBookmarkCreationSubmitters(submitIntentForResult: ResultSubmitter) {
  return {
    addCurrentPage: async (parentId: string, favouriteSlot?: number) => required(
      await submitIntentForResult('createBookmark', {
        ...(favouriteSlot === undefined ? {} : { favouriteSlot }),
        parentId,
      }, asBookmarkCreationResult),
      'The current page cannot be bookmarked.',
    ),
    addTabBookmark: async (
      parentId: string,
      tabId: number,
      index?: number,
      favouriteSlot?: number,
    ) => required(
      await submitIntentForResult('createBookmark', {
        ...(favouriteSlot === undefined ? {} : { favouriteSlot }),
        ...(index === undefined ? {} : { index }),
        parentId,
        tabId,
      }, asBookmarkCreationResult),
      'This tab cannot be bookmarked.',
    ),
    createFolder: async (parentId: string) => required(
      await submitIntentForResult('createBookmarkFolder', { parentId }, asBookmarkNode),
      'This folder could not be created.',
    ),
  };
}

export function createTabFolderIntentSubmitters(
  submitIntent: IntentSubmitter,
  submitIntentForResult: ResultSubmitter,
) {
  // Creating a folder answers with the node, because the caller opens it for
  // renaming straight away. The result arrives on the revision that already
  // contains the folder, so the view never names an entity it cannot yet see.
  const createTabFolder = async (spaceId: string, parentId?: string) => required(
    await submitIntentForResult<BookmarkNode>('setTabFolder', {
      operation: 'create',
      spaceId,
      ...(parentId !== undefined ? { parentId } : {}),
    }, asBookmarkNode),
    'This folder could not be created.',
  );

  const renameTabFolder = (folderId: string, title: string) =>
    submitIntent('setTabFolder', { folderId, operation: 'rename', title });

  const removeTabFolder = (folderId: string, withTabs = false) =>
    submitIntent('setTabFolder', { folderId, operation: 'remove', ...(withTabs ? { withTabs } : {}) });

  const moveTabTreeNode = (
    spaceId: string,
    nodeIds: readonly string[],
    destination: { parentId: string; index?: number },
  ) => submitIntent('setTabFolder', {
    nodeIds,
    operation: 'move',
    parentId: destination.parentId,
    spaceId,
    ...(destination.index !== undefined ? { index: destination.index } : {}),
  });

  return { createTabFolder, moveTabTreeNode, removeTabFolder, renameTabFolder };
}

type OutcomeSubmitter<State> = (
  kind: HyperActionKind,
  payload: unknown,
  optimistic?: (current: State) => State,
  options?: { awaitSettlement?: boolean },
) => Promise<CommandSettlementOutcome>;

/** Where a move shows at once; a step resolves against the tree it is laid over, as the background resolves it. */
function optimisticDestination(
  tree: BookmarkNode[],
  move: MoveBookmarkPayload,
): { index?: number; parentId?: string } | undefined {
  if (move.offset === undefined) return { index: move.index, parentId: move.parentId };
  const parentId = findBookmarkNode(tree, move.bookmarkId)?.parentId;
  if (!parentId) return undefined;
  const index = bookmarkStepIndex(findBookmarkNode(tree, parentId)?.children ?? [], move.bookmarkId, move.offset);
  return index === undefined ? undefined : { index, parentId };
}

/** Moves and deletions show at once, held against their command until it settles. */
function selectionOverlay<State extends { bookmarkTree: BookmarkNode[] }>(
  kind: keyof IntentItemPayloads,
  items: readonly unknown[],
): ((current: State) => State) | undefined {
  if (kind === 'moveBookmark') {
    return (current) => ({
      ...current,
      bookmarkTree: (items as readonly MoveBookmarkPayload[]).reduce(
        (tree, move) => {
          const destination = optimisticDestination(tree, move);
          return destination ? moveBookmarkOptimistically(tree, move.bookmarkId, destination) : tree;
        },
        current.bookmarkTree,
      ),
    });
  }
  if (kind === 'deleteBookmark') {
    return (current) => ({
      ...current,
      bookmarkTree: (items as readonly DeleteBookmarkPayload[]).reduce(
        (tree, { bookmarkId }) => removeBookmarkOptimistically(tree, bookmarkId),
        current.bookmarkTree,
      ),
    });
  }
  return undefined;
}

/**
 * Bookmark edits the view asks for. A dropped selection goes as one intent
 * carrying every item, so the view waits for one outcome rather than
 * sequencing an intent per item.
 */
export function createBookmarkEditSubmitters<State extends { bookmarkTree: BookmarkNode[] }>(
  submitIntentForOutcome: OutcomeSubmitter<State>,
) {
  const submitSelection = async <Kind extends keyof IntentItemPayloads>(
    kind: Kind,
    items: readonly IntentItemPayloads[Kind][],
  ): Promise<readonly unknown[]> => {
    if (items.length === 0) return [];
    const outcome = await submitIntentForOutcome(kind, { items }, selectionOverlay<State>(kind, items), {
      awaitSettlement: true,
    });
    if (!outcome.succeeded || !Array.isArray(outcome.result)) {
      throw new Error('The selection could not be changed.');
    }
    return outcome.result;
  };
  return {
    copyBookmark: async (
      id: string,
      destination: { parentId: string; index?: number },
      options: { favouriteSlot?: number; skipExisting?: boolean } = {},
    ) => {
      const outcome = await submitIntentForOutcome('copyBookmark', {
        bookmarkId: id,
        ...(options.favouriteSlot === undefined ? {} : { favouriteSlot: options.favouriteSlot }),
        ...(destination.index === undefined ? {} : { index: destination.index }),
        parentId: destination.parentId,
        ...(options.skipExisting === undefined ? {} : { skipExisting: options.skipExisting }),
      }, undefined, { awaitSettlement: true });
      if (!outcome.succeeded) throw new Error('This bookmark could not be copied.');
      if (outcome.result === undefined) return undefined;
      const copied = asBookmarkNode(outcome.result);
      if (!copied) throw new Error('The copied bookmark could not be read.');
      return copied;
    },
    moveBookmark: async (id: string, destination: { parentId?: string; index?: number }) => {
      const outcome = await submitIntentForOutcome(
        'moveBookmark',
        {
          bookmarkId: id,
          ...(destination.index !== undefined ? { index: destination.index } : {}),
          ...(destination.parentId ? { parentId: destination.parentId } : {}),
        },
        selectionOverlay<State>('moveBookmark', [{ bookmarkId: id, ...destination }]),
        { awaitSettlement: true },
      );
      if (!outcome.succeeded) throw new Error('This bookmark could not be moved.');
    },
    /** Steps a bookmark past one sibling, which the background finds when the move runs. */
    moveBookmarkStep: async (id: string, offset: -1 | 1) => {
      const move = { bookmarkId: id, offset };
      const outcome = await submitIntentForOutcome(
        'moveBookmark',
        move,
        selectionOverlay<State>('moveBookmark', [move]),
        { awaitSettlement: true },
      );
      if (!outcome.succeeded) throw new Error('This bookmark could not be moved.');
    },
    submitSelection,
  };
}

/** What a sidebar asks of other windows: their tabs, and drags it shares with them or takes from them. */
export function createCrossWindowIntentSubmitters(
  runBackingOperation: BackingOperationRunner,
  submitSettledIntent: SettledIntentSubmitter,
) {
  return {
    /** Closes a page this sidebar shows wherever that space has it open. */
    closeTabsInSpace: (source: RemoteTabReference, spaceId: string) =>
      runBackingOperation(() => submitSettledIntent(
        'closeTabs',
        { condition: 'page-in-space', source, spaceId },
        'Those tabs could not be closed.',
      )),
    focusRemoteTab: (source: RemoteTabReference, spaceId: string) => submitSettledIntent(
      'activateTab',
      { operation: 'remote', source, spaceId },
      'The remote tab could not be focused.',
    ),
    moveRemoteTabToWindow: (source: RemoteTabReference, spaceId: string) =>
      runBackingOperation(() => submitSettledIntent(
        'moveTabToWindow',
        { source, spaceId },
        'The remote tab could not be moved.',
      )),
    offerDrag: (token: string, items: readonly SharedDragReference[]) => submitSettledIntent(
      'shareDrag',
      { items, operation: 'offer', token },
      'The drag could not be offered to other windows.',
    ),
    /** Brings the tabs of a drag another window shared into this window, where they were dropped. */
    takeSharedDragTabs: (
      token: string,
      windowId: number,
      index: number,
      tree: NonNullable<MoveTabsPayload['tree']>,
    ) => runBackingOperation(() => submitSettledIntent(
      'moveTabs',
      { index, sharedDrag: token, tree, windowId },
      'Those tabs could not be moved to this window.',
    )),
    /** Puts this window's own tabs in a space, at a place in its tab tree, as a paste does. */
    moveTabsIntoTree: (
      tabIds: readonly number[],
      windowId: number,
      index: number,
      tree: NonNullable<MoveTabsPayload['tree']>,
    ) => runBackingOperation(() => submitSettledIntent(
      'moveTabs',
      { index, tabIds, tree, windowId },
      'Those tabs could not be moved here.',
    )),
    withdrawDrag: (token: string) => submitSettledIntent(
      'shareDrag',
      { operation: 'withdraw', token },
      'The drag could not be withdrawn from other windows.',
    ),
  };
}

export function createSplitViewIntentSubmitter(
  runBackingOperation: BackingOperationRunner,
  submitSettledIntent: SettledIntentSubmitter,
) {
  return {
    /** Shows another tab, or a page in a new tab, beside `tabId` in the browser's split view. */
    splitTab: (split: { tabId: number } & ({ url: string } | { withTabId: number })) =>
      runBackingOperation(() => submitSettledIntent(
        'splitTab',
        'url' in split
          ? { tabId: split.tabId, url: split.url }
          : { tabId: split.tabId, withTabId: split.withTabId },
        'These tabs could not be shown side by side.',
      )),
  };
}

type TrackedOperationRunner = <Result>(operation: () => Promise<Result>) => Promise<Result>;

/** What a sidebar asks of a whole space: a new one, a copy of one, and this window's tabs in one. */
export function createSpaceIntentSubmitters<State extends { bookmarkTree: BookmarkNode[] }>(
  spacesFolderId: string | null,
  runBackingOperation: TrackedOperationRunner,
  submitIntentForResult: ResultSubmitter,
  submitSettledIntent: SettledIntentSubmitter,
  submitIntentForOutcome: OutcomeSubmitter<State>,
) {
  return {
    closeSpaceTabs: (spaceId: string) => runBackingOperation(() => submitSettledIntent(
      'closeSpaceTabs',
      { spaceId },
      'These tabs could not be closed.',
    )),
    createSpace: () => runBackingOperation(async () => {
      if (!spacesFolderId) throw new Error('Spaces are unavailable.');
      return required(
        await submitIntentForResult('createSpace', { spacesFolderId }, asBookmarkNode),
        'This space could not be created.',
      );
    }),
    /** Copies a space beside it, with this window's tabs in it when `withTabs`, and answers the copy. */
    duplicateSpace: (spaceId: string, withTabs: boolean) => runBackingOperation(async () => required(
      await submitIntentForResult('duplicateSpace', { spaceId, withTabs }, asBookmarkNode),
      'This space could not be duplicated.',
    )),
    reloadSpaceTabs: (spaceId: string) => submitSettledIntent(
      'reloadSpaceTabs',
      { spaceId },
      'These tabs could not be reloaded.',
    ),
    ...createSpaceArchiveSubmitter(runBackingOperation, submitIntentForOutcome),
  };
}

/**
 * Archives or unarchives a space, placed before `beforeSpaceId` or last.
 * The flag and move show at once, held against the command until it settles.
 */
function createSpaceArchiveSubmitter<State extends { bookmarkTree: BookmarkNode[] }>(
  runBackingOperation: TrackedOperationRunner,
  submitIntentForOutcome: OutcomeSubmitter<State>,
) {
  return {
    setSpaceArchived: (spaceId: string, archived: boolean, beforeSpaceId?: string) =>
      runBackingOperation(async () => {
        const outcome = await submitIntentForOutcome(
          'setSpaceArchived',
          { archived, spaceId, ...(beforeSpaceId ? { beforeSpaceId } : {}) },
          (current) => {
            const space = findBookmarkNode(current.bookmarkTree, spaceId);
            if (!space?.parentId) return current;
            const before = beforeSpaceId ? findBookmarkNode(current.bookmarkTree, beforeSpaceId) : undefined;
            const flagged = updateBookmarkOptimistically(current.bookmarkTree, spaceId, {
              title: spaceBookmarkTitleWithArchived(space, archived),
            });
            return {
              ...current,
              bookmarkTree: moveBookmarkOptimistically(flagged, spaceId, {
                parentId: space.parentId,
                ...(before?.parentId === space.parentId && before.index !== undefined
                  ? { index: before.index }
                  : {}),
              }),
            };
          },
          { awaitSettlement: true },
        );
        if (!outcome.succeeded) {
          throw new Error(archived ? 'This space could not be archived.' : 'This space could not be unarchived.');
        }
      }),
  };
}

type SettledSubmit = (
  kind: HyperActionKind,
  payload: unknown,
  optimistic: undefined,
  options: { awaitSettlement: boolean },
) => Promise<boolean>;

/** Search picks only tune later searches, so each waits for its own settlement and no view state. */
export function searchSelectionIntents(submit: SettledSubmit) {
  const settled = { awaitSettlement: true };
  return {
    forgetSearchSelection: (resultId: string) =>
      submit('forgetSearchSelection', { resultId }, undefined, settled),
    recordSearchSelection: (query: string, resultId: string) =>
      submit('recordSearchSelection', { query, resultId }, undefined, settled),
  };
}

/** The window's timed message is model state, so the view only names it and the background acts. */
export function timedMessageIntents(submitIntent: (kind: HyperActionKind, payload: unknown) => Promise<boolean>) {
  return {
    actOnTimedMessage: (messageId: string) => submitIntent('actOnTimedMessage', { messageId }),
    dismissTimedMessage: (messageId: string) => submitIntent('dismissTimedMessage', { messageId }),
    showMessage: (text: string, tone: TimedMessageTone) => submitIntent('showMessage', { text, tone }),
  };
}
