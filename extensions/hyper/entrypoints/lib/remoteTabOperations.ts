import { isRecord } from './collections';
import type { BrowserTab } from './bookmarks';
import type { HyperModelSnapshot } from './model';
import {
  bookmarkTarget,
  tabTarget,
  windowTarget,
  type EffectFence,
} from './modelGuards';
import type {
  DurableOperation,
  DurableOperationResolution,
} from './operationJournal';
import {
  resolveRemoteTabTarget,
  type RemoteTabRequest,
  type RemoteTabTarget,
} from './remoteTab';
import { sameTabOwnership, type TabOwnership } from './tabOwnership';
import { normaliseUrl, tabPageIdentity, tabUrl } from './urlIdentity';
import { isNormalWindow } from './windowState';

export interface CompleteTabOwnership {
  backingId: string;
  backingToken: string;
  spaceId: string;
  url: string;
  windowId: number;
}

interface FreshRemoteTabTarget extends RemoteTabTarget {
  ownership: TabOwnership;
  tab: BrowserTab;
}

type NormalWindow = Pick<Browser.windows.Window, 'id' | 'incognito' | 'type'>;

export interface RemoteTabReadDependencies {
  getTab(tabId: number): Promise<BrowserTab | undefined>;
  getTabOwnership(tabId: number): Promise<TabOwnership | undefined>;
  getWindow(windowId: number): Promise<NormalWindow | undefined>;
}

export interface RemoteTabFocusDependencies extends RemoteTabReadDependencies {
  focusTab(tabId: number, targetWindowId: number, sourceWindowId: number): Promise<boolean>;
}

export interface RemoteTabMoveDependencies extends RemoteTabReadDependencies {
  advanceOperation(id: string, phase: 'effect-applied' | 'verifying'): Promise<void>;
  beginOperation(operation: DurableOperation): Promise<void>;
  completeOperation(id: string): Promise<void>;
  createOperationId(): string;
  moveTab(tabId: number, destinationWindowId: number): Promise<BrowserTab>;
  now(): number;
  persistMovedOwnership(
    tabId: number,
    source: CompleteTabOwnership,
    destination: CompleteTabOwnership,
  ): Promise<void>;
}

function inWindow(tab: BrowserTab | undefined, windowId: number): tab is BrowserTab {
  return Boolean(tab) && !tab!.incognito && tab!.windowId === windowId;
}

function showsPage(tab: BrowserTab | undefined, windowId: number, page: string): boolean {
  return inWindow(tab, windowId) && tabPageIdentity(tab) === page;
}

function isNormalWindowWithId(window: NormalWindow | undefined, windowId: number): boolean {
  return window?.id === windowId && isNormalWindow(window);
}

function completeOwnership(ownership: TabOwnership): CompleteTabOwnership | undefined {
  return typeof ownership.backingId === 'string' &&
    typeof ownership.backingToken === 'string' &&
    typeof ownership.url === 'string' &&
    typeof ownership.windowId === 'number'
    ? {
        backingId: ownership.backingId,
        backingToken: ownership.backingToken,
        spaceId: ownership.spaceId,
        url: ownership.url,
        windowId: ownership.windowId,
      }
    : undefined;
}

function requestedTarget(
  snapshot: HyperModelSnapshot,
  clientWindowId: number,
  request: RemoteTabRequest,
): RemoteTabTarget {
  const target = resolveRemoteTabTarget(snapshot, clientWindowId, request);
  if (!target) throw new Error('The requested remote tab is unavailable or ambiguous.');
  return target;
}

