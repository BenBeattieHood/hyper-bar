import { describe, expect, it, vi } from 'vitest';
import {
  createHyperModelStore,
  emptyBrowserObservation,
  emptyRuntimeMetadata,
  hyperModelAtom,
  setCommandStatusesAtom,
} from './model';
import {
  createHyperModelReconciler,
  FAILED_READ_RETRY_MS,
  MAX_STABLE_READ_ATTEMPTS,
  READ_BURST,
  READS_PER_SECOND,
} from './modelReconciler';

const noWait = async () => undefined;
const sourcesFocusing = (focusedWindowId: number | null) => ({
  browser: { ...emptyBrowserObservation, focusedWindowId },
  runtime: emptyRuntimeMetadata,
});

describe('Hyper model reconciler', () => {
  it('discards a source read made stale by a later observation', async () => {
    let releaseFirstRead: (() => void) | undefined;
    let sourceReads = 0;
    const firstRead = new Promise<void>((resolve) => {
      releaseFirstRead = resolve;
    });
    const reconciler = createHyperModelReconciler(createHyperModelStore(), {
      readSources: async () => {
        sourceReads += 1;
        if (sourceReads === 1) await firstRead;
        return sourcesFocusing(sourceReads);
      },
    }, noWait);

    const firstRequest = reconciler.scheduleReconciliation();
    await Promise.resolve();
    const secondRequest = reconciler.scheduleReconciliation();
    releaseFirstRead?.();

    const [firstSnapshot, secondSnapshot] = await Promise.all([
      firstRequest,
      secondRequest,
    ]);

    expect(sourceReads).toBe(2);
    expect(firstSnapshot).toMatchObject({
      revision: 1,
      browser: { focusedWindowId: 2 },
    });
    expect(secondSnapshot).toBe(firstSnapshot);
  });

  it('commits a bounded-attempt snapshot when observations never settle', async () => {
    let sourceReads = 0;
    const reconciler = createHyperModelReconciler(createHyperModelStore(), {
      readSources: async () => {
        sourceReads += 1;
        const reads = sourceReads;
        await Promise.resolve();
        // Every attempt of the first reconciliation is invalidated mid-read.
        if (reads < MAX_STABLE_READ_ATTEMPTS) {
          void reconciler.scheduleReconciliation().catch(() => undefined);
        }
        return sourcesFocusing(reads);
      },
    }, noWait);

    const snapshot = await reconciler.reconcile();

    expect(sourceReads).toBe(MAX_STABLE_READ_ATTEMPTS);
    expect(snapshot).toMatchObject({
      revision: 1,
      browser: { focusedWindowId: MAX_STABLE_READ_ATTEMPTS },
    });
  });

  it('reads a burst at once, then holds a nonstop stream to its read rate', async () => {
    vi.useFakeTimers();
    try {
      const streamReads = READ_BURST + 10;
      let sourceReads = 0;
      const waits: number[] = [];
      const reconciler = createHyperModelReconciler(createHyperModelStore(), {
        readSources: async () => {
          sourceReads += 1;
          const read = sourceReads;
          await Promise.resolve();
          if (read < streamReads) void reconciler.scheduleReconciliation().catch(() => undefined);
          return sourcesFocusing(read);
        },
      }, async (durationMs) => {
        waits.push(durationMs);
        vi.advanceTimersByTime(durationMs);
      });

      void reconciler.reconcile();
      for (let turn = 0; turn < 5_000 && sourceReads < streamReads; turn += 1) {
        await Promise.resolve();
      }

      expect(sourceReads).toBe(streamReads);
      expect(waits).toEqual(Array.from({ length: 10 }, () => 1_000 / READS_PER_SECOND));
    } finally {
      vi.useRealTimers();
    }
  });

  const storeWithPendingCommand = () => {
    const store = createHyperModelStore();
    store.set(setCommandStatusesAtom, {
      command: {
        clientId: 'client-1',
        commandId: 'command',
        kind: 'closeTabs',
        phase: 'pending',
        startedRevision: 0,
        targets: [],
      },
    });
    return store;
  };

  it('commits a settlement with the first read begun after it, however stale', async () => {
    let sourceReads = 0;
    const reconciler = createHyperModelReconciler(storeWithPendingCommand(), {
      readSources: async () => {
        sourceReads += 1;
        const read = sourceReads;
        await Promise.resolve();
        if (read <= MAX_STABLE_READ_ATTEMPTS) {
          void reconciler.scheduleReconciliation().catch(() => undefined);
        }
        return sourcesFocusing(read);
      },
    }, noWait);

    const committed = await reconciler.settleOnCommit({
      commandId: 'command',
      phase: 'succeeded',
    });

    expect(committed.browser.focusedWindowId).toBe(1);
    expect(committed.commands.command).toMatchObject({
      phase: 'succeeded',
      settledRevision: 2,
    });
  });

  it('keeps a command awaiting proof when a busy browser forces a stale commit', async () => {
    let sourceReads = 0;
    let lastAttemptStarted: (() => void) | undefined;
    let releaseLastAttempt: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      lastAttemptStarted = resolve;
    });
    const released = new Promise<void>((resolve) => {
      releaseLastAttempt = resolve;
    });
    const store = storeWithPendingCommand();
    const reconciler = createHyperModelReconciler(store, {
      readSources: async () => {
        sourceReads += 1;
        const read = sourceReads;
        await Promise.resolve();
        if (read < MAX_STABLE_READ_ATTEMPTS) {
          void reconciler.scheduleReconciliation().catch(() => undefined);
        } else if (read === MAX_STABLE_READ_ATTEMPTS) {
          lastAttemptStarted?.();
          await released;
        }
        return sourcesFocusing(read);
      },
    }, noWait);

    const fallback = reconciler.reconcile();
    await started;
    const settlement = reconciler.settleOnCommit({ commandId: 'command', phase: 'succeeded' });
    releaseLastAttempt?.();

    expect((await fallback).commands.command?.phase).toBe('pending');
    expect((await settlement).commands.command).toMatchObject({
      phase: 'succeeded',
      settledRevision: 3,
    });
    expect(store.get(hyperModelAtom).commands.command?.phase).toBe('succeeded');
  });

  it('keeps a successful effect pending while a failed proof read retries', async () => {
    vi.useFakeTimers();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      let reads = 0;
      const store = storeWithPendingCommand();
      const reconciler = createHyperModelReconciler(store, {
        readSources: async () => {
          reads += 1;
          if (reads === 1) throw new Error('Temporary browser read failure.');
          return sourcesFocusing(null);
        },
      }, noWait);

      const settlement = reconciler.settleOnCommit({
        commandId: 'command',
        phase: 'succeeded',
      });
      await vi.advanceTimersByTimeAsync(FAILED_READ_RETRY_MS);

      expect((await settlement).commands.command).toMatchObject({
        phase: 'succeeded',
        settledRevision: 2,
      });
      expect(reads).toBe(2);
      expect(error).toHaveBeenCalledOnce();
    } finally {
      error.mockRestore();
      vi.useRealTimers();
    }
  });

  it('retries a failed read on a timer so queued work is not stranded', async () => {
    vi.useFakeTimers();
    try {
      let sourceReads = 0;
      const reconciler = createHyperModelReconciler(createHyperModelStore(), {
        readSources: async () => {
          sourceReads += 1;
          if (sourceReads === 1) throw new Error('The browser read failed.');
          return sourcesFocusing(sourceReads);
        },
      }, noWait);

      await expect(reconciler.reconcile()).rejects.toThrow('The browser read failed.');
      expect(sourceReads).toBe(1);

      await vi.advanceTimersByTimeAsync(FAILED_READ_RETRY_MS);

      expect(sourceReads).toBe(2);
      expect(reconciler.getObservationGeneration()).toBeGreaterThan(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a failing read to one retry at a time', async () => {
    vi.useFakeTimers();
    try {
      let sourceReads = 0;
      const reconciler = createHyperModelReconciler(createHyperModelStore(), {
        readSources: async () => {
          sourceReads += 1;
          throw new Error('The browser read failed.');
        },
      }, noWait);

      await expect(reconciler.reconcile()).rejects.toThrow('The browser read failed.');
      await expect(reconciler.reconcile()).rejects.toThrow('The browser read failed.');
      const readsBeforeRetry = sourceReads;

      await vi.advanceTimersByTimeAsync(FAILED_READ_RETRY_MS);

      expect(sourceReads).toBe(readsBeforeRetry + 1);
    } finally {
      vi.useRealTimers();
    }
  });
});