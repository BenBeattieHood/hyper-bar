import { describe, expect, it, vi } from 'vitest';
import {
  createCoalescedAsyncRunner,
  createKeyedCoalescer,
  createKeyedSerialRunner,
  createSerialAsyncRunner,
  runConcurrentOperations,
} from './async';

describe('createCoalescedAsyncRunner', () => {
  it('collapses concurrent requests into one follow-up run', async () => {
    let releaseFirstRun: (() => void) | undefined;
    const task = vi.fn()
      .mockImplementationOnce(() => new Promise<void>((resolve) => {
        releaseFirstRun = resolve;
      }))
      .mockResolvedValue(undefined);
    const run = createCoalescedAsyncRunner(task);

    const first = run();
    const second = run();
    const third = run();

    expect(task).toHaveBeenCalledTimes(1);
    releaseFirstRun?.();
    await Promise.all([first, second, third]);
    expect(task).toHaveBeenCalledTimes(2);
  });

  it('allows a new run after a failure', async () => {
    const task = vi.fn()
      .mockRejectedValueOnce(new Error('refresh failed'))
      .mockResolvedValue(undefined);
    const run = createCoalescedAsyncRunner(task);

    await expect(run()).rejects.toThrow('refresh failed');
    await expect(run()).resolves.toBeUndefined();
    expect(task).toHaveBeenCalledTimes(2);
  });

  it('honours a request queued while the current run fails', async () => {
    let rejectFirstRun: ((error: Error) => void) | undefined;
    const task = vi.fn()
      .mockImplementationOnce(() => new Promise<void>((_resolve, reject) => {
        rejectFirstRun = reject;
      }))
      .mockResolvedValue(undefined);
    const run = createCoalescedAsyncRunner(task);

    const first = run();
    const queued = run();
    rejectFirstRun?.(new Error('refresh failed'));

    await expect(first).rejects.toThrow('refresh failed');
    await expect(queued).rejects.toThrow('refresh failed');
    expect(task).toHaveBeenCalledTimes(2);
  });

  it('schedules another run when requested during the follow-up', async () => {
    const releases: Array<() => void> = [];
    const task = vi.fn(() => new Promise<void>((resolve) => releases.push(resolve)));
    const run = createCoalescedAsyncRunner(task);

    const first = run();
    run();
    releases.shift()?.();
    await Promise.resolve();
    expect(task).toHaveBeenCalledTimes(2);

    run();
    releases.shift()?.();
    await Promise.resolve();
    expect(task).toHaveBeenCalledTimes(3);

    releases.shift()?.();
    await first;
  });
});

describe('createSerialAsyncRunner', () => {
  it('runs async operations in request order', async () => {
    let releaseFirst: (() => void) | undefined;
    const events: string[] = [];
    const run = createSerialAsyncRunner();
    const first = run(async () => {
      events.push('first:start');
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      events.push('first:end');
    });
    const second = run(async () => {
      events.push('second');
    });

    await Promise.resolve();
    expect(events).toEqual(['first:start']);
    releaseFirst?.();
    await Promise.all([first, second]);
    expect(events).toEqual(['first:start', 'first:end', 'second']);
  });

  it('continues after an operation fails', async () => {
    const run = createSerialAsyncRunner();

    await expect(run(async () => {
      throw new Error('failed');
    })).rejects.toThrow('failed');
    await expect(run(async () => 'recovered')).resolves.toBe('recovered');
  });

  it('returns each queued operation result without mixing result types', async () => {
    const run = createSerialAsyncRunner();

    const numberResult = run(async () => 42);
    const objectResult = run(async () => ({ state: 'done' as const }));

    await expect(numberResult).resolves.toBe(42);
    await expect(objectResult).resolves.toEqual({ state: 'done' });
  });
});

describe('createKeyedSerialRunner', () => {
  it('runs one key\'s operations in turn without holding up another key', async () => {
    let releaseFirst: (() => void) | undefined;
    const events: string[] = [];
    const run = createKeyedSerialRunner<string>();
    const first = run('a', () => new Promise<void>((resolve) => {
      releaseFirst = resolve;
    }).then(() => { events.push('a1'); }));
    const second = run('a', async () => { events.push('a2'); });
    await run('b', async () => { events.push('b'); });

    expect(events).toEqual(['b']);
    releaseFirst?.();
    await Promise.all([first, second]);
    expect(events).toEqual(['b', 'a1', 'a2']);
  });
});

describe('createKeyedCoalescer', () => {
  it('keeps one waiting run per key, which takes the newest value', async () => {
    let releaseBlocker: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      releaseBlocker = resolve;
    });
    const enqueue = createSerialAsyncRunner();
    const blocker = enqueue(() => blocked);
    const runs: Array<[string, number]> = [];
    const request = createKeyedCoalescer<string, number>(enqueue, async (key, value) => {
      runs.push([key, value]);
    });

    const requests = [
      request('busy', 1),
      request('busy', 2),
      request('other', 1),
      request('busy', 3),
    ];
    releaseBlocker?.();
    await Promise.all([blocker, ...requests]);

    expect(runs).toEqual([['busy', 3], ['other', 1]]);
  });

  it('queues afresh once a key’s waiting run has started', async () => {
    const runs: number[] = [];
    const request = createKeyedCoalescer<string, number>(
      createSerialAsyncRunner(),
      async (_key, value) => {
        runs.push(value);
      },
    );

    await request('tab', 1);
    await request('tab', 2);

    expect(runs).toEqual([1, 2]);
  });

  it('waits out the interval since a key last ran, folding requests meanwhile', async () => {
    vi.useFakeTimers();
    try {
      const runs: number[] = [];
      const request = createKeyedCoalescer<string, number>(
        createSerialAsyncRunner(),
        async (_key, value) => {
          runs.push(value);
        },
        { merge: (waiting, next) => waiting + next, minIntervalMs: 1_000 },
      );

      await request('tab', 1);
      const later = request('tab', 2);
      void request('tab', 3);
      await request('other', 7);
      await vi.advanceTimersByTimeAsync(999);
      expect(runs).toEqual([1, 7]);

      await vi.advanceTimersByTimeAsync(1);
      await later;
      expect(runs).toEqual([1, 7, 5]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('runConcurrentOperations', () => {
  it('starts every operation before waiting for completion', async () => {
    const releases: Array<() => void> = [];
    const operation = vi.fn(() => new Promise<void>((resolve) => {
      releases.push(resolve);
    }));

    const running = runConcurrentOperations(
      [1, 2, 3],
      operation,
      'Concurrent operations failed.',
    );
    await vi.waitFor(() => expect(operation).toHaveBeenCalledTimes(3));

    for (const release of releases) release();
    await expect(running).resolves.toBeUndefined();
  });

  it('waits for every operation and aggregates failures', async () => {
    let releaseLastOperation: (() => void) | undefined;
    const firstFailure = new Error('first failed');
    const secondFailure = new Error('second failed');
    const operation = vi.fn((item: number) => {
      if (item === 1) return Promise.reject(firstFailure);
      if (item === 2) return Promise.reject(secondFailure);
      return new Promise<void>((resolve) => {
        releaseLastOperation = resolve;
      });
    });

    const running = runConcurrentOperations(
      [1, 2, 3],
      operation,
      'Concurrent operations failed.',
    );
    let settled = false;
    void running.catch(() => undefined).then(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(operation).toHaveBeenCalledTimes(3));
    expect(settled).toBe(false);

    releaseLastOperation?.();
    const error = await running.catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([firstFailure, secondFailure]);
  });
});