async function freshRemoteTarget(
  snapshot: HyperModelSnapshot,
  clientWindowId: number,
  request: RemoteTabRequest,
  effects: EffectFence,
  dependencies: RemoteTabReadDependencies,
): Promise<FreshRemoteTabTarget> {
  const target = requestedTarget(snapshot, clientWindowId, request);
  effects.extend([tabTarget(target.tabId), windowTarget(target.windowId)]);
  const sourceTab = request.source.kind === 'tab'
    ? dependencies.getTab(request.source.tabId)
    : Promise.resolve(undefined);
  const [clientWindow, remoteTab, remoteWindow, ownership, localTab] = await Promise.all([
    dependencies.getWindow(clientWindowId),
    dependencies.getTab(target.tabId),
    dependencies.getWindow(target.windowId),
    dependencies.getTabOwnership(target.tabId),
    sourceTab,
  ]);
  if (
    !isNormalWindowWithId(clientWindow, clientWindowId) ||
    !isNormalWindowWithId(remoteWindow, target.windowId) ||
    !showsPage(remoteTab, target.windowId, target.page) ||
    !ownership ||
    !sameTabOwnership(ownership, target.ownership) ||
    (localTab !== undefined && !showsPage(localTab, clientWindowId, target.page))
  ) throw new Error('The requested remote tab changed before it could be used.');
  return { ...target, ownership, tab: remoteTab! };
}

export async function activateRemoteTab(
  snapshot: HyperModelSnapshot,
  clientWindowId: number,
  request: RemoteTabRequest,
  effects: EffectFence,
  dependencies: RemoteTabFocusDependencies,
): Promise<void> {
  const target = await freshRemoteTarget(snapshot, clientWindowId, request, effects, dependencies);
  await effects.step([
    { change: 'updated', target: tabTarget(target.tabId) },
    { change: 'updated', target: windowTarget(target.windowId) },
  ], () => dependencies.focusTab(target.tabId, target.windowId, clientWindowId));
}

function moveOperation(
  id: string,
  now: number,
  target: FreshRemoteTabTarget,
  destinationWindowId: number,
  ownership: CompleteTabOwnership,
): DurableOperation {
  const destinationOwnership = { ...ownership, windowId: destinationWindowId };
  return {
    completionProof: {
      destinationWindowId,
      sourceWindowId: target.windowId,
      spaceId: target.spaceId,
      tabId: target.tabId,
    },
    id,
    idempotencyKey: [
      'move-tab-to-window',
      target.tabId,
      target.windowId,
      destinationWindowId,
      ownership.backingToken,
    ].join(':'),
    kind: 'move-tab-to-window',
    payload: {
      destinationOwnership,
      destinationWindowId,
      sourceIndex: target.tab.index,
      sourceOwnership: ownership,
      sourceWindowId: target.windowId,
      tabId: target.tabId,
    },
    phase: 'prepared',
    recovery: 'abandon',
    startedAt: now,
    updatedAt: now,
  };
}

export async function moveRemoteTabToWindow(
  snapshot: HyperModelSnapshot,
  clientWindowId: number,
  request: RemoteTabRequest,
  effects: EffectFence,
  dependencies: RemoteTabMoveDependencies,
): Promise<void> {
  const target = await freshRemoteTarget(snapshot, clientWindowId, request, effects, dependencies);
  const sourceOwnership = completeOwnership(target.ownership);
  if (
    !sourceOwnership ||
    sourceOwnership.windowId !== target.windowId ||
    normaliseUrl(tabUrl(target.tab)) !== normaliseUrl(sourceOwnership.url)
  ) throw new Error('The remote tab ownership is incomplete or stale.');
  const destinationOwnership = { ...sourceOwnership, windowId: clientWindowId };
  effects.extend([bookmarkTarget(sourceOwnership.backingId)]);
  const operation = moveOperation(
    dependencies.createOperationId(),
    dependencies.now(),
    target,
    clientWindowId,
    sourceOwnership,
  );
  await dependencies.beginOperation(operation);
  await effects.step(
    [{ change: 'moved', target: tabTarget(target.tabId) }],
    () => dependencies.moveTab(target.tabId, clientWindowId),
  );
  await dependencies.advanceOperation(operation.id, 'effect-applied');
  if (!showsPage(await dependencies.getTab(target.tabId), clientWindowId, target.page)) throw new Error('The remote tab changed while it was being moved.');
  await effects.step(
    [{ change: 'updated', target: bookmarkTarget(sourceOwnership.backingId) }],
    () => dependencies.persistMovedOwnership(target.tabId, sourceOwnership, destinationOwnership),
  );
  const [verifiedTab, verifiedOwnership] = await Promise.all([
    dependencies.getTab(target.tabId),
    dependencies.getTabOwnership(target.tabId),
  ]);
  if (
    !inWindow(verifiedTab, clientWindowId) ||
    !verifiedOwnership ||
    !sameTabOwnership(verifiedOwnership, destinationOwnership)
  ) throw new Error('The moved tab ownership could not be verified.');
  await dependencies.advanceOperation(operation.id, 'verifying');
  await dependencies.completeOperation(operation.id);
}

