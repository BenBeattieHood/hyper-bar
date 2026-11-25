import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  activeSpaceKey,
  createWindowActiveSpaceWriter,
  getWindowActiveSpaceId,
  isActiveSpaceKey,
  mapRestoredWindowIds,
  reconcileWindowActiveSpaceIds,
  removeWindowActiveSpaceId,
  setWindowActiveSpaceId,
} from './windowState';
import { fakeStorageArea } from './testFixtures';

function installStorage(initial: Record<string, unknown>) {
  const local = fakeStorageArea(initial);
  const session = fakeStorageArea();
  const windowValues = new Map<number, Record<string, unknown>>();
  vi.stubGlobal('browser', {
    sessions: {
      getWindowValue: async (windowId: number, key: string) => windowValues.get(windowId)?.[key],
      removeWindowValue: async (windowId: number, key: string) => {
        delete windowValues.get(windowId)?.[key];
      },
      setWindowValue: async (windowId: number, key: string, value: unknown) => {
        const values = windowValues.get(windowId) ?? {};
        values[key] = value;
        windowValues.set(windowId, values);
      },
    },
    storage: {
      local,
      session,
    },
  });
  const localValues = () => Object.fromEntries(local.values);
  const sessionValues = () => Object.fromEntries(session.values);
  return { localValues, session, sessionValues, windowValues };
}

afterEach(() => vi.unstubAllGlobals());

describe('window active space storage', () => {
  it('uses a session value and never falls back to a durable legacy key', async () => {
    installStorage({
      activeSpaceId: 'legacy',
    });

    await expect(getWindowActiveSpaceId(1)).resolves.toBeUndefined();
  });

  it('writes only the selected live window and identifies relevant change keys', async () => {
    const { localValues, windowValues } = installStorage({ activeSpaceId: 'legacy' });

    await setWindowActiveSpaceId(7, 'blue');

    expect(windowValues.get(7)).toMatchObject({ hyperActiveSpaceId: 'blue' });
    expect(localValues()).toEqual({ activeSpaceId: 'legacy' });
    expect(isActiveSpaceKey(activeSpaceKey(7), 7)).toBe(true);
    expect(isActiveSpaceKey(activeSpaceKey(8), 7)).toBe(false);
    expect(isActiveSpaceKey('activeSpaceId', 7)).toBe(true);
  });

  it('notifies the model after a native session write completes', async () => {
    const { windowValues } = installStorage({});
    const onPersisted = vi.fn(() => {
      expect(windowValues.get(7)).toMatchObject({ hyperActiveSpaceId: 'blue' });
    });

    await createWindowActiveSpaceWriter(onPersisted)(7, 'blue');

    expect(onPersisted).toHaveBeenCalledOnce();
  });

  it('purges legacy durable keys and stale fallback session keys on startup', async () => {
    const { localValues, session, sessionValues } = installStorage({
      activeSpaceId: 'legacy',
      'activeSpaceId:1': 'green',
      'activeSpaceId:2': 'blue',
    });
    session.values.set(activeSpaceKey(2), 'blue').set(activeSpaceKey(9), 'stale');

    await reconcileWindowActiveSpaceIds(new Set([2]));

    expect(localValues()).toEqual({});
    expect(sessionValues()).toEqual({ [activeSpaceKey(2)]: 'blue' });
  });

  it('removes a closed window active-space value', async () => {
    const { windowValues } = installStorage({});
    await setWindowActiveSpaceId(7, 'green');

    await removeWindowActiveSpaceId(7);

    expect(windowValues.get(7)).toEqual({});
  });
});

describe('restored window mapping', () => {
  it('maps a previous window whose tabs all reopened in one window nothing else claims', () => {
    expect(mapRestoredWindowIds(
      new Map([[1, new Set([10])], [2, new Set([20, 21])], [3, new Set([30])], [4, new Set([30])]]),
      new Map(),
      new Map(),
    )).toEqual(new Map([[1, 10]]));
  });

  it('infers the rest from the pages they share, most shared first', () => {
    const pages = (...identities: string[]) => new Set(identities);
    expect(mapRestoredWindowIds(
      new Map([[1, new Set([10])]]),
      new Map([[1, pages('a')], [2, pages('b')], [3, pages('b', 'c')]]),
      new Map([[10, pages('a', 'b')], [20, pages('b', 'c')], [30, pages('d')]]),
    )).toEqual(new Map([[1, 10], [3, 20]]));
  });
});