import { describe, expect, it } from 'vitest';
import {
  MAX_PENDING_COMMANDS_PER_CLIENT,
  MAX_SETTLED_COMMANDS,
  beginCommand,
  closeTabsViolations,
  commandStatusesForClient,
  deleteSpaceViolations,
  destructiveOutcomePolicies,
  emptyCommandStatusTable,
  forgetClientCommands,
  retainCommandStatuses,
  settleCommand,
  type CommandStatusTable,
} from './modelActions';

function begin(
  table: CommandStatusTable,
  commandId: string,
  clientId = 'client-a',
): CommandStatusTable {
  const result = beginCommand(table, {
    clientId,
    commandId,
    kind: 'closeTabs',
    startedRevision: 1,
    targets: [],
  });
  if (result.status !== 'accepted') throw new Error(result.reason);
  return result.table;
}

describe('command status lifecycle', () => {
  it('rejects a replayed command id rather than losing the original outcome', () => {
    const table = begin(emptyCommandStatusTable, 'command-1');
    expect(beginCommand(table, {
      clientId: 'client-a',
      commandId: 'command-1',
      kind: 'closeTabs',
      startedRevision: 2,
      targets: [],
    })).toEqual({ reason: 'duplicate-command-id', status: 'rejected' });
  });

  it('applies backpressure per client so one view cannot flood the lane', () => {
    let table = emptyCommandStatusTable;
    for (let index = 0; index < MAX_PENDING_COMMANDS_PER_CLIENT; index += 1) {
      table = begin(table, `command-${index}`);
    }
    expect(beginCommand(table, {
      clientId: 'client-a',
      commandId: 'overflow',
      kind: 'closeTabs',
      startedRevision: 2,
      targets: [],
    })).toEqual({ reason: 'too-many-pending', status: 'rejected' });

    // A different client still has its own budget.
    expect(beginCommand(table, {
      clientId: 'client-b',
      commandId: 'other',
      kind: 'closeTabs',
      startedRevision: 2,
      targets: [],
    }).status).toBe('accepted');
  });

  it('records the revision that proves a terminal outcome and settles only once', () => {
    const started = begin(emptyCommandStatusTable, 'command-1');
    const settled = settleCommand(started, 'command-1', { phase: 'succeeded' }, 7);
    expect(settled['command-1']).toMatchObject({ phase: 'succeeded', settledRevision: 7 });

    const again = settleCommand(settled, 'command-1', {
      failure: 'superseded',
      phase: 'failed',
    }, 8);
    expect(again).toBe(settled);
  });

  it('carries a result on the revision that proves it', () => {
    const started = begin(emptyCommandStatusTable, 'command-1');
    const created = { id: 'folder-9' };
    const settled = settleCommand(started, 'command-1', {
      phase: 'succeeded',
      result: created,
    }, 7);
    expect(settled['command-1']).toMatchObject({ result: created, settledRevision: 7 });
  });

  it('leaves a result absent rather than undefined when there was none', () => {
    const started = begin(emptyCommandStatusTable, 'command-1');
    const settled = settleCommand(started, 'command-1', { phase: 'succeeded' }, 7);
    expect(settled['command-1']).not.toHaveProperty('result');
  });

  it('retains every pending command while bounding settled ones', () => {
    let table = begin(emptyCommandStatusTable, 'pending-1');
    for (let index = 0; index < MAX_SETTLED_COMMANDS + 5; index += 1) {
      table = begin(table, `settled-${index}`, `client-${index}`);
      table = settleCommand(table, `settled-${index}`, { phase: 'succeeded' }, index + 1);
    }
    const retained = retainCommandStatuses(table);
    expect(retained['pending-1']).toBeDefined();
    expect(Object.keys(retained)).toHaveLength(MAX_SETTLED_COMMANDS + 1);
    expect(retained['settled-0']).toBeUndefined();
    expect(retained[`settled-${MAX_SETTLED_COMMANDS + 4}`]).toBeDefined();
  });

  it('correlates statuses to the client that issued them and to nobody else', () => {
    let table = begin(emptyCommandStatusTable, 'mine', 'client-a');
    table = begin(table, 'theirs', 'client-b');
    expect(commandStatusesForClient(table, 'client-a').map((status) => status.commandId))
      .toEqual(['mine']);
  });

  it('drops a disconnected client\'s settled work but keeps its running effect', () => {
    let table = begin(emptyCommandStatusTable, 'done', 'client-a');
    table = settleCommand(table, 'done', { phase: 'succeeded' }, 2);
    table = begin(table, 'running', 'client-a');
    const remaining = forgetClientCommands(table, 'client-a');
    expect(Object.keys(remaining)).toEqual(['running']);
  });
});

describe('destructive outcomes', () => {
  it('deletes a space with its bookmarks but never user tab groups', () => {
    expect(destructiveOutcomePolicies.deleteSpace).toEqual({
      authoredBookmarks: 'delete',
      backings: 'delete',
      groups: 'release',
      liveTabs: 'close-owned',
    });
    expect(destructiveOutcomePolicies.closeTabs.backings).toBe('delete-unclaimed');
  });

  it('reports every unmet delete-space postcondition', () => {
    expect(deleteSpaceViolations({
      ownedTabIds: [1, 2],
      releasedGroupIds: [9],
      spaceRootId: 'space-root',
    }, {
      bookmarkParentIds: new Map([['space-root', 'spaces']]),
      claimedBackingIds: new Set(),
      liveGroupIds: new Set([9]),
      liveTabIds: new Set([2]),
      mappedGroupIds: new Set([9]),
    })).toEqual([
      'space root space-root still present',
      'owned tab 2 still open',
      'group 9 still has tabs',
      'group 9 still mapped',
    ]);
  });

  it('accepts a retained backing only when another tab still claims it', () => {
    const observed = {
      bookmarkParentIds: new Map([['claimed', 'tabs'], ['orphan', 'tabs']]),
      claimedBackingIds: new Set(['claimed']),
      liveGroupIds: new Set<number>(),
      liveTabIds: new Set<number>(),
      mappedGroupIds: new Set<number>(),
    };
    expect(closeTabsViolations({
      closedTabIds: [1],
      removedBackingIds: [],
      retainedBackingIds: ['claimed'],
    }, observed)).toEqual([]);
    expect(closeTabsViolations({
      closedTabIds: [1],
      removedBackingIds: ['orphan'],
      retainedBackingIds: [],
    }, observed)).toEqual(['backing orphan still present']);
  });
});
