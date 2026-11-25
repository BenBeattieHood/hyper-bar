import { vi } from 'vitest';
import {
  commitHyperModelAtom,
  emptyBrowserObservation,
  emptyRuntimeMetadata,
  materialiseHyperModel,
  type BrowserObservation,
  type HyperModelSnapshot,
  type HyperModelStore,
  type RuntimeMetadata,
} from './model';

export function testTab(
  overrides: Partial<Browser.tabs.Tab> = {},
): Browser.tabs.Tab {
  return {
    id: 1,
    active: false,
    autoDiscardable: true,
    discarded: false,
    frozen: false,
    groupId: -1,
    highlighted: false,
    incognito: false,
    index: 0,
    lastAccessed: 0,
    pinned: false,
    selected: false,
    windowId: 1,
    ...overrides,
  };
}

/** Commits one revision whose sources are empty apart from the given fields. */
export function commitTestSources(
  store: HyperModelStore,
  browser: Partial<BrowserObservation> = {},
  runtime: Partial<RuntimeMetadata> = {},
): HyperModelSnapshot {
  return store.set(commitHyperModelAtom, { sources: {
    browser: { ...emptyBrowserObservation, ...browser },
    runtime: { ...emptyRuntimeMetadata, ...runtime },
  } });
}

type Keys = string | string[] | null | undefined;

/** An in-memory `storage.local` or `storage.session` area whose `values` tests can seed and read. */
export function fakeStorageArea(initial: Record<string, unknown> = {}) {
  const values = new Map(Object.entries(initial));
  const keysOf = (keys: Keys) => keys == null ? [...values.keys()] : typeof keys === 'string' ? [keys] : keys;
  return {
    get: vi.fn(async (keys?: Keys) =>
      Object.fromEntries(keysOf(keys).flatMap((key) => values.has(key) ? [[key, values.get(key)]] : []))),
    remove: vi.fn(async (keys: string | string[]) => {
      for (const key of keysOf(keys)) values.delete(key);
    }),
    set: vi.fn(async (items: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(items)) values.set(key, value);
    }),
    values,
  };
}

export const remoteSourceOwnership = {
  backingId: 'backing-2',
  backingToken: 'token-2',
  spaceId: 'two',
  url: 'https://shared.example',
  windowId: 2,
};

/** Windows 1 and 2 both show the shared page; window 2's tab is space two's. */
export function remoteTabSnapshot(overrides: Partial<HyperModelSnapshot> = {}): HyperModelSnapshot {
  const model = materialiseHyperModel(1, {
    browser: {
      ...emptyBrowserObservation,
      tabs: [
        { id: 1, index: 0, windowId: 1, url: 'https://shared.example' } as Browser.tabs.Tab,
        { id: 2, index: 3, windowId: 2, url: 'https://shared.example' } as Browser.tabs.Tab,
      ],
      windows: [
        { id: 1, incognito: false, type: 'normal' } as Browser.windows.Window,
        { id: 2, incognito: false, type: 'normal' } as Browser.windows.Window,
      ],
    },
    runtime: { ...emptyRuntimeMetadata, tabOwnerships: { 2: remoteSourceOwnership } },
  });
  return {
    ...model,
    ...overrides,
    derived: {
      ...model.derived,
      tabDispositions: new Map([[2, {
        backingId: remoteSourceOwnership.backingId,
        spaceId: remoteSourceOwnership.spaceId,
        status: 'owned' as const,
      }]]),
      ...overrides.derived,
    },
    hyper: { ...model.hyper, ...overrides.hyper },
  };
}
