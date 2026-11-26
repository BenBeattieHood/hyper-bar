export function createCoalescedAsyncRunner(
  task: () => Promise<void>,
): () => Promise<void> {
  let inFlight: Promise<void> | undefined;
  let rerunRequested = false;

  return () => {
    if (inFlight) {
      rerunRequested = true;
      return inFlight;
    }

    inFlight = (async () => {
      let firstError: unknown;
      do {
        rerunRequested = false;
        try {
          await task();
        } catch (error) {
          firstError ??= error;
        }
      } while (rerunRequested);
      if (firstError !== undefined) throw firstError;
    })().finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  };
}

/**
 * Runs each key's tasks one at a time, each after that key's previous one
 * settles; a failure is handed to the caller and to `onError`, and never holds
 * up the tasks behind it.
 */
export function createKeyedSerialRunner<Key>(
  onError: (error: unknown) => void = () => undefined,
): <T>(key: Key, task: () => Promise<T>) => Promise<T> {
  const tails = new Map<Key, Promise<void>>();

  return <T>(key: Key, task: () => Promise<T>): Promise<T> => {
    const result = (tails.get(key) ?? Promise.resolve()).then(task, task);
    const tail = result.then(() => undefined, onError);
    tails.set(key, tail);
    const forget = () => {
      if (tails.get(key) === tail) tails.delete(key);
    };
    void tail.then(forget, forget);
    return result;
  };
}

/** A keyed serial runner with a single key. */
export function createSerialAsyncRunner(
  onError?: (error: unknown) => void,
): <T>(task: () => Promise<T>) => Promise<T> {
  const run = createKeyedSerialRunner<undefined>(onError);
  return (task) => run(undefined, task);
}

/**
 * Keeps at most one run per key waiting in `enqueue`: a request for a key that
 * is already waiting hands that run its newer value instead of queueing again,
 * and a key run recently waits out `minIntervalMs` first, so a source firing
 * constantly can neither flood a queue other work waits in nor keep it busy.
 */
export function createKeyedCoalescer<Key, Value>(
  enqueue: (operation: () => Promise<void>) => Promise<void>,
  run: (key: Key, value: Value) => Promise<void>,
  options: {
    /** Folds a newer request into the waiting one; by default the newer replaces it. */
    merge?: (waiting: Value, next: Value) => Value;
    minIntervalMs?: number;
  } = {},
): (key: Key, value: Value) => Promise<void> {
  const { merge = (_waiting: Value, next: Value) => next, minIntervalMs = 0 } = options;
  const waiting = new Map<Key, { result: Promise<void>; value: Value }>();
  const lastStarts = new Map<Key, number>();
  return (key, value) => {
    const entry = waiting.get(key);
    if (entry) {
      entry.value = merge(entry.value, value);
      return entry.result;
    }
    const next = { result: Promise.resolve(), value };
    waiting.set(key, next);
    const start = () => enqueue(() => {
      waiting.delete(key);
      if (minIntervalMs > 0) {
        const startedAt = Date.now();
        lastStarts.set(key, startedAt);
        setTimeout(() => {
          if (lastStarts.get(key) === startedAt) lastStarts.delete(key);
        }, minIntervalMs);
      }
      return run(key, next.value);
    });
    const delayMs = (lastStarts.get(key) ?? -Infinity) + minIntervalMs - Date.now();
    next.result = delayMs > 0
      ? new Promise<void>((resolve) => setTimeout(resolve, delayMs)).then(start)
      : start();
    return next.result;
  };
}

/** Runs `operation` on every item at once and, once all settle, gives the reasons those that failed threw. */
export async function concurrentFailures<T>(
  items: readonly T[],
  operation: (item: T) => Promise<unknown>,
): Promise<unknown[]> {
  const results = await Promise.allSettled(items.map(operation));
  return results.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
}

export async function runConcurrentOperations<T>(
  items: readonly T[],
  operation: (item: T) => Promise<void>,
  failureMessage: string,
): Promise<void> {
  const failures = await concurrentFailures(items, operation);
  if (failures.length > 0) throw new AggregateError(failures, failureMessage);
}

export function withNamedAsyncLock<T>(
  name: string,
  task: () => Promise<T>,
): Promise<T> {
  const locks = globalThis.navigator?.locks;
  if (!locks) return task();
  return new Promise<T>((resolve, reject) => {
    void locks.request(name, async () => {
      try {
        resolve(await task());
      } catch (error) {
        reject(error);
      }
    }).catch(reject);
  });
}
/** `task`, calling `after` each time a run of it resolves. */
export function followedBy<Args extends unknown[]>(
  task: (...args: Args) => Promise<unknown>,
  after: () => void,
): (...args: Args) => Promise<void> {
  return async (...args) => {
    await task(...args);
    after();
  };
}
