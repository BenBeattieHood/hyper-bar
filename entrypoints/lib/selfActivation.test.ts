import { describe, expect, it } from 'vitest';
import {
  createSelfActivationLedger,
  DISPLACEMENT_GRACE_MS,
  SELF_ACTIVATION_TTL_MS,
} from './selfActivation';

const WINDOW = 7;

/** A ledger on a clock the test moves; `expecting` arms an activation of tab 1, `displacing` a displacement. */
function ledgerWith(arm?: 'expecting' | 'displacing') {
  let clock = 0;
  const ledger = createSelfActivationLedger(() => clock);
  if (arm === 'expecting') ledger.expectActivation(WINDOW, 1);
  const release = arm === 'displacing' ? ledger.expectDisplacement(WINDOW) : undefined;
  return { advance: (durationMs: number) => { clock += durationMs; }, ledger, release: release! };
}

describe('self activation ledger', () => {
  it('does not claim an activation nobody recorded', () => {
    expect(ledgerWith().ledger.claim(WINDOW, 1)).toBe(false);
  });

  it('claims a tab it was about to activate', () => {
    expect(ledgerWith('expecting').ledger.claim(WINDOW, 1)).toBe(true);
  });

  it('claims a directed activation only once', () => {
    const { ledger } = ledgerWith('expecting');
    ledger.claim(WINDOW, 1);
    expect(ledger.claim(WINDOW, 1)).toBe(false);
  });

  it('leaves another tab in the same window, or the same tab in another window, to the user', () => {
    expect(ledgerWith('expecting').ledger.claim(WINDOW, 2)).toBe(false);
    expect(ledgerWith('expecting').ledger.claim(WINDOW + 1, 1)).toBe(false);
  });

  it('disowns a directed activation that never arrived', () => {
    const { advance, ledger } = ledgerWith('expecting');
    advance(SELF_ACTIVATION_TTL_MS + 1);
    expect(ledger.claim(WINDOW, 1)).toBe(false);
  });

  it('claims a tab it cannot name while a displacement is open', () => {
    expect(ledgerWith('displacing').ledger.claim(WINDOW, 99)).toBe(true);
  });

  it('claims a displacement delivered just after the collapse resolves', () => {
    const { advance, ledger, release } = ledgerWith('displacing');
    release(true);
    advance(DISPLACEMENT_GRACE_MS);
    expect(ledger.claim(WINDOW, 99)).toBe(true);
  });

  it('returns to the user once the displacement grace has passed', () => {
    const { advance, ledger, release } = ledgerWith('displacing');
    release(true);
    advance(DISPLACEMENT_GRACE_MS + 1);
    expect(ledger.claim(WINDOW, 99)).toBe(false);
  });

  it('withdraws a displacement when focus never moved', () => {
    const { ledger, release } = ledgerWith('displacing');
    release(false);
    expect(ledger.claim(WINDOW, 99)).toBe(false);
  });

  it('claims a displacement only once', () => {
    const { ledger } = ledgerWith('displacing');
    ledger.claim(WINDOW, 99);
    expect(ledger.claim(WINDOW, 98)).toBe(false);
  });

  it('claims one displacement for each collapse that armed one', () => {
    const { ledger } = ledgerWith('displacing');
    ledger.expectDisplacement(WINDOW);
    ledger.claim(WINDOW, 99);
    expect(ledger.claim(WINDOW, 98)).toBe(true);
  });

  it('ignores a release that runs twice', () => {
    const { advance, ledger, release } = ledgerWith('displacing');
    release(true);
    advance(DISPLACEMENT_GRACE_MS);
    release(false);
    expect(ledger.claim(WINDOW, 99)).toBe(true);
  });

  it('leaves another window alone during a displacement', () => {
    expect(ledgerWith('displacing').ledger.claim(WINDOW + 1, 99)).toBe(false);
  });

  it('counts each displacement it claims, and nothing before', () => {
    const { ledger } = ledgerWith('displacing');
    expect(ledger.claimedDisplacements(WINDOW)).toBe(0);
    ledger.claim(WINDOW, 99);
    expect(ledger.claimedDisplacements(WINDOW)).toBe(1);
  });

  it('does not count an activation the user made', () => {
    const { ledger } = ledgerWith('expecting');
    ledger.claim(WINDOW, 1);
    ledger.claim(WINDOW, 2);
    expect(ledger.claimedDisplacements(WINDOW)).toBe(0);
  });
});
