/**
 * Chromium declares `scripting` as an optional permission and binds
 * `chrome.scripting` only once it is granted. Firefox declares no such
 * permission and runs page scripts through its legacy tabs API instead.
 */

export interface ScriptResult<Result> {
  frameId: number;
  result?: Result;
}

export interface ScriptingApi {
  executeScript<Result>(injection: {
    args?: unknown[];
    func: (...args: never[]) => Result | Promise<Result>;
    target: { allFrames?: boolean; frameIds?: number[]; tabId: number };
  }): Promise<Array<ScriptResult<Result>>>;
}

const BINDING_POLL_MS = 25;
const BINDING_TIMEOUT_MS = 1_000;

export function chromeScripting(): ScriptingApi | undefined {
  const runtimeGlobal = globalThis as unknown as {
    chrome?: { scripting?: ScriptingApi };
  };
  return runtimeGlobal.chrome?.scripting?.executeScript
    ? runtimeGlobal.chrome.scripting
    : undefined;
}

/** The manifest decides, because the API stays undefined until the permission is granted. */
export function usesScriptingPermission(): boolean {
  if (chromeScripting()) return true;
  const manifest = browser.runtime?.getManifest?.() as {
    optional_permissions?: unknown[];
    permissions?: unknown[];
  } | undefined;
  return [...manifest?.permissions ?? [], ...manifest?.optional_permissions ?? []]
    .includes('scripting');
}

/**
 * Resolves true once `chrome.scripting` is bound, or false when the permission is
 * not granted or the API does not arrive in time. Chromium binds the API into a
 * running worker by another route than the one that answers `permissions.request`
 * and fires `permissions.onAdded`, so the API can briefly trail a grant.
 */
export async function scriptingReady(timeoutMs = BINDING_TIMEOUT_MS): Promise<boolean> {
  if (chromeScripting()) return true;
  if (!usesScriptingPermission()) return false;
  const granted = await (browser.permissions?.contains({ permissions: ['scripting'] }) ??
    Promise.resolve(false)).catch(() => false);
  if (!granted) return false;
  const deadline = Date.now() + timeoutMs;
  while (!chromeScripting()) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, BINDING_POLL_MS));
  }
  return true;
}
