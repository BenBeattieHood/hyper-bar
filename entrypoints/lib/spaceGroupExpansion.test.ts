import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSpaceGroupExpansion } from './spaceGroupExpansion';

const WINDOW_ID = 1;

function setup(options: { switching?: boolean; startup?: boolean } = {}) {
  const groups = new Map<number, { collapsed: boolean; id: number; windowId: number }>();
  vi.stubGlobal('browser', {
    tabGroups: { get: vi.fn(async (groupId: number) => groups.get(groupId)) },
  });
  const queued: Array<() => Promise<void>> = [];
  const activateSpaceGroup = vi.fn(async () => undefined);
  const expansion = createSpaceGroupExpansion({
    activateSpaceGroup,
    activationTokens: new Map([[WINDOW_ID, 'token']]),
    isSwitching: () => options.switching ?? false,
    maxTrackedGroups: 16,
    queueActivation: (operation) => queued.push(operation),
    startupRecoveryInProgress: () => options.startup ?? false,
  });
  const runQueued = async () => {
    vi.useFakeTimers();
    const runs = queued.splice(0).map((operation) => operation());
    await vi.advanceTimersByTimeAsync(50);
    await Promise.all(runs);
    vi.useRealTimers();
  };
  return { activateSpaceGroup, expansion, groups, queued, runQueued };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('createSpaceGroupExpansion', () => {
  it('activates the space of a group the user expands', async () => {
    const { activateSpaceGroup, expansion, groups, runQueued } = setup();
    const group = { collapsed: false, id: 7, windowId: WINDOW_ID };
    groups.set(7, group);
    expansion.groupUpdated(group);
    await runQueued();
    expect(activateSpaceGroup).toHaveBeenCalledWith(group);
  });

  it('ignores the expansion Hyper makes itself', async () => {
    const { expansion, queued } = setup();
    expansion.beginProgrammaticGroupUpdate(7);
    expansion.groupUpdated({ collapsed: false, id: 7, windowId: WINDOW_ID });
    await expansion.endProgrammaticGroupUpdate(7);
    expect(queued).toHaveLength(0);
    // The programmatic update ended with its expansion, so the next one is the user's.
    expansion.groupUpdated({ collapsed: false, id: 7, windowId: WINDOW_ID });
    expect(queued).toHaveLength(1);
  });

  it('leaves a group that collapsed again before the activation ran', async () => {
    const { activateSpaceGroup, expansion, groups, runQueued } = setup();
    groups.set(7, { collapsed: true, id: 7, windowId: WINDOW_ID });
    expansion.groupUpdated({ collapsed: false, id: 7, windowId: WINDOW_ID });
    await runQueued();
    expect(activateSpaceGroup).not.toHaveBeenCalled();
  });

  it('defers to a space switch or startup recovery in progress', () => {
    for (const options of [{ switching: true }, { startup: true }]) {
      const { expansion, queued } = setup(options);
      expansion.groupUpdated({ collapsed: false, id: 7, windowId: WINDOW_ID });
      expect(queued).toHaveLength(0);
    }
  });
});
