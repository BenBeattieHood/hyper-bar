import { describe, expect, it } from 'vitest';
import type { CommandStatus, CommandStatusTable } from './modelActions';
import { createOverlayStore, MAX_PENDING_OVERLAYS } from './modelOverlay';

interface Titles {
  titles: readonly string[];
}

function status(commandId: string, phase: CommandStatus['phase']): CommandStatus {
  return {
    clientId: 'client-1',
    commandId,
    kind: 'renameBookmark',
    phase,
    startedRevision: 1,
    targets: [],
  };
}

function table(...statuses: CommandStatus[]): CommandStatusTable {
  return Object.fromEntries(statuses.map((entry) => [entry.commandId, entry]));
}

const append = (title: string) => (projection: Titles): Titles => ({
  titles: [...projection.titles, title],
});

describe('createOverlayStore', () => {
  it('shows a pending edit over the committed projection', () => {
    const store = createOverlayStore<Titles>();
    store.add('a', append('draft'));

    expect(store.project({ titles: ['committed'] }, table(status('a', 'pending'))))
      .toEqual({ titles: ['committed', 'draft'] });
  });

  it('retires an edit in the same pass that sees its command succeed', () => {
    const store = createOverlayStore<Titles>();
    store.add('a', append('draft'));

    // The commit that settles the command is the one that proves the effect, so
    // dropping the edit against it cannot flicker back to the pre-edit value.
    expect(store.project({ titles: ['committed'] }, table(status('a', 'succeeded'))))
      .toEqual({ titles: ['committed'] });
    expect(store.pendingCommandIds()).toEqual([]);
  });

  it('retires an edit whose command failed', () => {
    const store = createOverlayStore<Titles>();
    store.add('a', append('draft'));

    expect(store.project({ titles: ['committed'] }, table(status('a', 'failed'))))
      .toEqual({ titles: ['committed'] });
  });

  it('stacks edits in the order they were made', () => {
    const store = createOverlayStore<Titles>();
    store.add('a', append('first'));
    store.add('b', append('second'));

    expect(store.project({ titles: [] }, table(
      status('a', 'pending'),
      status('b', 'pending'),
    ))).toEqual({ titles: ['first', 'second'] });
  });

  it('keeps a surviving edit when an earlier one settles', () => {
    const store = createOverlayStore<Titles>();
    store.add('a', append('settled'));
    store.add('b', append('still pending'));

    expect(store.project({ titles: [] }, table(
      status('a', 'succeeded'),
      status('b', 'pending'),
    ))).toEqual({ titles: ['still pending'] });
  });

  it('holds an edit the background has not acknowledged yet', () => {
    const store = createOverlayStore<Titles>();
    store.add('a', append('draft'));

    // The command cannot be in a status table it has not reached yet, so its
    // absence is not evidence that the edit will never happen.
    expect(store.project({ titles: [] }, {})).toEqual({ titles: ['draft'] });
  });

  it('retires an admitted edit once its command has left the status table', () => {
    const store = createOverlayStore<Titles>();
    store.add('a', append('draft'));
    store.admit('a');

    // Admitted and now absent means settled and pruned; the tree underneath
    // already carries whatever happened.
    expect(store.project({ titles: [] }, {})).toEqual({ titles: [] });
  });

  it('abandons every admitted edit when the port drops, leaving the ones still to be sent', () => {
    const store = createOverlayStore<Titles>();
    store.add('a', append('sent'));
    store.admit('a');
    store.add('b', append('unsent'));
    store.discardPendingCommands();

    // The model is the only account left of an admitted command when the port
    // drops, while an unadmitted intent still reports its own fate.
    expect(store.project({ titles: [] }, {})).toEqual({ titles: ['unsent'] });
    expect(store.pendingCommandIds()).toEqual(['b']);
  });

  it('discards an edit whose intent was rejected outright', () => {
    const store = createOverlayStore<Titles>();
    store.add('a', append('draft'));
    store.discard('a');

    expect(store.project({ titles: [] }, {})).toEqual({ titles: [] });
  });

  it('bounds how many edits a view can accumulate', () => {
    const store = createOverlayStore<Titles>();
    for (let index = 0; index <= MAX_PENDING_OVERLAYS; index += 1) {
      store.add(`command-${index}`, append(`edit-${index}`));
    }

    expect(store.pendingCommandIds()).toHaveLength(MAX_PENDING_OVERLAYS);
    expect(store.pendingCommandIds()[0]).toBe('command-1');
  });
});