export interface MoveTabToWindowRecoveryDependencies {
  getTab(tabId: number): Promise<Pick<BrowserTab, 'incognito' | 'windowId'> | undefined>;
  getTabOwnership(tabId: number): Promise<TabOwnership | undefined>;
}

function completeOwnershipFromPayload(value: unknown): CompleteTabOwnership | undefined {
  if (!isRecord(value) || typeof value.spaceId !== 'string') return undefined;
  return completeOwnership(value as unknown as TabOwnership);
}

function recoveryProof(operation: DurableOperation) {
  if (operation.kind !== 'move-tab-to-window') return undefined;
  const { destinationWindowId, sourceWindowId, tabId } = operation.completionProof;
  const sourceIndex = operation.payload.sourceIndex;
  const sourceOwnership = completeOwnershipFromPayload(operation.payload.sourceOwnership);
  const destinationOwnership = completeOwnershipFromPayload(operation.payload.destinationOwnership);
  if (
    typeof destinationWindowId !== 'number' ||
    typeof sourceWindowId !== 'number' ||
    typeof tabId !== 'number' ||
    typeof sourceIndex !== 'number' ||
    !Number.isInteger(sourceIndex) ||
    sourceIndex < 0 ||
    !sourceOwnership ||
    !destinationOwnership ||
    sourceOwnership.windowId !== sourceWindowId ||
    destinationOwnership.windowId !== destinationWindowId ||
    !sameTabOwnership(sourceOwnership, { ...destinationOwnership, windowId: sourceWindowId })
  ) return undefined;
  return { destinationOwnership, destinationWindowId, sourceOwnership, sourceWindowId, tabId };
}

export async function recoverMovedTabToWindowOperation(
  operation: DurableOperation,
  dependencies: MoveTabToWindowRecoveryDependencies,
): Promise<DurableOperationResolution> {
  const proof = recoveryProof(operation);
  if (!proof) {
    return { reason: 'The moved tab completion proof is incomplete.', status: 'abandoned' };
  }
  const [tab, ownership] = await Promise.all([
    dependencies.getTab(proof.tabId),
    dependencies.getTabOwnership(proof.tabId),
  ]);
  if (!tab || tab.incognito || !ownership) {
    return {
      reason: 'The moved tab changed before its ownership could be proven.',
      status: 'abandoned',
    };
  }
  if (tab.windowId === proof.destinationWindowId) {
    return sameTabOwnership(ownership, proof.destinationOwnership)
      ? { status: 'completed' }
      : { reason: 'The moved tab destination ownership does not match.', status: 'abandoned' };
  }
  if (tab.windowId === proof.sourceWindowId) {
    return sameTabOwnership(ownership, proof.sourceOwnership)
      ? { status: 'rolled-back' }
      : { reason: 'The source tab ownership does not match.', status: 'abandoned' };
  }
  return {
    reason: 'The moved tab is no longer in either recorded window.',
    status: 'abandoned',
  };
}