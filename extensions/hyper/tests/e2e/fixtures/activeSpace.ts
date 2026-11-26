import type { Worker } from '@playwright/test';
import {
  ACTIVE_SPACE_WINDOW_VALUE_KEY,
  activeSpaceKey,
} from '../../../entrypoints/lib/windowState';
import type { ExtensionGlobal } from '../helpers/extensionGlobal';

/**
 * Reads, writes or forgets a window's active space in one worker call, through
 * the window value where the browser has one and session storage otherwise.
 */
function windowSpace(
  worker: Worker,
  windowId: number,
  operation: 'clear' | 'read' | 'seed',
  spaceId?: string,
): Promise<string | undefined> {
  return worker.evaluate(async ({ operation: op, spaceId: value, storageKey, targetWindowId, windowValueKey }) => {
    const { sessions, storage } = (globalThis as unknown as ExtensionGlobal).chrome;
    if (op === 'read') {
      const windowValue = await sessions?.getWindowValue?.(targetWindowId, windowValueKey).catch(() => undefined);
      if (typeof windowValue === 'string') return windowValue;
      const stored = (await storage.session.get(storageKey))[storageKey];
      return typeof stored === 'string' ? stored : undefined;
    }
    if (op === 'seed') {
      if (sessions?.setWindowValue) await sessions.setWindowValue(targetWindowId, windowValueKey, value);
      else await storage.session.set({ [storageKey]: value });
      return undefined;
    }
    await sessions?.removeWindowValue?.(targetWindowId, windowValueKey);
    await storage.session.remove(storageKey);
    return undefined;
  }, {
    operation,
    spaceId,
    storageKey: activeSpaceKey(windowId),
    targetWindowId: windowId,
    windowValueKey: ACTIVE_SPACE_WINDOW_VALUE_KEY,
  });
}

/**
 * Binds the end-to-end suite to the production storage contract. Reading the
 * key through this helper means a change to where the active space lives fails
 * to compile here, instead of silently reading a key nothing writes any more.
 */
export const readActiveSpaceId = (worker: Worker, windowId: number): Promise<string | undefined> =>
  windowSpace(worker, windowId, 'read');

export async function seedActiveSpaceId(worker: Worker, windowId: number, spaceId: string): Promise<void> {
  await windowSpace(worker, windowId, 'seed', spaceId);
}

/** Forgets a window's space, as a browser restart or extension reload does. */
export async function clearActiveSpaceId(worker: Worker, windowId: number): Promise<void> {
  await windowSpace(worker, windowId, 'clear');
}

export { activeSpaceKey };
