import { afterAll, bench, describe } from 'vitest';
import { commitHyperModelAtom, hyperModelAtom } from '../../entrypoints/lib/model';
import { createSearchController } from '../../entrypoints/lib/searchController';
import { SharedSearchIndex } from '../../entrypoints/lib/searchIndex';
import { searchRecordsForWindow } from '../../entrypoints/lib/searchProjection';
import { BENCH_NOW, keystrokes, searchBenchmarkProfile, WINDOW_ID } from './searchFixture';

/**
 * Profiles the background half of one Search keystroke on a large profile.
 * Run with `npm run bench:search`. Each typing bench sends every prefix of its
 * query, as the view does, and clones each answer as the port would.
 */
const profile = searchBenchmarkProfile();
const controller = createSearchController({
  extensionOrigin: () => 'chrome-extension://hyper/',
  history: { deleteUrl: async () => undefined, search: async () => [] },
  reconcile: async () => undefined,
  selectionStorage: { set: async () => undefined },
  store: profile.store,
});
await controller.initialize();
const client = { role: 'newtab' as const, windowId: WINDOW_ID };
const request = (query: string) => ({
  commands: profile.commands,
  includeFolders: false,
  limit: 18,
  query,
  requestId: 'bench',
  type: 'search-query' as const,
});
const typeOut = async (query: string) => {
  for (const prefix of keystrokes(query)) {
    structuredClone(await controller.search(request(prefix), client));
  }
};
/** A reconciliation that changed nothing still commits a new revision. */
const commitAgain = () => profile.store.set(commitHyperModelAtom, {
  sources: profile.store.get(hyperModelAtom),
});
const records = searchRecordsForWindow(profile.store.get(hyperModelAtom), WINDOW_ID)!;

const firstQueryAfterOpen: number[] = [];
afterAll(() => {
  const sorted = [...firstQueryAfterOpen].sort((a, b) => a - b);
  if (sorted.length) console.log(`first query after open, median ${sorted[sorted.length >> 1]!.toFixed(2)} ms`);
});

describe(`search keystrokes (${records.items.length} records)`, () => {
  bench('type "metrics dashboard" (17 keystrokes)', () => typeOut('metrics dashboard'));
  bench('type "github pull" (11 keystrokes)', () => typeOut('github pull'));
  bench('one keystroke after a new model revision', async () => {
    commitAgain();
    structuredClone(await controller.search(request('roadmap'), client));
  });
});

describe('search stages', () => {
  bench('project window records from a new revision', () => {
    searchRecordsForWindow(commitAgain(), WINDOW_ID);
  });
  bench('first query on a cold index', () => {
    new SharedSearchIndex(() => BENCH_NOW).searchRequest(
      { commands: profile.commands, items: records.items },
      'roadmap',
      records.activeSpaceId,
      18,
      false,
    );
  });

  // Opening Search indexes in idle batches of 400 before the first keystroke.
  bench('one idle batch of 400 records while Search opens', () => {
    new SharedSearchIndex(() => BENCH_NOW).prepare(records.items, 400);
  });

  bench('index in idle batches, then the first query', () => {
    const index = new SharedSearchIndex(() => BENCH_NOW);
    while (index.prepare(records.items, 400));
    const started = performance.now();
    index.searchRequest(
      { commands: profile.commands, items: records.items },
      'roadmap',
      records.activeSpaceId,
      18,
      false,
    );
    firstQueryAfterOpen.push(performance.now() - started);
  });
});
