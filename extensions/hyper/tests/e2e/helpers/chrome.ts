import { expect, type Worker } from '@playwright/test';
import type { ExtensionGlobal } from './extensionGlobal';

/**
 * Calls one extension API method in the service worker, such as
 * `callChrome(worker, 'tabs.update', tabId, { active: true })`, and returns its result.
 */
export function callChrome<Result = unknown>(
  worker: Worker,
  method: string,
  ...args: unknown[]
): Promise<Result> {
  return worker.evaluate(async ({ args: callArgs, method: path }) => {
    type Api = { [member: string]: Api } & ((...values: unknown[]) => Promise<unknown>);
    const names = path.split('.');
    const name = names.pop()!;
    const api = names.reduce<Api | undefined>(
      (scope, member) => scope?.[member],
      (globalThis as unknown as { chrome: Api }).chrome,
    );
    if (typeof api?.[name] !== 'function') throw new Error(`chrome.${path} is not available`);
    return api[name](...callArgs);
  }, { args, method }) as Promise<Result>;
}

export interface BookmarkNode {
  children?: BookmarkNode[];
  id: string;
  index?: number;
  parentId?: string;
  title: string;
  url?: string;
}

/** A bookmark title without Hyper's trailing metadata. */
export const visibleTitle = (title: string) => title.replace(/\s+\{.*$/, '');

export const bookmarkParentId = async (worker: Worker, id: string) =>
  (await callChrome<BookmarkNode[]>(worker, 'bookmarks.get', id))[0]?.parentId;

export const bookmarkTitle = async (worker: Worker, id: string) =>
  (await callChrome<BookmarkNode[]>(worker, 'bookmarks.get', id))[0]?.title;

/** The first space under the bar's `hyper/spaces`, once the extension has created it. */
export async function firstSpaceId(worker: Worker): Promise<string> {
  let spaceId: string | undefined;
  await expect.poll(async () => {
    const [root] = await callChrome<BookmarkNode[]>(worker, 'bookmarks.getTree');
    const hyper = root?.children?.[0]?.children?.find((node) => node.title === 'hyper');
    spaceId = hyper?.children?.find((node) => node.title === 'spaces')?.children?.[0]?.id;
    return spaceId;
  }).toBeDefined();
  return spaceId as string;
}

/** The nodes and all their descendants, depth-first in tree order. */
export const bookmarkDescendants = (nodes: BookmarkNode[]): BookmarkNode[] =>
  nodes.flatMap((node) => [node, ...bookmarkDescendants(node.children ?? [])]);

/** Every bookmark node, depth-first in tree order, from one `getTree` call. */
export const allBookmarks = async (worker: Worker) =>
  bookmarkDescendants(await callChrome<BookmarkNode[]>(worker, 'bookmarks.getTree'));

export const bookmarkChildren = (worker: Worker, parentId: string) =>
  callChrome<BookmarkNode[]>(worker, 'bookmarks.getChildren', parentId);

export interface BookmarkSeed {
  children?: BookmarkSeed[];
  /** Names the created node's ID in the returned record. */
  key?: string;
  /** Makes this folder its parent space's bookmarks or tabs root; `title` is then ignored. */
  spaceRoot?: 'bookmarks' | 'tabs';
  title?: string;
  url?: string;
}

/**
 * Creates the seeds depth first under `parentId`, else Chrome's bookmark bar, in
 * one evaluation, and returns the IDs of the keyed nodes.
 */
export async function seedBookmarks<Key extends string = never>(
  worker: Worker,
  seeds: BookmarkSeed[],
  parentId?: string,
): Promise<Record<Key, string>> {
  return worker.evaluate(async ({ parentId: rootId, roots }) => {
    type Seed = typeof roots[number];
    const { bookmarks } = (globalThis as unknown as ExtensionGlobal).chrome;
    const parent = rootId ?? (await bookmarks.getTree())[0]?.children?.[0]?.id;
    if (!parent) throw new Error('Chrome bookmark bar was not created');
    const ids: Record<string, string> = {};
    const create = async (seed: Seed, parentId: string) => {
      const title = seed.spaceRoot === 'bookmarks'
        ? `bookmarks ${JSON.stringify({ hyper: { spaceBookmarks: true, spaceId: parentId } })}`
        : seed.spaceRoot === 'tabs'
          ? `tabs ${JSON.stringify({ hyper: { spaceTabs: true, spaceId: parentId } })}`
          : seed.title ?? '';
      const node = await bookmarks.create({
        parentId,
        title,
        ...(seed.url === undefined ? {} : { url: seed.url }),
      });
      if (seed.key) ids[seed.key] = node.id;
      for (const child of seed.children ?? []) await create(child, node.id);
    };
    for (const seed of roots) await create(seed, parent);
    return ids;
  }, { parentId, roots: seeds }) as Record<Key, string>;
}

/**
 * Hyper's folder with favourites, an optional global bookmarks folder and one
 * space. Keys: `hyper`, `favourites`, `globalBookmarks`, `spaces`, `space`,
 * `spaceTabs` and `spaceBookmarks`, besides any keys in the given children.
 */
export function hyperSeed({
  bookmarks = [],
  favourites = [],
  globalBookmarks,
  space = 'Space',
  tabs,
}: {
  bookmarks?: BookmarkSeed[];
  favourites?: BookmarkSeed[];
  globalBookmarks?: BookmarkSeed[];
  space?: string;
  /** Gives the space a tabs root, before its bookmarks root, holding these. */
  tabs?: BookmarkSeed[];
} = {}): BookmarkSeed {
  return {
    key: 'hyper',
    title: 'hyper',
    children: [
      { key: 'favourites', title: 'favourites', children: favourites },
      ...globalBookmarks ? [{ key: 'globalBookmarks', title: 'bookmarks', children: globalBookmarks }] : [],
      {
        key: 'spaces',
        title: 'spaces',
        children: [{
          key: 'space',
          title: space,
          children: [
            ...tabs ? [{ key: 'spaceTabs', spaceRoot: 'tabs' as const, children: tabs }] : [],
            { key: 'spaceBookmarks', spaceRoot: 'bookmarks', children: bookmarks },
          ],
        }],
      },
    ],
  };
}

type HyperSeedKey = 'favourites' | 'globalBookmarks' | 'hyper' | 'space' | 'spaceBookmarks' | 'spaces' | 'spaceTabs';

/** Seeds `hyperSeed(options)` and returns its keyed IDs. */
export const seedHyperSpace = <Key extends string = never>(
  worker: Worker,
  options?: Parameters<typeof hyperSeed>[0],
) => seedBookmarks<Key | HyperSeedKey>(worker, [hyperSeed(options)]);
