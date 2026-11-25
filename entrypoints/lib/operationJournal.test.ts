import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  abandonDurableOperation,
  advanceDurableOperation,
  beginDurableOperation,
  completeDurableOperation,
  isAbandonedOperation,
  loadDurableOperations,
  MAX_ABANDONED_OPERATIONS,
  MAX_LIVE_OPERATIONS,
  recoverDurableOperations,
  type DurableOperation,
} from './operationJournal';
import { fakeStorageArea } from './testFixtures';

function installStorage() {
  vi.stubGlobal('browser', { storage: { local: fakeStorageArea() } });
}

function pendingImport(): DurableOperation {
  return {
    completionProof: { destinationParentId: 'destination', importedRootId: 'pending' },
    id: 'operation-1',
    idempotencyKey: 'import:source:destination:1',
    kind: 'import-bookmark-folder',
    payload: { destinationParentId: 'destination', sourceFolderId: 'source' },
    phase: 'prepared',
    recovery: 'rollback',
    startedAt: 1,
    updatedAt: 1,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('durable operation journal', () => {
  it('requires a prepared record before effects and removes it on completion', async () => {
    installStorage();
    await beginDurableOperation(pendingImport());
    await advanceDurableOperation('operation-1', 'effect-applied', {
      completionProof: { destinationParentId: 'destination', importedRootId: 'copy-1' },
    });

    await expect(loadDurableOperations()).resolves.toMatchObject([
      { id: 'operation-1', phase: 'effect-applied' },
    ]);

    await completeDurableOperation('operation-1');
    await expect(loadDurableOperations()).resolves.toEqual([]);
  });

  it('retains an auditable abandonment instead of guessing a recovery action', async () => {
    installStorage();
    await beginDurableOperation(pendingImport());

    await recoverDurableOperations(async () => ({
      reason: 'The created bookmark root cannot be verified.',
      status: 'abandoned',
    }));

    await expect(loadDurableOperations()).resolves.toMatchObject([
      {
        id: 'operation-1',
        phase: 'verifying',
        recovery: 'abandon',
        recoveryReason: 'The created bookmark root cannot be verified.',
      },
    ]);
    await abandonDurableOperation('operation-1', 'ignored').catch(() => undefined);
  });

  it('never lets abandoned records evict operations still awaiting recovery', async () => {
    installStorage();
    const live = { ...pendingImport(), id: 'live', idempotencyKey: 'import:live' };
    await beginDurableOperation(live);
    for (let index = 0; index < MAX_ABANDONED_OPERATIONS + 10; index += 1) {
      await beginDurableOperation({
        ...pendingImport(),
        id: `abandoned-${index}`,
        idempotencyKey: `import:abandoned:${index}`,
      });
      await abandonDurableOperation(`abandoned-${index}`, 'verification unavailable');
    }

    const stored = await loadDurableOperations();
    expect(stored.filter(isAbandonedOperation)).toHaveLength(MAX_ABANDONED_OPERATIONS);
    expect(stored.find((operation) => operation.id === 'live')).toMatchObject({
      phase: 'prepared',
    });
    expect(stored.map((operation) => operation.id)).toContain(
      `abandoned-${MAX_ABANDONED_OPERATIONS + 9}`,
    );
  });

  it('refuses a new operation rather than overflowing the live budget', async () => {
    installStorage();
    for (let index = 0; index < MAX_LIVE_OPERATIONS; index += 1) {
      await beginDurableOperation({
        ...pendingImport(),
        id: `live-${index}`,
        idempotencyKey: `import:live:${index}`,
      });
    }

    await expect(beginDurableOperation({
      ...pendingImport(),
      id: 'overflow',
      idempotencyKey: 'import:overflow',
    })).rejects.toThrow(/awaiting recovery/);
    await expect(loadDurableOperations()).resolves.toHaveLength(MAX_LIVE_OPERATIONS);
  });
});