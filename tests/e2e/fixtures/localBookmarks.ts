import { expect, type Worker } from '@playwright/test';
import { isSpaceBookmarksFolder } from '../../../entrypoints/lib/bookmarks';
import { callChrome } from '../helpers/chrome';

/**
 * Binds the end-to-end suite to the production local-bookmark contract. Seeding
 * through these helpers puts fixtures in the same root the extension writes to,
 * so a seeded bookmark cannot be parked where the sidebar will never show it.
 */
export async function localBookmarksRootIds(
  worker: Worker,
  spaceIds: readonly string[],
): Promise<Record<string, string | null>> {
  const childrenBySpaceId = await Promise.all(spaceIds.map(async (spaceId) => [
    spaceId,
    await callChrome<Array<{ id: string; title: string; url?: string }>>(worker, 'bookmarks.getChildren', spaceId),
  ] as const));
  return Object.fromEntries(childrenBySpaceId.map(([spaceId, children]) => [
    spaceId,
    children.find((node) => isSpaceBookmarksFolder(node))?.id ?? null,
  ]));
}

export async function localBookmarksRootId(
  worker: Worker,
  spaceId: string,
): Promise<string> {
  let rootId: string | null = null;
  await expect.poll(async () => {
    rootId = (await localBookmarksRootIds(worker, [spaceId]))[spaceId] ?? null;
    return rootId !== null;
  }, { message: `Space ${spaceId} never gained a local bookmarks root.` }).toBe(true);
  return rootId as unknown as string;
}
