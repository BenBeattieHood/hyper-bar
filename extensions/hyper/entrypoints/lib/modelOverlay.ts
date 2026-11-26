import type { CommandStatusTable } from './modelActions';

/**
 * The maximum number of optimistic edits a view may hold. It is well above the
 * per-client pending-command limit, because one intent may carry several edits.
 */
export const MAX_PENDING_OVERLAYS = 64;

export type OverlayApply<Projection> = (projection: Projection) => Projection;

interface OverlayEdit<Projection> {
  /** Set once the background has acknowledged the intent carrying this edit. */
  admitted: boolean;
  apply: OverlayApply<Projection>;
  commandId: string;
}

export interface OverlayStore<Projection> {
  /** Records an edit carried by an intent, shown until that command settles. */
  add(commandId: string, apply: OverlayApply<Projection>): void;
  /**
   * Marks an edit's intent as accepted. Until this arrives the command cannot
   * appear in any status table, so its absence is not yet evidence of anything.
   */
  admit(commandId: string): void;
  /** Drops an edit whose intent was never admitted. */
  discard(commandId: string): void;
  /**
   * Drops every edit whose admitted command has not settled. A dropped port
   * settles nothing, so the model becomes the only account of what happened.
   * An edit not yet admitted stays: its own intent still reports whether it was
   * admitted on a later connection or refused.
   */
  discardPendingCommands(): void;
  pendingCommandIds(): readonly string[];
  /**
   * Applies every still-pending edit over a committed projection. Edits stack in
   * the order they were made, so a later edit sees the earlier one.
   */
  project(projection: Projection, commands: CommandStatusTable): Projection;
}

/**
 * Lets a view render the background model as its only source of truth while a
 * change it has just made is still in flight.
 *
 * A committed snapshot describes the browser as it actually is, so applying one
 * to a field the view has just edited would revert the edit until the effect
 * lands. Holding the edit as a separate layer keeps the snapshot authoritative
 * underneath. An edit goes when the commit that settles its intent arrives:
 * terminal status and the tree that proves it share one revision. The view
 * therefore never treats its guess as confirmed browser state.
 *
 * Nothing here consults the clock. An unadmitted command is simply still in
 * flight, and every way an intent can fail — rejection, a dropped port, a
 * terminal status — already reports itself.
 */
export function createOverlayStore<Projection>(): OverlayStore<Projection> {
  let edits: OverlayEdit<Projection>[] = [];

  const bound = () => {
    if (edits.length > MAX_PENDING_OVERLAYS) edits = edits.slice(-MAX_PENDING_OVERLAYS);
  };

  const retire = (commands: CommandStatusTable) => {
    edits = edits.filter((edit) => {
      const status = commands[edit.commandId];
      if (status) return status.phase === 'pending';
      // Before acceptance the command cannot be in the table yet, so its absence
      // proves nothing. After acceptance, absence means it settled and was
      // pruned, and the tree underneath already carries the change.
      return !edit.admitted;
    });
  };

  return {
    add(commandId, apply) {
      edits.push({ admitted: false, apply, commandId });
      bound();
    },
    admit(commandId) {
      for (const edit of edits) {
        if (edit.commandId === commandId) edit.admitted = true;
      }
    },
    discard(commandId) {
      edits = edits.filter((edit) => edit.commandId !== commandId);
    },
    discardPendingCommands() {
      edits = edits.filter((edit) => !edit.admitted);
    },
    pendingCommandIds: () => edits.map((edit) => edit.commandId),
    project(projection, commands) {
      retire(commands);
      return edits.reduce((current, edit) => edit.apply(current), projection);
    },
  };
}
