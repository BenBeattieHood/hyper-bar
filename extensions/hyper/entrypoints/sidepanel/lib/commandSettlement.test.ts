import { describe, expect, it } from 'vitest';
import { createCommandSettlementTracker } from './commandSettlement';
import type { CommandStatus } from '../../lib/modelActions';

function status(
  commandId: string,
  phase: CommandStatus['phase'],
  overrides: Partial<CommandStatus> = {},
): CommandStatus {
  return {
    clientId: 'client-1',
    commandId,
    kind: 'activateTab',
    phase,
    startedRevision: 1,
    targets: [],
    ...overrides,
  };
}

describe('createCommandSettlementTracker', () => {
  it('accumulates reported statuses in the table', () => {
    const tracker = createCommandSettlementTracker();
    tracker.record([status('a', 'pending')]);
    tracker.record([status('b', 'succeeded')]);
    expect(Object.keys(tracker.statuses()).sort()).toEqual(['a', 'b']);
    expect(tracker.statuses().a?.phase).toBe('pending');
  });

  it('overwrites an earlier status for the same command', () => {
    const tracker = createCommandSettlementTracker();
    tracker.record([status('a', 'pending')]);
    tracker.record([status('a', 'succeeded', { settledRevision: 4 })]);
    expect(tracker.statuses().a?.phase).toBe('succeeded');
    expect(tracker.statuses().a?.settledRevision).toBe(4);
  });

  it('treats an empty batch as a no-op', () => {
    const tracker = createCommandSettlementTracker();
    tracker.record([status('a', 'pending')]);
    const before = tracker.statuses();
    tracker.record([]);
    expect(tracker.statuses()).toBe(before);
  });

  it('resolves a waiter when its command succeeds, carrying the result', async () => {
    const tracker = createCommandSettlementTracker();
    const settled = tracker.waitFor('a');
    tracker.record([status('a', 'succeeded', { result: { node: 'x' } })]);
    expect(await settled).toEqual({ result: { node: 'x' }, succeeded: true });
  });

  it('resolves a waiter as failed when its command fails', async () => {
    const tracker = createCommandSettlementTracker();
    const settled = tracker.waitFor('a');
    tracker.record([status('a', 'failed', { failure: 'browser-error' })]);
    expect(await settled).toEqual({ result: undefined, succeeded: false });
  });

  it('does not settle a waiter on a pending status', async () => {
    const tracker = createCommandSettlementTracker();
    let settledWith: unknown;
    void tracker.waitFor('a').then((outcome) => { settledWith = outcome; });
    tracker.record([status('a', 'pending')]);
    await Promise.resolve();
    expect(settledWith).toBeUndefined();
  });

  it('settles a waiter only once even if a later status repeats', async () => {
    const tracker = createCommandSettlementTracker();
    const outcomes: unknown[] = [];
    void tracker.waitFor('a').then((outcome) => outcomes.push(outcome));
    tracker.record([status('a', 'succeeded')]);
    tracker.record([status('a', 'succeeded')]);
    await Promise.resolve();
    expect(outcomes).toHaveLength(1);
  });

  it('settles a waiter at once when its command settled before it was accepted', async () => {
    const tracker = createCommandSettlementTracker();
    tracker.record([status('a', 'succeeded', { result: { node: 'x' } })]);
    expect(await tracker.waitFor('a')).toEqual({ result: { node: 'x' }, succeeded: true });
  });

  it('fails every outstanding waiter, as dropped, when the port is released', async () => {
    const tracker = createCommandSettlementTracker();
    const first = tracker.waitFor('a');
    const second = tracker.waitFor('b');
    tracker.releaseAll();
    expect(await first).toEqual({ dropped: true, succeeded: false });
    expect(await second).toEqual({ dropped: true, succeeded: false });
  });

  it('leaves a released waiter unable to settle again', async () => {
    const tracker = createCommandSettlementTracker();
    const outcomes: unknown[] = [];
    void tracker.waitFor('a').then((outcome) => outcomes.push(outcome));
    tracker.releaseAll();
    tracker.record([status('a', 'succeeded')]);
    await Promise.resolve();
    expect(outcomes).toEqual([{ dropped: true, succeeded: false }]);
  });
});
