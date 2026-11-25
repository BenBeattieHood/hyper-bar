import { structuralRepairRoles, type StructureHealth } from './modelIntegrity';

export interface StructureRepairDecision {
  /** Carried into the next call; names the gap already attempted. */
  attempted: string | undefined;
  repair: boolean;
}

/**
 * Decides whether the structure a revision describes is worth repairing.
 *
 * Repair is a response to what the model observed rather than to a bookmark
 * event, so it is driven from committed revisions. Those arrive on every tab and
 * window change too, which is why a gap that survived one attempt is not retried
 * until the tree has been seen healthy: without that, a repair that cannot close
 * the gap would run against every reconciliation for as long as the gap lasts.
 *
 * Only absent and incomplete trees are repairable. An ambiguous one has two
 * candidates for a role and picking between them can destroy what the user put
 * there, and an unreadable one is a failed read rather than a damaged profile.
 */
export function decideStructureRepair(
  health: StructureHealth,
  attempted: string | undefined,
): StructureRepairDecision {
  const roles = structuralRepairRoles(health);
  if (roles.length === 0) {
    return {
      attempted: health.status === 'healthy' ? undefined : attempted,
      repair: false,
    };
  }
  const signature = roles.join(',');
  return signature === attempted
    ? { attempted, repair: false }
    : { attempted: signature, repair: true };
}

/**
 * Wraps the decision up as a subscriber, holding the attempted gap between
 * commits so the caller does not have to.
 */
export function watchStructureRepair(
  read: () => StructureHealth,
  repair: () => void,
): () => void {
  let attempted: string | undefined;
  return () => {
    const decision = decideStructureRepair(read(), attempted);
    attempted = decision.attempted;
    if (decision.repair) repair();
  };
}
