import { describe, expect, it, vi } from 'vitest';
import { serializeBookmarkTitle, type BookmarkNode } from './bookmarks';
import {
  emptyBrowserObservation,
  emptyRuntimeMetadata,
  type HyperModelSnapshot,
} from './model';
import type { HyperModelPortClient } from './modelPort';
import { parseMoveTabsPayload, parseShareDragPayload } from './modelIntentPayloads';
import { createSharedDragController, projectSharedDrag } from './sharedDrag';
import { testTab } from './testFixtures';

const sidebar = (windowId: number, clientId = `sidebar-${windowId}`): HyperModelPortClient =>
  ({ clientId, role: 'sidebar', windowId });

const snapshot = {
  browser: {
    ...emptyBrowserObservation,
    bookmarkTree: [{
      children: [{ id: 'docs', syncing: false, title: serializeBookmarkTitle('Docs', {}), url: 'https://docs.test/' }],
      id: 'root',
      syncing: false,
      title: '',
    }] as BookmarkNode[],
    tabs: [
      testTab({ id: 7, windowId: 1 }),
      testTab({ id: 8, windowId: 2 }),
      testTab({ id: 9, incognito: true, windowId: 1 }),
    ],
  },
  runtime: emptyRuntimeMetadata,
} as unknown as HyperModelSnapshot;

const controller = () => {
  const reconcile = vi.fn(async () => undefined);
  return { reconcile, shared: createSharedDragController({ readSnapshot: () => snapshot, reconcile }) };
};

describe('shared drags', () => {
  it('keeps a drag a sidebar offers, showing other windows only what they already have', async () => {
    const { shared } = controller();
    const offer = { items: [{ kind: 'tab', tabId: 7 }, { kind: 'tree', nodeId: 'docs' }], operation: 'offer', token: 't1' };

    await shared.handlers.shareDrag!.run(offer, sidebar(1));

    const { sharedDrag } = shared.runtimeSignals();
    expect(sharedDrag).toEqual({ items: offer.items, sourceWindowId: 1, token: 't1' });
    expect(projectSharedDrag(sharedDrag, 2)).toEqual({
      items: [{ kind: 'tab' }, { kind: 'tree', nodeId: 'docs' }],
      token: 't1',
    });
    expect(projectSharedDrag(sharedDrag, 1)).toBeNull();
    expect(shared.tabIds('t1', 2)).toEqual([7]);
    expect(shared.tabIds('t1', 1)).toBeUndefined();
    expect(shared.tabIds('other', 2)).toBeUndefined();
  });

  it('refuses a tab the sidebar\'s window does not show, or a bookmark that is gone', async () => {
    const { shared } = controller();
    const run = (items: unknown[], client = sidebar(1)) =>
      shared.handlers.shareDrag!.run({ items, operation: 'offer', token: 't1' }, client);

    await expect(run([{ kind: 'tab', tabId: 8 }])).rejects.toThrow('own window');
    await expect(run([{ kind: 'tab', tabId: 9 }])).rejects.toThrow('own window');
    await expect(run([{ kind: 'favourite', nodeId: 'gone' }])).rejects.toThrow('no longer exists');
    await expect(run([{ kind: 'tab', tabId: 7 }], { ...sidebar(1), role: 'newtab' }))
      .rejects.toThrow('Only a sidebar');
    expect(shared.runtimeSignals().sharedDrag).toBeNull();
  });

  it('stops showing a withdrawn drag but still lets the drop that raced it take its tabs', async () => {
    const { reconcile, shared } = controller();
    await shared.handlers.shareDrag!.run(
      { items: [{ kind: 'tab', tabId: 7 }], operation: 'offer', token: 't1' },
      sidebar(1),
    );

    await shared.handlers.shareDrag!.run({ operation: 'withdraw', token: 't1' }, sidebar(1, 'someone-else'));
    expect(shared.runtimeSignals().sharedDrag).not.toBeNull();
    await shared.handlers.shareDrag!.run({ operation: 'withdraw', token: 't1' }, sidebar(1));
    expect(shared.runtimeSignals().sharedDrag).toBeNull();
    expect(shared.tabIds('t1', 2)).toEqual([7]);

    shared.release('sidebar-1');
    expect(shared.tabIds('t1', 2)).toBeUndefined();
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(shared.handlers.shareDrag!.targets({ operation: 'withdraw', token: 't1' }, sidebar(1))).toEqual([]);
  });

  it('reads shared drag and tab move payloads strictly', () => {
    expect(() => parseShareDragPayload({ items: [], operation: 'offer', token: 't' })).toThrow();
    expect(() => parseShareDragPayload({ items: [{ kind: 'tab-folder', nodeId: 'f' }], operation: 'offer', token: 't' }))
      .toThrow();
    expect(() => parseShareDragPayload({ operation: 'withdraw', token: 'x'.repeat(129) })).toThrow();
    expect(parseShareDragPayload({ operation: 'withdraw', token: 't' })).toEqual({ operation: 'withdraw', token: 't' });

    expect(parseMoveTabsPayload({ index: 2, sharedDrag: 't', tree: { spaceId: 's' }, windowId: 3 })).toEqual({
      index: 2,
      sharedDrag: 't',
      tree: { index: undefined, parentId: undefined, spaceId: 's' },
      windowId: 3,
    });
    expect(() => parseMoveTabsPayload({ index: 2, sharedDrag: 't', tabIds: [1], windowId: 3 })).toThrow();
    expect(() => parseMoveTabsPayload({ index: 2, tabIds: [1], tree: { index: -1, spaceId: 's' }, windowId: 3 }))
      .toThrow();
  });
});
