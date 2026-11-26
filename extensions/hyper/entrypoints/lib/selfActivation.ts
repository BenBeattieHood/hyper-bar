/** How long a directed activation may take to arrive before it is disowned. */
export const SELF_ACTIVATION_TTL_MS = 1_000;
/** Chrome can deliver a displaced activation after the collapse call resolves. */
export const DISPLACEMENT_GRACE_MS = 250;

export interface SelfActivationLedger {
  /**
   * Whether this activation is one Hyper caused. The matching record is
   * consumed, so a later genuine activation is still the user's.
   */
  claim(windowId: number, tabId: number): boolean;
  /**
   * How many displacements have been claimed for a window, so an operation can
   * tell whether the focus it lost was taken by its own group mutation.
   */
  claimedDisplacements(windowId: number): number;
  /** Records a tab Hyper is about to activate itself. */
  expectActivation(windowId: number, tabId: number): void;
  /**
   * Records that one activation Hyper cannot name in advance may follow, as when
   * a group mutation moves focus. The release takes whether focus actually
   * moved, and withdraws the record when it did not.
   */
  expectDisplacement(windowId: number): (displaced: boolean) => void;
}

interface PendingDisplacement {
  /** Undefined while the operation that displaces focus is still running. */
  deadline: number | undefined;
}

/**
 * Lets a listener ignore Hyper's own activations without ignoring the user's.
 *
 * Browser activation events carry no provenance, and a genuine browser action
 * can happen while Hyper is switching spaces, so suppressing every event for the
 * duration of a switch would discard real user intent. Recording each
 * self-caused activation before its browser call keeps the rule to the events
 * Hyper actually caused, and every record is single-shot so the suppression
 * cannot outlive the one event it was written for. A displacement is withdrawn
 * unless focus is observed to have moved, so a call that could not have taken
 * focus leaves nothing behind to disown the user's next activation.
 */
export function createSelfActivationLedger(
  now: () => number = Date.now,
): SelfActivationLedger {
  const directed = new Map<string, number>();
  const displacements = new Map<number, PendingDisplacement[]>();
  const claimed = new Map<number, number>();
  const directedKey = (windowId: number, tabId: number) => `${windowId}:${tabId}`;

  const takeDisplacement = (windowId: number): boolean => {
    const pending = displacements.get(windowId);
    if (!pending) return false;
    const current = now();
    while (pending.length > 0) {
      const [entry] = pending;
      if (entry === undefined) break;
      pending.shift();
      if (entry.deadline === undefined || entry.deadline >= current) {
        if (pending.length === 0) displacements.delete(windowId);
        claimed.set(windowId, (claimed.get(windowId) ?? 0) + 1);
        return true;
      }
    }
    displacements.delete(windowId);
    return false;
  };

  return {
    claim(windowId, tabId) {
      const key = directedKey(windowId, tabId);
      const expiry = directed.get(key);
      if (expiry !== undefined) {
        directed.delete(key);
        if (expiry >= now()) return true;
      }
      return takeDisplacement(windowId);
    },
    claimedDisplacements(windowId) {
      return claimed.get(windowId) ?? 0;
    },
    expectActivation(windowId, tabId) {
      const current = now();
      for (const [key, expiry] of directed) {
        if (expiry < current) directed.delete(key);
      }
      directed.set(directedKey(windowId, tabId), current + SELF_ACTIVATION_TTL_MS);
    },
    expectDisplacement(windowId) {
      const entry: PendingDisplacement = { deadline: undefined };
      const pending = displacements.get(windowId) ?? [];
      pending.push(entry);
      displacements.set(windowId, pending);
      return (displaced) => {
        if (entry.deadline !== undefined) return;
        entry.deadline = displaced
          ? now() + DISPLACEMENT_GRACE_MS
          : Number.NEGATIVE_INFINITY;
      };
    },
  };
}
