import { isRecord } from './collections';
import { createLocalJournal } from './localJournal';

/**
 * Live entries are recovery-critical and abandoned entries are only auditable
 * history, so they cannot share a budget: a burst of abandonments must never
 * evict an operation that still needs rolling back.
 */
export const MAX_LIVE_OPERATIONS = 64;
export const MAX_ABANDONED_OPERATIONS = 32;

export type DurableOperationKind =
  | 'delete-space'
  | 'duplicate-space'
  | 'import-bookmark-folder'
  | 'move-tab-to-window'
  | 'restore-space-tabs';

export type DurableOperationPhase =
  | 'prepared'
  | 'effect-applied'
  | 'verifying';

export interface DurableOperation {
  completionProof: Readonly<Record<string, string | number | boolean>>;
  id: string;
  idempotencyKey: string;
  kind: DurableOperationKind;
  payload: Readonly<Record<string, unknown>>;
  phase: DurableOperationPhase;
  recovery: 'abandon' | 'rollback';
  startedAt: number;
  updatedAt: number;
}

export interface AbandonedDurableOperation extends DurableOperation {
  abandonedAt: number;
  phase: 'verifying';
  recovery: 'abandon';
  recoveryReason: string;
}

export type StoredDurableOperation = DurableOperation | AbandonedDurableOperation;

function isOperationKind(value: unknown): value is DurableOperationKind {
  return value === 'delete-space' ||
    value === 'duplicate-space' ||
    value === 'import-bookmark-folder' ||
    value === 'move-tab-to-window' ||
    value === 'restore-space-tabs';
}

function isOperationPhase(value: unknown): value is DurableOperationPhase {
  return value === 'prepared' || value === 'effect-applied' || value === 'verifying';
}

function isStringRecord(value: unknown): value is Record<string, string | number | boolean> {
  return isRecord(value) && Object.values(value).every((entry) =>
    typeof entry === 'string' || typeof entry === 'number' || typeof entry === 'boolean');
}

function parseOperation(value: unknown): StoredDurableOperation | undefined {
  if (!isRecord(value) ||
    typeof value.id !== 'string' || !value.id ||
    typeof value.idempotencyKey !== 'string' || !value.idempotencyKey ||
    !isOperationKind(value.kind) ||
    !isOperationPhase(value.phase) ||
    (value.recovery !== 'abandon' && value.recovery !== 'rollback') ||
    typeof value.startedAt !== 'number' ||
    typeof value.updatedAt !== 'number' ||
    !isRecord(value.payload) ||
    !isStringRecord(value.completionProof)
  ) return undefined;
  if ('abandonedAt' in value || 'recoveryReason' in value) {
    if (
      typeof value.abandonedAt !== 'number' ||
      typeof value.recoveryReason !== 'string' ||
      value.recovery !== 'abandon' ||
      value.phase !== 'verifying'
    ) return undefined;
    return value as unknown as AbandonedDurableOperation;
  }
  return value as unknown as DurableOperation;
}

export function isAbandonedOperation(
  operation: StoredDurableOperation,
): operation is AbandonedDurableOperation {
  return 'abandonedAt' in operation;
}

/**
 * Only abandoned records are ever evicted. Live records stay until they are
 * resolved; their bound is enforced when an operation is admitted, so the
 * journal can never silently forget work it is still responsible for.
 */
function retainOperations(
  operations: readonly StoredDurableOperation[],
): StoredDurableOperation[] {
  const abandoned = operations.filter(isAbandonedOperation);
  if (abandoned.length <= MAX_ABANDONED_OPERATIONS) return [...operations];
  const evicted = new Set<StoredDurableOperation>(
    abandoned.slice(0, abandoned.length - MAX_ABANDONED_OPERATIONS),
  );
  return operations.filter((operation) => !evicted.has(operation));
}

const journal = createLocalJournal({
  keyOf: (operation: StoredDurableOperation) => operation.id,
  parse: parseOperation,
  retain: retainOperations,
  storageKey: 'hyperOperationJournal:v1',
});
const saveOperations = journal.save;
export const loadDurableOperations = journal.load;

/** Rewrites one live operation; a gone or abandoned one is left to `unavailable`. */
async function replaceLiveOperation(
  id: string,
  replace: (current: DurableOperation) => StoredDurableOperation,
  unavailable: (current?: StoredDurableOperation) => void,
): Promise<void> {
  const operations = await loadDurableOperations();
  const index = operations.findIndex((operation) => operation.id === id);
  const current = operations[index];
  if (!current || isAbandonedOperation(current)) return unavailable(current);
  operations[index] = replace(current);
  await saveOperations(operations);
}

export async function beginDurableOperation(
  operation: DurableOperation,
): Promise<void> {
  if (operation.phase !== 'prepared') {
    throw new Error('A durable operation must be journaled before its first effect.');
  }
  const existing = await loadDurableOperations();
  if (existing.some((entry) =>
    entry.idempotencyKey === operation.idempotencyKey &&
    !isAbandonedOperation(entry),
  )) {
    throw new Error('An equivalent operation is already awaiting recovery.');
  }
  if (existing.filter((entry) => !isAbandonedOperation(entry)).length >= MAX_LIVE_OPERATIONS) {
    throw new Error('Too many durable operations are already awaiting recovery.');
  }
  await saveOperations([...existing, operation]);
}

export async function advanceDurableOperation(
  id: string,
  phase: Exclude<DurableOperationPhase, 'prepared'>,
  updates: Partial<Pick<DurableOperation, 'completionProof' | 'payload'>> = {},
): Promise<void> {
  await replaceLiveOperation(
    id,
    (current) => ({ ...current, ...updates, phase, updatedAt: Date.now() }),
    (current) => {
      throw new Error(current
        ? 'The durable operation was abandoned.'
        : 'The durable operation is unavailable.');
    },
  );
}

export async function completeDurableOperation(id: string): Promise<void> {
  await saveOperations((await loadDurableOperations()).filter(
    (operation) => operation.id !== id,
  ));
}

export async function abandonDurableOperation(
  id: string,
  recoveryReason: string,
): Promise<void> {
  await replaceLiveOperation(id, (current) => ({
    ...current,
    abandonedAt: Date.now(),
    phase: 'verifying',
    recovery: 'abandon',
    recoveryReason,
    updatedAt: Date.now(),
  }), () => undefined);
}

export type DurableOperationResolution =
  | { status: 'completed' }
  | { status: 'rolled-back' }
  | { reason: string; status: 'abandoned' };

/**
 * Recovery implementations must verify the recorded completion proof before
 * completing an operation. They may roll back only entities named in the
 * journal; otherwise the operation stays as an auditable abandonment record.
 */
export async function recoverDurableOperations(
  resolve: (operation: DurableOperation) => Promise<DurableOperationResolution>,
): Promise<void> {
  for (const operation of await loadDurableOperations()) {
    if (isAbandonedOperation(operation)) continue;
    const resolution = await resolve(operation);
    if (resolution.status === 'completed' || resolution.status === 'rolled-back') {
      await completeDurableOperation(operation.id);
    } else {
      await abandonDurableOperation(operation.id, resolution.reason);
    }
  }
}