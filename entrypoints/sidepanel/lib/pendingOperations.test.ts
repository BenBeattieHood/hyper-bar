import { describe, expect, it } from 'vitest';
import { createPendingOperationGauge } from './pendingOperations';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, reject, resolve };
}

describe('createPendingOperationGauge', () => {
  it('reports one in flight while an operation runs, then zero', async () => {
    const changes: number[] = [];
    const gauge = createPendingOperationGauge((count) => changes.push(count));
    const gate = deferred();
    const running = gauge.track(() => gate.promise);
    expect(gauge.count()).toBe(1);
    gate.resolve();
    await running;
    expect(gauge.count()).toBe(0);
    expect(changes).toEqual([1, 0]);
  });

  it('returns the operation result', async () => {
    const gauge = createPendingOperationGauge(() => undefined);
    await expect(gauge.track(() => Promise.resolve('ok'))).resolves.toBe('ok');
  });

  it('accumulates concurrent operations and drains them independently', async () => {
    const changes: number[] = [];
    const gauge = createPendingOperationGauge((count) => changes.push(count));
    const first = deferred();
    const second = deferred();
    const a = gauge.track(() => first.promise);
    const b = gauge.track(() => second.promise);
    expect(gauge.count()).toBe(2);
    first.resolve();
    await a;
    expect(gauge.count()).toBe(1);
    second.resolve();
    await b;
    expect(gauge.count()).toBe(0);
    expect(changes).toEqual([1, 2, 1, 0]);
  });

  it('clears the slot and re-throws when an operation fails', async () => {
    const changes: number[] = [];
    const gauge = createPendingOperationGauge((count) => changes.push(count));
    await expect(gauge.track(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(gauge.count()).toBe(0);
    expect(changes).toEqual([1, 0]);
  });
});
