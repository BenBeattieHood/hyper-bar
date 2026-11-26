import { afterEach, describe, expect, it, vi } from 'vitest';
import { chromeScripting, scriptingReady, usesScriptingPermission } from './scriptingAccess';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const declaredScripting = (contains: () => Promise<boolean>) => vi.stubGlobal('browser', {
  permissions: { contains: vi.fn(contains) },
  runtime: { getManifest: () => ({ optional_permissions: ['scripting'] }) },
});

describe('scripting access', () => {
  it('finds the API only once Chromium binds it', () => {
    vi.stubGlobal('chrome', {});
    expect(chromeScripting()).toBeUndefined();

    const scripting = { executeScript: vi.fn() };
    vi.stubGlobal('chrome', { scripting });
    expect(chromeScripting()).toBe(scripting);
  });

  it('reads the declared permission from the manifest before it is granted', () => {
    vi.stubGlobal('chrome', {});
    vi.stubGlobal('browser', { runtime: { getManifest: () => ({ permissions: ['tabs'] }) } });
    expect(usesScriptingPermission()).toBe(false);

    declaredScripting(async () => false);
    expect(usesScriptingPermission()).toBe(true);
  });

  it('is ready at once when the API is bound or the permission is absent', async () => {
    vi.stubGlobal('chrome', { scripting: { executeScript: vi.fn() } });
    await expect(scriptingReady()).resolves.toBe(true);

    vi.stubGlobal('chrome', {});
    vi.stubGlobal('browser', { runtime: { getManifest: () => ({}) } });
    await expect(scriptingReady()).resolves.toBe(false);

    declaredScripting(async () => false);
    await expect(scriptingReady()).resolves.toBe(false);
  });

  it('waits for Chromium to bind the API after a grant', async () => {
    vi.useFakeTimers();
    const runtimeChrome: { scripting?: unknown } = {};
    vi.stubGlobal('chrome', runtimeChrome);
    declaredScripting(async () => true);

    const ready = scriptingReady();
    await vi.advanceTimersByTimeAsync(100);
    runtimeChrome.scripting = { executeScript: vi.fn() };
    await vi.advanceTimersByTimeAsync(25);

    await expect(ready).resolves.toBe(true);
  });

  it('stops waiting when the granted API never binds', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('chrome', {});
    declaredScripting(async () => true);

    const ready = scriptingReady(200);
    await vi.advanceTimersByTimeAsync(250);

    await expect(ready).resolves.toBe(false);
  });
});
