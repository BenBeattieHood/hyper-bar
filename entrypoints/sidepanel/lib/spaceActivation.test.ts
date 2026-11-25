import { describe, expect, it } from 'vitest';
import { createSerialAsyncRunner } from '../../lib/async';
import { createLatestSpaceSelector } from './spaceActivation';

function latestSelector(outcomes: Record<string, boolean> = {}) {
  const deletingSpaceRef = { current: false };
  const pendingActiveSpaceIdRef = { current: null as string | null };
  const spaceActivationVersion = { current: 0 };
  const submitted: string[] = [];
  let reprojects = 0;
  const select = createLatestSpaceSelector({
    deletingSpaceRef,
    pendingActiveSpaceIdRef,
    reproject: () => { reprojects += 1; },
    runSpaceActivation: createSerialAsyncRunner(),
    spaceActivationVersion,
    admitSpaceSelection: async (spaceId) => {
      submitted.push(spaceId);
      return { settled: Promise.resolve(outcomes[spaceId] ?? true) };
    },
  });
  return {
    deletingSpaceRef,
    pendingActiveSpaceIdRef,
    reprojects: () => reprojects,
    select,
    submitted,
  };
}

describe('createLatestSpaceSelector', () => {
  it('only submits the most recent selection queued behind focus work', async () => {
    const selection = latestSelector();

    const first = selection.select('space-1');
    const second = selection.select('space-2');

    await expect(first).resolves.toBe(false);
    await expect(second).resolves.toBe(true);
    expect(selection.submitted).toEqual(['space-2']);
  });

  it('hands the active space back to the model once the selection settles', async () => {
    let settle!: (succeeded: boolean) => void;
    const pendingActiveSpaceIdRef = { current: null as string | null };
    const select = createLatestSpaceSelector({
      admitSpaceSelection: async () => ({ settled: new Promise<boolean>((resolve) => { settle = resolve; }) }),
      deletingSpaceRef: { current: false },
      pendingActiveSpaceIdRef,
      reproject: () => undefined,
      runSpaceActivation: createSerialAsyncRunner(),
      spaceActivationVersion: { current: 0 },
    });

    const selected = select('space-1');
    await Promise.resolve();
    expect(pendingActiveSpaceIdRef.current).toBe('space-1');
    settle(true);

    await expect(selected).resolves.toBe(true);
    expect(pendingActiveSpaceIdRef.current).toBeNull();
  });

  it('removes a failed selection from the temporary view projection', async () => {
    const selection = latestSelector({ 'space-1': false });

    await expect(selection.select('space-1')).resolves.toBe(false);

    expect(selection.pendingActiveSpaceIdRef.current).toBeNull();
    expect(selection.reprojects()).toBe(2);
  });

  it('does not select while a space deletion is in progress', async () => {
    const selection = latestSelector();
    selection.deletingSpaceRef.current = true;

    await expect(selection.select('space-1')).rejects.toThrow(
      'Wait for the current space deletion to finish.',
    );
    expect(selection.submitted).toEqual([]);
  });
});
