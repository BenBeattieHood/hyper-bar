import { expect, type Worker } from '@playwright/test';
import { findHyperRootFolder, type BookmarkNode } from '../../../entrypoints/lib/bookmarks';
import {
  hyperRootTitleWithPreferences,
  preferencesFromHyperRoot,
  type HyperPreferences,
} from '../../../entrypoints/lib/preferences';
import { callChrome } from '../helpers/chrome';

const bookmarkTree = (worker: Worker) => callChrome<BookmarkNode[]>(worker, 'bookmarks.getTree');

export async function readHyperPreferences(worker: Worker): Promise<HyperPreferences> {
  return preferencesFromHyperRoot(findHyperRootFolder(await bookmarkTree(worker)));
}

/**
 * Binds the end-to-end suite to the production preference contract. The helper
 * writes the root folder title exactly as Hyper does, which is also how a
 * preference arrives from another device through sync.
 */
export async function saveHyperPreference<Key extends keyof HyperPreferences>(
  worker: Worker,
  key: Key,
  value: HyperPreferences[Key],
): Promise<void> {
  let root: BookmarkNode | undefined;
  // Right after launch the root appears only once the worker's startup reconcile
  // repairs the structure, which can outlast an assertion timeout while four
  // browsers start at once.
  await expect.poll(async () => {
    root = findHyperRootFolder(await bookmarkTree(worker));
    return root !== undefined;
  }, { message: 'Hyper never created its root bookmark folder.', timeout: 15_000 }).toBe(true);
  await callChrome(worker, 'bookmarks.update', root!.id, { title: hyperRootTitleWithPreferences(root!, { [key]: value }) });
}
