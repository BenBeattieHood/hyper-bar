import { afterEach, describe, expect, it, vi } from 'vitest';
import { INSTALLATION_ID_KEY } from './bookmarkStorage';
import { createBrowserModelSourcesReader } from './modelSources';
import { SEARCH_SELECTION_HISTORY_KEY } from './searchSelection';
import { fakeStorageArea } from './testFixtures';

afterEach(() => vi.unstubAllGlobals());

describe('browser model sources', () => {
  it('reads only required local keys and does not invent an installation on failure', async () => {
    const local = fakeStorageArea({
      [INSTALLATION_ID_KEY]: 'installation-1',
      [SEARCH_SELECTION_HISTORY_KEY]: {
        '  Design ': {
          'command:open-design': { count: 2, lastUsed: 100 },
        },
      },
    });
    vi.stubGlobal('browser', {
      bookmarks: { getTree: vi.fn(async () => []) },
      runtime: { getURL: vi.fn(() => 'chrome-extension://hyper/') },
      storage: { local },
      tabGroups: { query: vi.fn(async () => []) },
      tabs: { query: vi.fn(async () => []) },
      windows: {
        getAll: vi.fn(async () => []),
        getLastFocused: vi.fn(async () => undefined),
      },
    });

    const sources = await createBrowserModelSourcesReader().readSources();

    expect(local.get).toHaveBeenCalledWith([
      INSTALLATION_ID_KEY,
      SEARCH_SELECTION_HISTORY_KEY,
    ]);
    expect(sources.runtime.installationId).toBe('installation-1');
    expect(sources.runtime.searchSelectionHistory).toEqual({
      design: {
        'command:open-design': { count: 2, lastUsed: 100 },
      },
    });

    local.get.mockRejectedValueOnce(new Error('Local storage is unavailable.'));
    await expect(createBrowserModelSourcesReader().readSources())
      .rejects.toThrow('Local storage is unavailable.');
  });
});