import type { BookmarkNode } from '../../lib/bookmarks';
import { pageUrlFromText } from '../../lib/urlIdentity';
import type { DragItemData } from '../types';
import type { TreeDropIntent } from './dropActions';
import { pastedPages, type ClipboardPage } from './itemClipboard';
import { carryOutPagePlan, type PagePlan, type PagePlanDependencies } from './pagePlans';
import { decodeEntities, mayBeShortcutFile, shortcutPage } from './shortcutFiles';

export type ExternalDragItem = Extract<DragItemData, { kind: 'external' }>;

/** What a drop from outside Hyper held, copied while the browser still showed it. */
export interface ExternalDropSnapshot {
  files: readonly File[];
  html: string;
  mozUrl: string;
  text: string;
  uriList: string;
}

/** The pages a drop held, and the files in it that could not become links. */
export interface ExternalDropContents {
  pages: ClipboardPage[];
  unlinkable: string[];
}

/** What follows the pointer for a drag from outside: only how many files it holds is known before the drop. */
export function externalDragItem(transfer: Pick<DataTransfer, 'items' | 'types'>): ExternalDragItem {
  const counted = [...transfer.items].filter((item) => item.kind === 'file').length;
  const files = counted > 0 ? counted : transfer.types.includes('Files') ? 1 : 0;
  return {
    kind: 'external',
    files,
    itemCount: Math.max(files, 1),
    title: files === 0 ? 'Link' : files === 1 ? 'File' : `${files} files`,
  };
}

export function snapshotExternalDrop(transfer: Pick<DataTransfer, 'files' | 'getData'>): ExternalDropSnapshot {
  const read = (type: string) => {
    try {
      return transfer.getData(type);
    } catch {
      return '';
    }
  };
  return {
    files: [...transfer.files],
    html: read('text/html'),
    mozUrl: read('text/x-moz-url'),
    text: read('text/plain'),
    uriList: read('text/uri-list'),
  };
}

