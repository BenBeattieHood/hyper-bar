import type { TargetKey } from './modelGuards';

/**
 * The complete inventory of explicit actions. Every user or view initiated
 * change enters the serial lane as one of these kinds; nothing mutates browser
 * state outside this list.
 *
 * Enumerable at runtime so the architecture tests can assert that every kind
 * with a handler also has a caller.
 */
export const hyperActionKinds = [
  'actOnTimedMessage',
  'activateTab',
  'closeSpaceTabs',
  'closeTabs',
  'copyBookmark',
  'createBookmark',
  'createBookmarkFolder',
  'createSpace',
  'createTab',
  'createWindow',
  'deleteBookmark',
  'deleteHistory',
  'deleteSpace',
  'detachTab',
  'dismissTimedMessage',
  'duplicateSpace',
  'duplicateTab',
  'forgetSearchSelection',
  'importBookmarkFolder',
  'moveBookmark',
  'moveSessionTab',
  'moveTabToWindow',
  'moveTabs',
  'navigateTab',
  'navigateTabHistory',
  'openBookmark',
  'openFavourite',
  'recordSearchSelection',
  'reloadSpaceTabs',
  'reloadTab',
  'renameBookmark',
  'renameTab',
  'restoreClosedTab',
  'selectSpace',
  'setFavourite',
  'setPreference',
  'setSpaceArchived',
  'setTabFolder',
  'setTabGroup',
  'setTabMediaPlayback',
  'setTabMuted',
  'setTabPinned',
  'setTabZoom',
  'shareDrag',
  'showMessage',
  'splitTab',
  'toggleWindowFullscreen',
  'updateBookmarkUrl',
] as const;

export type HyperActionKind = (typeof hyperActionKinds)[number];

export type CommandFailureReason =
  | 'browser-error'
  | 'not-permitted'
  | 'postcondition-failed'
  | 'precondition-failed'
  | 'superseded'
  | 'unsupported';

/** Thrown by a handler whose failure has a name the caller can act on. */
export class CommandFailureError extends Error {
  constructor(readonly failure: CommandFailureReason, message: string) {
    super(message);
    this.name = 'CommandFailureError';
  }
}

export type CommandPhase = 'failed' | 'pending' | 'succeeded';

/**
 * Command status is ephemeral root state. It is committed with the snapshot it
 * describes so a view can never read an outcome that disagrees with the tree it
 * is rendering, and it is never written to durable storage.
 */
export interface CommandStatus {
  clientId: string;
  commandId: string;
  failure?: CommandFailureReason;
  kind: HyperActionKind;
  phase: CommandPhase;
  /**
   * What the effect produced, for the callers that consume the entity they
   * asked to create. It rides the terminal status so it shares a revision with
   * the tree that contains it, and a view can never read an id back before the
   * snapshot that holds it. Must be structured-cloneable: it crosses the port.
   */
  result?: unknown;
  settledRevision?: number;
  startedRevision: number;
  targets: readonly TargetKey[];
}

export type CommandStatusTable = Readonly<Record<string, CommandStatus>>;

/** What a caller learns once its command reaches a terminal status. */
export interface CommandSettlementOutcome {
  /**
   * The connection dropped after the command left, so whether it ran is
   * unknown. Only a caller whose command is safe to repeat sends it again.
   */
  dropped?: boolean;
  failure?: CommandFailureReason;
  result?: unknown;
  succeeded: boolean;
}

export const emptyCommandStatusTable: CommandStatusTable = {};

/** Backpressure: a client cannot queue unbounded work onto the serial lane. */
export const MAX_PENDING_COMMANDS_PER_CLIENT = 16;

/** Retention: settled statuses survive only long enough to be delivered. */
export const MAX_SETTLED_COMMANDS = 32;

export type BeginCommandResult =
  | { reason: 'duplicate-command-id' | 'too-many-pending'; status: 'rejected' }
  | { status: 'accepted'; table: CommandStatusTable };

export function beginCommand(
  table: CommandStatusTable,
  command: Omit<CommandStatus, 'failure' | 'phase' | 'settledRevision'>,
): BeginCommandResult {
  if (table[command.commandId]) return { reason: 'duplicate-command-id', status: 'rejected' };
  const pending = Object.values(table).filter(
    (status) => status.phase === 'pending' && status.clientId === command.clientId,
  );
  if (pending.length >= MAX_PENDING_COMMANDS_PER_CLIENT) {
    return { reason: 'too-many-pending', status: 'rejected' };
  }
  return {
    status: 'accepted',
    table: { ...table, [command.commandId]: { ...command, phase: 'pending' } },
  };
}

export function settleCommand(
  table: CommandStatusTable,
  commandId: string,
  outcome: { failure?: CommandFailureReason; phase: 'failed' | 'succeeded'; result?: unknown },
  revision: number,
): CommandStatusTable {
  const existing = table[commandId];
  if (!existing || existing.phase !== 'pending') return table;
  return {
    ...table,
    [commandId]: {
      ...existing,
      ...(outcome.failure === undefined ? {} : { failure: outcome.failure }),
      ...(outcome.result === undefined ? {} : { result: outcome.result }),
      phase: outcome.phase,
      settledRevision: revision,
    },
  };
}

