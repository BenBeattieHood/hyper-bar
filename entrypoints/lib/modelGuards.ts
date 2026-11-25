/**
 * Effects are issued one at a time against targets that an external actor can
 * change at any moment, so a plan re-proves its fence before every step rather
 * than only before the commit. Hyper's own effects are declared in advance so
 * that the evidence they produce does not supersede the plan that caused it.
 */

export type TargetKey =
  | `bookmark:${string}`
  | `group:${number}`
  | `space:${string}`
  | `tab:${number}`
  | `window:${number}`;

export type TargetChange = 'created' | 'moved' | 'removed' | 'updated';

export const bookmarkTarget = (id: string): TargetKey => `bookmark:${id}`;
export const groupTarget = (id: number): TargetKey => `group:${id}`;
export const spaceTarget = (id: string): TargetKey => `space:${id}`;
export const tabTarget = (id: number): TargetKey => `tab:${id}`;
export const windowTarget = (id: number): TargetKey => `window:${id}`;

/** Bounds the ledger when an effect never produces the evidence it declared. */
export const MAX_PENDING_EXPECTATIONS = 256;

export interface TargetFence {
  generations: ReadonlyMap<TargetKey, number>;
}

export type ObservationOrigin = 'expected' | 'external';

export interface ExpectedEffect {
  change: TargetChange;
  target: TargetKey;
}

/** Raised before a stale plan can issue another browser effect. */
export class SupersededTargetError extends Error {
  constructor(readonly target: TargetKey) {
    super(`An external change superseded ${target}.`);
    this.name = 'SupersededTargetError';
  }
}

export interface TargetLedger {
  /** Declares evidence that Hyper is about to cause, keyed to its command. */
  expect(commandId: string, target: TargetKey, change: TargetChange): void;
  fence(targets: Iterable<TargetKey>): TargetFence;
  forget(commandId: string): void;
  generation(target: TargetKey): number;
  observe(target: TargetKey, change: TargetChange): ObservationOrigin;
  supersededTarget(fence: TargetFence): TargetKey | undefined;
}

/**
 * Gives one intent a stable target fence and lets its effect steps declare the
 * browser evidence they expect immediately before making each call.
 */
export interface EffectFence {
  check(): void;
  extend(targets: readonly TargetKey[]): void;
  step<Result>(
    expected: readonly ExpectedEffect[],
    effect: () => Promise<Result>,
  ): Promise<Result>;
}

interface Expectation {
  commandId: string;
  key: string;
}

export function createTargetLedger(): TargetLedger {
  const generations = new Map<TargetKey, number>();
  const expectations: Expectation[] = [];

  const bump = (target: TargetKey) => {
    generations.set(target, (generations.get(target) ?? 0) + 1);
  };

  return {
    expect(commandId, target, change) {
      expectations.push({ commandId, key: `${target}:${change}` });
      if (expectations.length > MAX_PENDING_EXPECTATIONS) {
        expectations.splice(0, expectations.length - MAX_PENDING_EXPECTATIONS);
      }
    },
    fence(targets) {
      return {
        generations: new Map([...targets].map(
          (target) => [target, generations.get(target) ?? 0] as const,
        )),
      };
    },
    forget(commandId) {
      for (let index = expectations.length - 1; index >= 0; index -= 1) {
        if (expectations[index]!.commandId === commandId) expectations.splice(index, 1);
      }
    },
    generation(target) {
      return generations.get(target) ?? 0;
    },
    observe(target, change) {
      const key = `${target}:${change}`;
      const index = expectations.findIndex((expectation) => expectation.key === key);
      if (index >= 0) {
        expectations.splice(index, 1);
        return 'expected';
      }
      bump(target);
      return 'external';
    },
    supersededTarget(fence) {
      for (const [target, generation] of fence.generations) {
        if ((generations.get(target) ?? 0) !== generation) return target;
      }
      return undefined;
    },
  };
}

export function createEffectFence(
  ledger: TargetLedger,
  commandId: string,
  targets: readonly TargetKey[],
): EffectFence {
  let fence = ledger.fence(targets);
  const check = () => {
    const target = ledger.supersededTarget(fence);
    if (target !== undefined) throw new SupersededTargetError(target);
  };
  return {
    check,
    extend(additionalTargets) {
      check();
      const generations = new Map(fence.generations);
      for (const target of additionalTargets) {
        if (!generations.has(target)) generations.set(target, ledger.generation(target));
      }
      fence = { generations };
    },
    async step(expected, effect) {
      check();
      for (const { change, target } of expected) ledger.expect(commandId, target, change);
      const result = await effect();
      check();
      return result;
    },
  };
}

export interface GuardedEffectStep {
  label: string;
  /** Any targets returned join the fence for the remaining steps. */
  run(): Promise<readonly TargetKey[] | void>;
}

export type GuardedEffectPlanResult =
  | { completedSteps: number; status: 'completed' }
  | {
      completedSteps: number;
      label: string;
      status: 'superseded';
      target: TargetKey;
    };

/**
 * Stops before the first step whose targets changed externally, so a stale plan
 * can never issue a destructive follow-up. Completed steps are reported so the
 * caller can journal or compensate for exactly what happened.
 */
export async function runGuardedEffectPlan(
  ledger: TargetLedger,
  fence: TargetFence,
  steps: readonly GuardedEffectStep[],
): Promise<GuardedEffectPlanResult> {
  let current = fence;
  let completedSteps = 0;
  for (const step of steps) {
    const superseded = ledger.supersededTarget(current);
    if (superseded !== undefined) {
      return { completedSteps, label: step.label, status: 'superseded', target: superseded };
    }
    const created = await step.run();
    completedSteps += 1;
    if (created && created.length > 0) {
      const generations = new Map(current.generations);
      for (const target of created) generations.set(target, ledger.generation(target));
      current = { generations };
    }
  }
  return { completedSteps, status: 'completed' };
}
