import type {
  CommandSettlementOutcome,
  CommandStatus,
  CommandStatusTable,
} from '../../lib/modelActions';

/**
 * Coordinates command settlement for the sidebar facade. It accumulates the
 * statuses the model reports and resolves the waiters a caller registered when
 * it asked to be told an intent had settled.
 *
 * It holds no React or browser state, so the settlement rules — a pending status
 * never settles a waiter, a waiter settles at most once, and a dropped port
 * fails every outstanding one — can be tested without a rendered hook. The
 * accumulated table is what the overlay layer reads to retire an optimistic edit
 * against the command that carries it, so it is exposed rather than hidden.
 *
 * A waiter is taken only once its intent is accepted. Until then the command is
 * not in the model, and the client may still send it on a later connection, so a
 * drop before acceptance has nothing of it to settle.
 */
export interface CommandSettlementTracker {
  /** The accumulated status table, for laying overlays over the projection. */
  statuses(): CommandStatusTable;
  /**
   * Waits for an accepted command to settle. Its terminal status can be reported
   * before its acceptance, so one already recorded settles the waiter at once.
   */
  waitFor(commandId: string): Promise<CommandSettlementOutcome>;
  /** Merges reported statuses and settles every waiter they resolve. */
  record(statuses: readonly CommandStatus[]): void;
  /** Fails every outstanding waiter, because a dropped port settles nothing. */
  releaseAll(): void;
}

const settlementOf = (status: CommandStatus): CommandSettlementOutcome =>
  ({ result: status.result, succeeded: status.phase === 'succeeded' });

export function createCommandSettlementTracker(): CommandSettlementTracker {
  let table: CommandStatusTable = {};
  const waiters = new Map<string, (outcome: CommandSettlementOutcome) => void>();
  return {
    statuses: () => table,
    waitFor(commandId) {
      const known = table[commandId];
      if (known && known.phase !== 'pending') return Promise.resolve(settlementOf(known));
      return new Promise<CommandSettlementOutcome>((resolve) => {
        waiters.set(commandId, resolve);
      });
    },
    record(statuses) {
      if (statuses.length === 0) return;
      table = {
        ...table,
        ...Object.fromEntries(statuses.map((status) => [status.commandId, status])),
      };
      for (const status of statuses) {
        if (status.phase === 'pending') continue;
        const settle = waiters.get(status.commandId);
        if (!settle) continue;
        waiters.delete(status.commandId);
        settle(settlementOf(status));
      }
    },
    releaseAll() {
      for (const settle of [...waiters.values()]) settle({ dropped: true, succeeded: false });
      waiters.clear();
    },
  };
}