/** Each linked address in dragged HTML, with the text it was linked from. */
export function htmlLinkTitles(html: string): Map<string, string> {
  const titles = new Map<string, string>();
  for (const match of html.matchAll(/<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a\s*>/gi)) {
    const url = pageUrlFromText(decodeEntities(match[1] ?? match[2] ?? match[3] ?? ''));
    const title = decodeEntities((match[4] ?? '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
    if (url && title && !titles.has(url)) titles.set(url, title);
  }
  return titles;
}

/** A URI list's addresses, skipping its comment lines. */
export function uriListPages(uriList: string): ClipboardPage[] {
  return pastedPages(uriList.split(/\r?\n/).filter((line) => !line.startsWith('#')).join('\n'));
}

/** Firefox's own link format: each address on one line and its title on the next. */
export function mozUrlPages(mozUrl: string): ClipboardPage[] {
  const lines = mozUrl.split(/\r?\n/);
  const pages: ClipboardPage[] = [];
  for (let index = 0; index < lines.length; index += 2) {
    const url = pageUrlFromText(lines[index] ?? '');
    if (url) pages.push({ title: lines[index + 1]?.trim() || url, url });
  }
  return pages;
}

const titled = (page: ClipboardPage) => page.title !== page.url;

/** Every page once, in the order found, each with the best title any format gave it. */
function mergePages(groups: readonly (readonly ClipboardPage[])[], titles: ReadonlyMap<string, string>): ClipboardPage[] {
  const pages = new Map<string, ClipboardPage>();
  for (const page of groups.flat()) {
    const existing = pages.get(page.url);
    if (!existing || !titled(existing) && titled(page)) pages.set(page.url, page);
  }
  return [...pages.values()].map((page) =>
    titled(page) ? page : { title: titles.get(page.url) ?? page.url, url: page.url });
}

/**
 * The pages a drop from outside Hyper holds. Links come from a URI list or
 * Firefox's link format, else from plain text, one address per line, as a
 * paste reads it; dragged HTML only titles them. Shortcut files are read for
 * the page they point at. The browser never says where any other dropped file
 * is kept, so such a file cannot be linked; those are named only when the drop
 * carried no link of its own, as a dragged image brings its file beside its
 * address.
 */
export async function externalDropContents(snapshot: ExternalDropSnapshot): Promise<ExternalDropContents> {
  const linked = [...mozUrlPages(snapshot.mozUrl), ...uriListPages(snapshot.uriList)];
  const fromStrings = linked.length > 0 ? linked : pastedPages(snapshot.text);
  const unlinkable: string[] = [];
  const fromFiles: ClipboardPage[] = [];
  for (const file of snapshot.files) {
    const page = mayBeShortcutFile(file.name, file.size)
      ? shortcutPage(file.name, new Uint8Array(await file.arrayBuffer().catch(() => new ArrayBuffer(0))))
      : undefined;
    if (page) fromFiles.push(page);
    else unlinkable.push(file.name);
  }
  return {
    pages: mergePages([fromStrings, fromFiles], htmlLinkTitles(snapshot.html)),
    unlinkable: fromStrings.length > 0 ? [] : unlinkable,
  };
}

/** Where a drop from outside Hyper can land: anywhere a bookmark could make a bookmark or open a tab. */
export function externalDropLands(target: DragItemData): boolean {
  switch (target.kind) {
    case 'bookmarks-trigger':
    case 'favourite':
    case 'favourite-slot':
    case 'favourite-zone':
    case 'global-bookmarks':
    case 'space':
    case 'tab':
    case 'tab-folder':
    case 'tabs-trigger':
    case 'tabs-zone':
    case 'tree':
    case 'tree-zone':
      return true;
    default:
      return false;
  }
}

/** The folders and slots an external drop may fill, as the sidebar knows them. */
export interface ExternalDropPlaces {
  bookmarksRootId?: string;
  favouriteSlots: readonly (BookmarkNode | undefined)[];
  favouritesFolderId?: string | null;
  globalBookmarksRootId?: string | null;
}

export function unlinkableNotice(names: readonly string[]): string {
  const [only] = names;
  const subject = names.length === 1 && only ? `“${only}” is a file, and` : `${names.length} of those are files, and`;
  return `${subject} browsers do not say where a dropped file is kept. Open it in a tab, then drag the tab here.`;
}

/**
 * What dropping pages from outside Hyper does: on a bookmark tree, a bookmark
 * for each where the drop shows; on the favourites bar, a favourite in that
 * slot and the next empty ones; on a space or the tabs, a tab for each.
 */
export function externalDropPlan(
  contents: ExternalDropContents,
  { target, treeDrop }: { target: DragItemData; treeDrop?: TreeDropIntent },
  places: ExternalDropPlaces,
): PagePlan | { kind: 'notice'; message: string } | undefined {
  const { pages } = contents;
  if (!externalDropLands(target)) return undefined;
  if (pages.length === 0) {
    return {
      kind: 'notice',
      message: contents.unlinkable.length > 0 ? unlinkableNotice(contents.unlinkable) : 'There is no link there to add',
    };
  }
  const bookmark = (parentId: string | null | undefined, index?: number): PagePlan | undefined =>
    parentId ? { kind: 'bookmark-pages', pages, parentId, ...(index === undefined ? {} : { index }) } : undefined;
  switch (target.kind) {
    case 'tree':
      return treeDrop && !treeDrop.invalid
        ? bookmark(treeDrop.destination.parentId, treeDrop.destination.index)
        : undefined;
    case 'tree-zone':
      return bookmark(target.parentId, target.index);
    case 'bookmarks-trigger':
      return bookmark(places.bookmarksRootId);
    case 'global-bookmarks':
      return bookmark(places.globalBookmarksRootId);
    case 'favourite':
    case 'favourite-slot':
    case 'favourite-zone': {
      if (!places.favouritesFolderId) return undefined;
      const preferred = target.kind === 'favourite-zone' ? undefined : target.index;
      const slots = [
        ...(preferred === undefined ? [] : [preferred]),
        ...places.favouriteSlots.flatMap((node, index) => !node && index !== preferred ? [index] : []),
      ];
      if (slots.length < pages.length) {
        return {
          kind: 'notice',
          message: slots.length === 0 ? 'Favourites are full' : 'There are not enough favourite slots',
        };
      }
      return {
        favouriteSlots: slots.slice(0, pages.length),
        kind: 'bookmark-pages',
        pages,
        parentId: places.favouritesFolderId,
      };
    }
    case 'space':
      return { activate: true, kind: 'open-pages', pages, spaceId: target.spaceId };
    default:
      return { activate: true, kind: 'open-pages', pages };
  }
}

/** Reads a drop from outside Hyper and adds what it links to where it landed. */
export async function performExternalDrop(
  snapshot: ExternalDropSnapshot | undefined,
  request: { target: DragItemData; treeDrop?: TreeDropIntent },
  dependencies: PagePlanDependencies & { places: ExternalDropPlaces },
): Promise<void> {
  if (!snapshot || !externalDropLands(request.target)) return;
  const contents = await externalDropContents(snapshot);
  const plan = externalDropPlan(contents, request, dependencies.places);
  if (!plan) return;
  if (plan.kind === 'notice') {
    dependencies.showNotice(plan.message, 'warning');
    return;
  }
  await carryOutPagePlan(plan, dependencies);
  if (contents.unlinkable.length > 0) dependencies.showNotice(unlinkableNotice(contents.unlinkable), 'warning');
}
