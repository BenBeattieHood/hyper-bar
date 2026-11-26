import {
  commitHyperModelAtom,
  type CommandSettlement,
  type HyperModelSnapshot,
  type HyperModelSources,
  type HyperModelStore,
} from './model';

export interface HyperModelSourcesReader {
  readSources(): Promise<HyperModelSources>;
}

export interface HyperModelReconciler {
  getObservationGeneration(): number;
  reconcile(): Promise<HyperModelSnapshot>;
  scheduleReconciliation(): Promise<HyperModelSnapshot>;
  /**
   * Queues a terminal outcome for the next commit so a view never sees a
   * command succeed against a revision that does not yet contain its effect.
   */
  settleOnCommit(settlement: CommandSettlement): Promise<HyperModelSnapshot>;
}

/**
 * A sustained event storm can invalidate every read, so stability is attempted
 * only a bounded number of times before a slightly stale snapshot is committed.
 * A terminal command status commits with the first read begun after it was
 * queued: that read already holds its effect, even when later events leave it
 * stale, so a busy browser cannot keep a finished command pending.
 */
export const MAX_STABLE_READ_ATTEMPTS = 8;

/**
 * Reads draw on an allowance that refills at `READS_PER_SECOND` up to
 * `READ_BURST`, so a burst of events is read at once, but a page firing events
 * nonstop slows reading down instead of turning it into a busy loop against
 * the browser; events meanwhile fold into the next read.
 */
export const READ_BURST = 20;
export const READS_PER_SECOND = 20;

/**
 * How long a failed read waits before it is tried again. Queued settlements and
 * the whole model stay stale until a read succeeds, and a quiet browser may
 * never produce another event, so recovery cannot wait for one.
 */
export const FAILED_READ_RETRY_MS = 1_000;

/**
 * Browser events are evidence that a read may already be stale. A generation is
 * captured before each read, so an event during that read forces a fresh read
 * before Jotai receives the next atomic snapshot.
 */
export function createHyperModelReconciler(
  store: HyperModelStore,
  reader: HyperModelSourcesReader,
  wait: (durationMs: number) => Promise<void> = (durationMs) =>
    new Promise((resolve) => setTimeout(resolve, durationMs)),
): HyperModelReconciler {
  let committedGeneration = 0;
  let observationGeneration = 0;
  let pending: Promise<HyperModelSnapshot> | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let readAllowance = READ_BURST;
  let allowanceRefilledAt = Date.now();
  // Each resolves only when the first read begun after it commits its proof.
  let settlements: Array<{
    generation: number;
    resolve(snapshot: HyperModelSnapshot): void;
    settlement: CommandSettlement;
  }> = [];

  const refillReadAllowance = () => {
    const now = Date.now();
    readAllowance = Math.min(
      READ_BURST,
      readAllowance + ((now - allowanceRefilledAt) * READS_PER_SECOND) / 1_000,
    );
    allowanceRefilledAt = now;
  };
  const awaitReadAllowance = async () => {
    refillReadAllowance();
    if (readAllowance < 1) {
      await wait(((1 - readAllowance) * 1_000) / READS_PER_SECOND);
      refillReadAllowance();
    }
    readAllowance -= 1;
  };

  const retryAfterFailedRead = () => {
    if (retryTimer !== undefined) return;
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      void scheduleReconciliation().catch(() => undefined);
    }, FAILED_READ_RETRY_MS);
  };

  const reconcileUntilStable = async (): Promise<HyperModelSnapshot> => {
    for (let attempt = 1; ; attempt += 1) {
      await awaitReadAllowance();
      const readGeneration = observationGeneration;
      const sources = await reader.readSources();
      const settle = settlements.filter(({ generation }) => generation <= readGeneration);
      if (
        readGeneration !== observationGeneration &&
        attempt < MAX_STABLE_READ_ATTEMPTS &&
        settle.length === 0
      ) continue;

      const snapshot = store.set(commitHyperModelAtom, {
        settle: settle.map(({ settlement }) => settlement),
        sources,
      });
      settlements = settlements.filter(({ generation }) => generation > readGeneration);
      committedGeneration = readGeneration;
      for (const { resolve } of settle) resolve(snapshot);
      return snapshot;
    }
  };

  const scheduleReconciliation = (): Promise<HyperModelSnapshot> => {
    observationGeneration += 1;
    if (!pending) {
      // Retrying on a timer rather than chaining keeps a persistently failing
      // read from spinning while still guaranteeing the model catches up.
      pending = reconcileUntilStable().then(
        (snapshot) => {
          pending = undefined;
          if (committedGeneration !== observationGeneration) {
            void scheduleReconciliation().catch(() => undefined);
          }
          return snapshot;
        },
        (error: unknown) => {
          pending = undefined;
          retryAfterFailedRead();
          throw error;
        },
      );
    }
    return pending;
  };

  return {
    getObservationGeneration: () => observationGeneration,
    reconcile: scheduleReconciliation,
    scheduleReconciliation,
    settleOnCommit: (settlement) => new Promise<HyperModelSnapshot>((resolve) => {
      settlements.push({ generation: observationGeneration + 1, resolve, settlement });
      void scheduleReconciliation().catch((error) => {
        console.error('Unable to settle a Hyper command; retrying the model read.', error);
      });
    }),
  };
}