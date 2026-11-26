import { describe, expect, it } from 'vitest';
import {
  createEffectFence,
  createTargetLedger,
  runGuardedEffectPlan,
  SupersededTargetError,
  tabTarget,
  windowTarget,
  type GuardedEffectStep,
} from './modelGuards';

describe('target generation ledger', () => {
  it('does not supersede a plan with the evidence that plan produced', () => {
    const ledger = createTargetLedger();
    const fence = ledger.fence([tabTarget(1)]);
    ledger.expect('command-1', tabTarget(1), 'moved');
    expect(ledger.observe(tabTarget(1), 'moved')).toBe('expected');
    expect(ledger.supersededTarget(fence)).toBeUndefined();
  });

  it('supersedes a plan when the same change arrives a second time', () => {
    const ledger = createTargetLedger();
    const fence = ledger.fence([tabTarget(1)]);
    ledger.expect('command-1', tabTarget(1), 'moved');
    ledger.observe(tabTarget(1), 'moved');
    expect(ledger.observe(tabTarget(1), 'moved')).toBe('external');
    expect(ledger.supersededTarget(fence)).toBe(tabTarget(1));
  });

  it('forgets the expectations of a command that never produced them', () => {
    const ledger = createTargetLedger();
    ledger.expect('command-1', tabTarget(1), 'removed');
    ledger.forget('command-1');
    expect(ledger.observe(tabTarget(1), 'removed')).toBe('external');
  });
});

describe('guarded effect plans', () => {
  function recordingStep(label: string, log: string[]): GuardedEffectStep {
    return {
      label,
      run: async () => {
        log.push(label);
      },
    };
  }

  it('stops before a destructive follow-up once a target moves externally', async () => {
    const ledger = createTargetLedger();
    const log: string[] = [];
    const fence = ledger.fence([tabTarget(1)]);
    const result = await runGuardedEffectPlan(ledger, fence, [
      {
        label: 'detach',
        run: async () => {
          log.push('detach');
          ledger.observe(tabTarget(1), 'moved');
        },
      },
      recordingStep('close', log),
    ]);

    expect(log).toEqual(['detach']);
    expect(result).toEqual({
      completedSteps: 1,
      label: 'close',
      status: 'superseded',
      target: tabTarget(1),
    });
  });

  it('runs every step while the fence holds', async () => {
    const ledger = createTargetLedger();
    const log: string[] = [];
    const result = await runGuardedEffectPlan(ledger, ledger.fence([tabTarget(1)]), [
      recordingStep('move', log),
      recordingStep('group', log),
    ]);
    expect(log).toEqual(['move', 'group']);
    expect(result).toEqual({ completedSteps: 2, status: 'completed' });
  });

  it('guards targets a step creates for the remainder of the plan', async () => {
    const ledger = createTargetLedger();
    const log: string[] = [];
    const result = await runGuardedEffectPlan(ledger, ledger.fence([windowTarget(1)]), [
      { label: 'create', run: async () => [tabTarget(2)] },
      {
        label: 'observe',
        run: async () => {
          ledger.observe(tabTarget(2), 'removed');
        },
      },
      recordingStep('navigate', log),
    ]);
    expect(log).toEqual([]);
    expect(result).toMatchObject({ status: 'superseded', target: tabTarget(2) });
  });
});

describe('effect fences', () => {
  it('keeps an expected observation from superseding its command', async () => {
    const ledger = createTargetLedger();
    const effects = createEffectFence(ledger, 'command-1', [tabTarget(1)]);

    await effects.step([{ change: 'updated', target: tabTarget(1) }], async () => {
      expect(ledger.observe(tabTarget(1), 'updated')).toBe('expected');
    });

    expect(() => effects.check()).not.toThrow();
  });

  it('throws before a follow-up after an external observation', async () => {
    const ledger = createTargetLedger();
    const effects = createEffectFence(ledger, 'command-1', [tabTarget(1)]);
    ledger.observe(tabTarget(1), 'moved');

    await expect(effects.step([], async () => undefined)).rejects.toEqual(
      expect.objectContaining({ name: 'SupersededTargetError', target: tabTarget(1) }),
    );
    expect(() => effects.check()).toThrow(SupersededTargetError);
  });

  it('fences a target resolved after command admission', () => {
    const ledger = createTargetLedger();
    const effects = createEffectFence(ledger, 'command-1', [windowTarget(1)]);

    effects.extend([tabTarget(2)]);
    ledger.observe(tabTarget(2), 'moved');

    expect(() => effects.check()).toThrow(SupersededTargetError);
  });
});