/**
 * Keeps every pending command and only the most recently settled ones, so the
 * table stays bounded without ever losing an outcome a view has yet to observe.
 */
export function retainCommandStatuses(table: CommandStatusTable): CommandStatusTable {
  const settled = Object.values(table).filter((status) => status.phase !== 'pending');
  if (settled.length <= MAX_SETTLED_COMMANDS) return table;
  const expired = settled
    .sort((left, right) => (left.settledRevision ?? 0) - (right.settledRevision ?? 0))
    .slice(0, settled.length - MAX_SETTLED_COMMANDS);
  const retained: Record<string, CommandStatus> = { ...table };
  for (const status of expired) delete retained[status.commandId];
  return retained;
}

/** A client only ever learns the outcome of commands it issued. */
export function commandStatusesForClient(
  table: CommandStatusTable,
  clientId: string,
): readonly CommandStatus[] {
  return Object.values(table)
    .filter((status) => status.clientId === clientId)
    .sort((left, right) => left.startedRevision - right.startedRevision);
}

/**
 * A disconnected client cannot acknowledge anything, so its settled statuses are
 * dropped immediately. Pending work keeps its slot until the effect finishes.
 */
export function forgetClientCommands(
  table: CommandStatusTable,
  clientId: string,
): CommandStatusTable {
  const retained: Record<string, CommandStatus> = {};
  for (const [commandId, status] of Object.entries(table)) {
    if (status.clientId === clientId && status.phase !== 'pending') continue;
    retained[commandId] = status;
  }
  return retained;
}

export type DestructiveActionKind = 'closeTabs' | 'deleteSpace';

export interface DestructiveOutcomePolicy {
  /** Bookmarks the user authored inside the target. */
  authoredBookmarks: 'delete' | 'retain';
  /** Hidden `/tabs` backing nodes belonging to the target. */
  backings: 'delete' | 'delete-unclaimed' | 'retain';
  /** Native tab groups mapped to the target. `release` ungroups, never closes. */
  groups: 'release' | 'retain';
  /** Live tabs owned by the target. */
  liveTabs: 'close-owned' | 'release' | 'retain';
}

/**
 * Bookmarks belong to spaces, so deleting a space deletes its bookmarks with its
 * structure: backings and the space root go, tabs the space demonstrably owns
 * are closed, and native groups are ungrouped rather than removed.
 */
export const destructiveOutcomePolicies: Readonly<
  Record<DestructiveActionKind, DestructiveOutcomePolicy>
> = {
  closeTabs: {
    authoredBookmarks: 'retain',
    backings: 'delete-unclaimed',
    groups: 'retain',
    liveTabs: 'close-owned',
  },
  deleteSpace: {
    authoredBookmarks: 'delete',
    backings: 'delete',
    groups: 'release',
    liveTabs: 'close-owned',
  },
};

export interface DeleteSpaceProof {
  ownedTabIds: readonly number[];
  releasedGroupIds: readonly number[];
  spaceRootId: string;
}

export interface CloseTabsProof {
  closedTabIds: readonly number[];
  removedBackingIds: readonly string[];
  retainedBackingIds: readonly string[];
}

export interface PostconditionObservation {
  bookmarkParentIds: ReadonlyMap<string, string>;
  claimedBackingIds: ReadonlySet<string>;
  liveGroupIds: ReadonlySet<number>;
  liveTabIds: ReadonlySet<number>;
  mappedGroupIds: ReadonlySet<number>;
}

export function deleteSpaceViolations(
  proof: DeleteSpaceProof,
  observed: PostconditionObservation,
): readonly string[] {
  const violations: string[] = [];
  if (observed.bookmarkParentIds.has(proof.spaceRootId)) {
    violations.push(`space root ${proof.spaceRootId} still present`);
  }
  for (const tabId of proof.ownedTabIds) {
    if (observed.liveTabIds.has(tabId)) violations.push(`owned tab ${tabId} still open`);
  }
  for (const groupId of proof.releasedGroupIds) {
    if (observed.liveGroupIds.has(groupId)) {
      violations.push(`group ${groupId} still has tabs`);
    }
    if (observed.mappedGroupIds.has(groupId)) violations.push(`group ${groupId} still mapped`);
  }
  return violations;
}

export function closeTabsViolations(
  proof: CloseTabsProof,
  observed: PostconditionObservation,
): readonly string[] {
  const violations: string[] = [];
  for (const tabId of proof.closedTabIds) {
    if (observed.liveTabIds.has(tabId)) violations.push(`tab ${tabId} still open`);
  }
  for (const backingId of proof.removedBackingIds) {
    if (observed.bookmarkParentIds.has(backingId)) {
      violations.push(`backing ${backingId} still present`);
    }
  }
  for (const backingId of proof.retainedBackingIds) {
    if (!observed.claimedBackingIds.has(backingId)) {
      violations.push(`backing ${backingId} was retained without a claim`);
    }
  }
  return violations;
}
