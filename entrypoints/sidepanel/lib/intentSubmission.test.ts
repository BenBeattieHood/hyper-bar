import { describe, expect, it, vi } from 'vitest';
import {
  createBookmarkEditSubmitters,
  createBrowserCommandSubmitter,
  createCrossWindowIntentSubmitters,
  createSpaceSelectionAdmitter,
  searchSelectionIntents,
} from './intentSubmission';
import { createCommandSettlementTracker } from './commandSettlement';

describe('createBookmarkEditSubmitters', () => {
  type Node = Browser.bookmarks.BookmarkTreeNode;
  const folder = (id: string, children: Node[] = []): Node =>
    ({ children, id, parentId: 'root', syncing: false, title: id });

  it('sends a selection as one intent and shows the whole drop at once', async () => {
    const submit = vi.fn(async (
      _kind: string,
      _payload: unknown,
      _optimistic?: (state: { bookmarkTree: Node[] }) => { bookmarkTree: Node[] },
      _options?: { awaitSettlement?: boolean },
    ) => ({ result: [undefined, undefined], succeeded: true }));
    const { submitSelection } = createBookmarkEditSubmitters(submit);
    const moves = [
      { bookmarkId: 'a', index: 0, parentId: 'to' },
      { bookmarkId: 'b', index: 1, parentId: 'to' },
    ];

    await expect(submitSelection('moveBookmark', moves)).resolves.toEqual([undefined, undefined]);
    await expect(submitSelection('deleteBookmark', [])).resolves.toEqual([]);

    expect(submit).toHaveBeenCalledTimes(1);
    const [kind, payload, optimistic, options] = submit.mock.calls[0]!;
    expect([kind, payload, options]).toEqual(['moveBookmark', { items: moves }, { awaitSettlement: true }]);
    const moved = optimistic!({ bookmarkTree: [
      folder('from', [folder('a'), folder('b')]),
      folder('to'),
    ] }).bookmarkTree;
    expect(moved[0]?.children).toEqual([]);
    expect(moved[1]?.children?.map((node) => node.id)).toEqual(['a', 'b']);
  });

  it('sends a step for the background to resolve and shows it at once, unless it is at that end', async () => {
    const submit = vi.fn(async (
      _kind: string,
      _payload: unknown,
      _optimistic?: (state: { bookmarkTree: Node[] }) => { bookmarkTree: Node[] },
    ) => ({ succeeded: true }));
    const { moveBookmarkStep } = createBookmarkEditSubmitters(submit);
    const child = (id: string): Node => ({ id, parentId: 'list', syncing: false, title: id });
    const bookmarkTree = [folder('list', [child('a'), child('b'), child('c')])];

    await moveBookmarkStep('a', 1);
    await moveBookmarkStep('c', 1);

    const [, payload, stepDown] = submit.mock.calls[0]!;
    const [, , stepPastEnd] = submit.mock.calls[1]!;
    expect(payload).toEqual({ bookmarkId: 'a', offset: 1 });
    expect(stepDown!({ bookmarkTree }).bookmarkTree[0]?.children?.map((node) => node.id)).toEqual(['b', 'a', 'c']);
    expect(stepPastEnd!({ bookmarkTree }).bookmarkTree).toBe(bookmarkTree);
  });

  it('fails the selection when the command fails', async () => {
    const { submitSelection } = createBookmarkEditSubmitters(
      vi.fn(async () => ({ succeeded: false })),
    );

    await expect(submitSelection('deleteBookmark', [{ bookmarkId: 'a' }]))
      .rejects.toThrow('The selection could not be changed.');
  });
});

describe('createSpaceSelectionAdmitter', () => {
  it('resolves on admission and settles with the command', async () => {
    const settlement = createCommandSettlementTracker();
    const submitIntent = vi.fn(async () => ({ status: 'accepted' as const }));
    const admit = createSpaceSelectionAdmitter(() => ({ submitIntent }), settlement);

    const admitted = await admit('space-2');
    const [, payload, commandId] = submitIntent.mock.calls[0] as unknown as [string, unknown, string];
    expect(payload).toEqual({ spaceId: 'space-2' });
    settlement.record([{
      clientId: 'client',
      commandId,
      kind: 'selectSpace',
      phase: 'failed',
      startedRevision: 1,
      targets: [],
    }]);

    await expect(admitted?.settled).resolves.toBe(false);
  });

  it('reports nothing admitted when the model refuses or is unavailable', async () => {
    const settlement = createCommandSettlementTracker();
    const refusing = { submitIntent: async () => ({ status: 'rejected' as const }) };

    await expect(createSpaceSelectionAdmitter(() => refusing, settlement)('space-2'))
      .resolves.toBeUndefined();
    await expect(createSpaceSelectionAdmitter(() => undefined, settlement)('space-2'))
      .resolves.toBeUndefined();
  });
});

