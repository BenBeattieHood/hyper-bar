import { describe, expect, it } from 'vitest';
import { createBrowserRestoreBarrier } from './browserRestore';

function harness() {
  let time = 1_000;
  const waits: number[] = [];
  const barrier = createBrowserRestoreBarrier({
    now: () => time,
    quietMs: 500,
    timeoutMs: 5_000,
    wait: async (durationMs) => {
      waits.push(durationMs);
      time += durationMs;
    },
  });
  return {
    advance: (durationMs: number) => { time += durationMs; },
    barrier,
    waits,
  };
}

describe('browser restore barrier', () => {
  it('does not hold restoring back while the browser is not restoring', async () => {
    const { barrier, waits } = harness();
    barrier.noteTabCreated();

    await barrier.settled();

    expect(waits).toEqual([]);
  });

  it('waits until the browser stops creating tabs', async () => {
    const { advance, barrier, waits } = harness();
    barrier.begin();
    advance(300);
    barrier.noteTabCreated();
    expect(barrier.isSettled()).toBe(false);

    await barrier.settled();

    expect(waits).toEqual([500]);
    expect(barrier.isSettled()).toBe(true);
  });

  it('stops waiting at the timeout however long the browser keeps creating tabs', async () => {
    const { advance, barrier, waits } = harness();
    barrier.begin();
    for (let step = 0; step < 20; step += 1) {
      advance(400);
      barrier.noteTabCreated();
    }

    await barrier.settled();

    expect(waits).toEqual([]);
  });

  it('waits for held work such as startup matching', async () => {
    const { barrier } = harness();
    let finish = () => {};
    const work = new Promise<void>((resolve) => { finish = resolve; });
    barrier.hold(work);
    let settled = false;
    const waiting = barrier.settled().then(() => { settled = true; });

    await Promise.resolve();
    expect(settled).toBe(false);
    finish();
    await waiting;

    expect(settled).toBe(true);
  });

  it('is not held back by work that fails', async () => {
    const { barrier } = harness();
    barrier.hold(Promise.reject(new Error('startup failed')));

    await expect(barrier.settled()).resolves.toBeUndefined();
  });

  it('stops waiting for held work that never finishes', async () => {
    const { barrier } = harness();
    barrier.hold(new Promise(() => {}));

    await expect(barrier.settled()).resolves.toBeUndefined();
  });
});
