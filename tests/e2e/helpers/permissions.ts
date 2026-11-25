import type { Worker } from '@playwright/test';

export interface PermissionRequestRecord {
  access: { origins?: string[]; permissions?: string[] };
  /** 'pending' while Chrome's prompt is open, then 'granted', 'denied' or 'error: <message>'. */
  outcome: string;
}

interface RecordedRequest extends PermissionRequestRecord {
  requestedAt: number;
}

/**
 * Records each permission request the background makes while still passing it
 * to Chrome. Chrome refuses a request made outside a user gesture at once, so
 * the outcome tells whether the press still counted as one. A request that does
 * reach Chrome's prompt stays pending, because a headless browser cannot answer it.
 */
export async function recordPermissionRequests(worker: Worker) {
  await worker.evaluate(() => {
    type Access = { origins?: string[]; permissions?: string[] };
    const extension = globalThis as unknown as {
      chrome: { permissions: { request: (access: Access) => Promise<boolean> } };
    };
    const permissions = extension.chrome.permissions;
    const request = permissions.request.bind(permissions);
    const records: Array<{ access: Access; outcome: string; requestedAt: number }> = [];
    Object.defineProperty(globalThis, 'hyperPermissionRequestsForTest', {
      configurable: true,
      value: records,
    });
    Object.defineProperty(permissions, 'request', {
      configurable: true,
      value: (access: Access) => {
        const record = { access, outcome: 'pending', requestedAt: Date.now() };
        records.push(record);
        const pending = request(access);
        pending.then(
          (granted) => { record.outcome = granted ? 'granted' : 'denied'; },
          (error: unknown) => {
            record.outcome = `error: ${error instanceof Error ? error.message : String(error)}`;
          },
        );
        return pending;
      },
    });
  });
}

/**
 * The recorded requests once each has had a moment to settle. Chrome answers a
 * request outside a gesture within milliseconds, so one still pending after the
 * grace period is waiting on Chrome's prompt.
 */
export function settledPermissionRequests(
  worker: Worker,
  graceMs = 1_000,
): Promise<PermissionRequestRecord[]> {
  return worker.evaluate(async (grace) => {
    const runtime = globalThis as unknown as {
      hyperPermissionRequestsForTest?: RecordedRequest[];
    };
    const records = runtime.hyperPermissionRequestsForTest ?? [];
    const settled = () => records.every((record) =>
      record.outcome !== 'pending' || Date.now() - record.requestedAt >= grace);
    while (!settled()) await new Promise((resolve) => setTimeout(resolve, 50));
    return records.map(({ access, outcome }) => ({ access, outcome }));
  }, graceMs);
}

/** The recorded requests as they stand, pending or not. */
export const permissionRequests = (worker: Worker) => settledPermissionRequests(worker, 0);
