export interface BrowserRestoreBarrierOptions {
  /** The longest held work, such as startup's matching, may hold restoring back. */
  holdTimeoutMs?: number;
  now?: () => number;
  /** How long the browser must stop creating tabs before its restore counts as done. */
  quietMs?: number;
  /** The longest one restore may hold Hyper's own restoring back. */
  timeoutMs?: number;
  wait?: (durationMs: number) => Promise<void>;
}

/**
 * Lets the browser restore its tabs before Hyper restores any of its own.
 *
 * A reopened window or a restarted browser brings tabs back in a burst. Hyper
 * waits until that burst goes quiet, and until startup has matched the restored
 * tabs to their backings, so it only restores the tabs the browser did not.
 */
export function createBrowserRestoreBarrier(options: BrowserRestoreBarrierOptions = {}) {
  const now = options.now ?? Date.now;
  const holdTimeoutMs = options.holdTimeoutMs ?? 15_000;
  const quietMs = options.quietMs ?? 500;
  const timeoutMs = options.timeoutMs ?? 5_000;
  const wait = options.wait ?? ((durationMs: number) =>
    new Promise<void>((resolve) => globalThis.setTimeout(resolve, durationMs)));
  let startedAt: number | undefined;
  let lastTabAt = 0;
  const holds = new Map<Promise<void>, number>();
  const settlesAt = () => startedAt === undefined
    ? 0
    : Math.min(lastTabAt + quietMs, startedAt + timeoutMs);

  return {
    /** A window opened or the browser reopened something, so restored tabs may follow. */
    begin() {
      const time = now();
      if (time >= settlesAt()) startedAt = time;
      lastTabAt = time;
    },
    /** Holds restoring back until `work`, such as startup's own matching, has finished. */
    hold(work: Promise<unknown>) {
      const held: Promise<void> = work.then(() => undefined, () => undefined)
        .finally(() => holds.delete(held));
      holds.set(held, now() + holdTimeoutMs);
    },
    isSettled() {
      return ![...holds.values()].some((deadline) => deadline > now()) && now() >= settlesAt();
    },
    noteTabCreated() {
      if (now() < settlesAt()) lastTabAt = now();
    },
    async settled(): Promise<void> {
      for (;;) {
        const live = [...holds].filter(([, deadline]) => deadline > now());
        if (live.length > 0) {
          const deadline = Math.max(...live.map(([, until]) => until));
          await Promise.race([Promise.all(live.map(([held]) => held)), wait(deadline - now())]);
          continue;
        }
        const remaining = settlesAt() - now();
        if (remaining <= 0) return;
        await wait(remaining);
      }
    },
  };
}

export type BrowserRestoreBarrier = ReturnType<typeof createBrowserRestoreBarrier>;
