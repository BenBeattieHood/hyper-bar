import type { TabBackingLocation } from './bookmarkStorage';
import { isRecord } from './collections';
import { createLocalJournal } from './localJournal';

export const MAX_PENDING_BACKING_CLEANUPS = 512;

function parseLocation(value: unknown): TabBackingLocation | undefined {
  if (!isRecord(value)) return undefined;
  const location = value;
  if (
    typeof location.backingId !== 'string' || !location.backingId ||
    typeof location.backingToken !== 'string' || !location.backingToken ||
    typeof location.spaceId !== 'string' || !location.spaceId ||
    typeof location.url !== 'string' || !location.url ||
    (location.windowId !== undefined || 'windowId' in location) &&
      typeof location.windowId !== 'number'
  ) return undefined;
  return {
    backingId: location.backingId,
    backingToken: location.backingToken,
    spaceId: location.spaceId,
    ...(typeof location.windowId === 'number' ? { windowId: location.windowId } : {}),
    url: location.url,
  };
}

const journal = createLocalJournal({
  keyOf: (location: TabBackingLocation) => location.backingId,
  parse: parseLocation,
  retain: (locations) => locations.slice(-MAX_PENDING_BACKING_CLEANUPS),
  storageKey: 'hyperPendingBackingCleanup:v1',
});

export const loadPendingBackingCleanupJournal = journal.load;
export const savePendingBackingCleanupJournal = journal.save;