/** A backing-operation lane and settled-intent submitter that record what they were asked. */
function lane() {
  return {
    runBackingOperation: vi.fn(async (operation: () => Promise<void>) => operation()),
    submitSettledIntent: vi.fn(async (_kind: string, _payload: unknown, _message: string) => undefined),
  };
}

describe('createBrowserCommandSubmitter', () => {
  const browserCommands = () => {
    const closeTabs = vi.fn(async () => undefined);
    const { runBackingOperation, submitSettledIntent } = lane();
    const submit = createBrowserCommandSubmitter(closeTabs, runBackingOperation, submitSettledIntent);
    return { closeTabs, runBackingOperation, submit, submitSettledIntent };
  };

  it('preserves the optimistic close-tabs route', async () => {
    const { closeTabs, runBackingOperation, submit, submitSettledIntent } = browserCommands();

    await submit({ kind: 'closeTabs', payload: { tabIds: [7, 8] } });

    expect(closeTabs).toHaveBeenCalledWith([7, 8]);
    expect(runBackingOperation).not.toHaveBeenCalled();
    expect(submitSettledIntent).not.toHaveBeenCalled();
  });

  it('waits for every other browser command to settle in the backing-operation lane', async () => {
    const { runBackingOperation, submit, submitSettledIntent } = browserCommands();

    await submit({ kind: 'reloadTab', payload: { tabId: 7 } });

    expect(runBackingOperation).toHaveBeenCalledTimes(1);
    expect(submitSettledIntent).toHaveBeenCalledWith(
      'reloadTab',
      { tabId: 7 },
      'That browser action could not be completed.',
    );
  });
});

describe('createCrossWindowIntentSubmitters', () => {
  it('submits opaque local sources without a remote tab identifier', async () => {
    const { runBackingOperation, submitSettledIntent } = lane();
    const submitters = createCrossWindowIntentSubmitters(runBackingOperation, submitSettledIntent);

    await submitters.focusRemoteTab({ kind: 'tab', tabId: 7 }, 'two');
    await submitters.moveRemoteTabToWindow({ bookmarkId: 'visible-bookmark', kind: 'bookmark' }, 'two');
    await submitters.closeTabsInSpace({ kind: 'tab', tabId: 7 }, 'two');

    expect(submitSettledIntent.mock.calls).toEqual([
      ['activateTab', { operation: 'remote', source: { kind: 'tab', tabId: 7 }, spaceId: 'two' },
        'The remote tab could not be focused.'],
      ['moveTabToWindow', { source: { bookmarkId: 'visible-bookmark', kind: 'bookmark' }, spaceId: 'two' },
        'The remote tab could not be moved.'],
      ['closeTabs', { condition: 'page-in-space', source: { kind: 'tab', tabId: 7 }, spaceId: 'two' },
        'Those tabs could not be closed.'],
    ]);
    expect(JSON.stringify(submitSettledIntent.mock.calls)).not.toContain('remoteTabId');
  });

  it('takes a shared drag\'s tabs by its token, never by remote tab IDs', async () => {
    const { runBackingOperation, submitSettledIntent } = lane();
    const submitters = createCrossWindowIntentSubmitters(runBackingOperation, submitSettledIntent);

    await submitters.offerDrag('token-1', [{ kind: 'tab', tabId: 7 }]);
    await submitters.takeSharedDragTabs('token-2', 3, 4, { parentId: 'root', spaceId: 'two' });
    await submitters.withdrawDrag('token-1');

    expect(submitSettledIntent.mock.calls.map(([kind, payload]) => [kind, payload])).toEqual([
      ['shareDrag', { items: [{ kind: 'tab', tabId: 7 }], operation: 'offer', token: 'token-1' }],
      ['moveTabs', { index: 4, sharedDrag: 'token-2', tree: { parentId: 'root', spaceId: 'two' }, windowId: 3 }],
      ['shareDrag', { operation: 'withdraw', token: 'token-1' }],
    ]);
    expect(runBackingOperation).toHaveBeenCalledTimes(1);
  });
});
describe('search selection intents', () => {
  it('submits picks and forgets as settled intents without optimistic state', async () => {
    const submit = vi.fn(async () => true);
    const intents = searchSelectionIntents(submit);

    await expect(intents.recordSearchSelection('docs', 'bookmark:https://docs.example/')).resolves.toBe(true);
    await expect(intents.forgetSearchSelection('command:settings')).resolves.toBe(true);

    expect(submit.mock.calls).toEqual([
      ['recordSearchSelection', { query: 'docs', resultId: 'bookmark:https://docs.example/' }, undefined, { awaitSettlement: true }],
      ['forgetSearchSelection', { resultId: 'command:settings' }, undefined, { awaitSettlement: true }],
    ]);
  });
});
