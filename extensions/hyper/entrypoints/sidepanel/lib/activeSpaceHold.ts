/**
 * Decides what active space the sidebar shows while a space switch is in flight.
 *
 * The model deliberately keeps naming the space being left until the activation
 * it was given takes effect (see docs/model/05-controller-inputs.md), so the view holds the
 * space it is switching to and overrides the projection with it. The hold is
 * value-based rather than an overlay because an overlay retires on the next
 * revision, which can arrive before the activation commits.
 *
 * The hold is retired the instant the model finally reports that exact space, or
 * when the selection settles (see spaceActivation.ts), so
 * the view neither snaps back to the old space mid-switch nor sticks on the new
 * one once the model has caught up.
 */
export function resolveActiveSpaceHold(
  pendingActiveSpaceId: string | null,
  projectedActiveSpaceId: string | null,
): { activeSpaceId: string | null; pendingActiveSpaceId: string | null } {
  const held = pendingActiveSpaceId === projectedActiveSpaceId ? null : pendingActiveSpaceId;
  return {
    activeSpaceId: held ? held : projectedActiveSpaceId,
    pendingActiveSpaceId: held,
  };
}
