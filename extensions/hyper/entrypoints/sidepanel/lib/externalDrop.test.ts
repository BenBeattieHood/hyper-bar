import { describe, expect, it, vi } from 'vitest';
import type { BookmarkNode } from '../../lib/bookmarks';
import type { DragItemData } from '../types';
import type { TreeDropIntent } from './dropActions';
import {
  externalDragItem,
  externalDropContents,
  externalDropLands,
  externalDropPlan,
  htmlLinkTitles,
  mozUrlPages,
  performExternalDrop,
  snapshotExternalDrop,
  type ExternalDropContents,
  type ExternalDropSnapshot,
} from './externalDrop';

const snapshot = (parts: Partial<ExternalDropSnapshot> = {}): ExternalDropSnapshot => ({
  files: [],
  html: '',
  mozUrl: '',
  text: '',
  uriList: '',
  ...parts,
});

const page = (url: string, title = url) => ({ title, url });
const contents = (...urls: string[]): ExternalDropContents => ({ pages: urls.map((url) => page(url)), unlinkable: [] });
const node = { id: 'taken' } as BookmarkNode;
const places = {
  bookmarksRootId: 'space-root',
  favouriteSlots: [node, undefined, node, undefined, undefined],
  favouritesFolderId: 'favourites',
  globalBookmarksRootId: 'global',
};

describe('external drops', () => {
  it('shows a link, a file, or how many files is dragging, all that is known before the drop', () => {
    const items = (...kinds: string[]) => kinds.map((kind) => ({ kind })) as unknown as DataTransferItemList;
    expect(externalDragItem({ items: items('string', 'string'), types: ['text/uri-list'] }))
      .toEqual({ files: 0, itemCount: 1, kind: 'external', title: 'Link' });
    expect(externalDragItem({ items: items('file'), types: ['Files'] }).title).toBe('File');
    expect(externalDragItem({ items: items('file', 'file', 'file'), types: ['Files'] }))
      .toEqual({ files: 3, itemCount: 3, kind: 'external', title: '3 files' });
  });

  it('copies what a drop holds, even when a format cannot be read', () => {
    const file = new File(['x'], 'a.url');
    const read = snapshotExternalDrop({
      files: [file] as unknown as FileList,
      getData: (type: string) => {
        if (type === 'text/x-moz-url') throw new Error('unsupported');
        return type === 'text/uri-list' ? 'https://example.com/' : '';
      },
    });
    expect(read).toEqual(snapshot({ files: [file], uriList: 'https://example.com/' }));
  });

  it('takes links from a URI list or Firefox\'s format, titled by the dragged HTML', async () => {
    expect(htmlLinkTitles('<a href="https://a.example/?x=1&amp;y=2"><b>Alpha</b>&nbsp;page</a><a href=x>no</a>'))
      .toEqual(new Map([['https://a.example/?x=1&y=2', 'Alpha page']]));
    expect(mozUrlPages('https://a.example/\nAlpha\nnot a url\nignored\nhttps://b.example/\n'))
      .toEqual([page('https://a.example/', 'Alpha'), page('https://b.example/')]);

    const read = await externalDropContents(snapshot({
      html: '<a href="https://b.example/">Beta</a>',
      text: 'https://ignored.example/',
      uriList: '# comment\r\nhttps://a.example/\r\nhttps://b.example/\r\nhttps://a.example/',
    }));
    expect(read).toEqual({ pages: [page('https://a.example/'), page('https://b.example/', 'Beta')], unlinkable: [] });
  });

  it('falls back to addresses in dragged text, and finds none in prose', async () => {
    expect((await externalDropContents(snapshot({ text: '  https://a.example/ \nhttps://b.example/' }))).pages.map((p) => p.url))
      .toEqual(['https://a.example/', 'https://b.example/']);
    expect(await externalDropContents(snapshot({ text: 'just some words' })))
      .toEqual({ pages: [], unlinkable: [] });
  });

  it('reads shortcut files, and names other files only when nothing else could be linked', async () => {
    const shortcut = new File(['[InternetShortcut]\nURL=https://docs.example/\n'], 'Docs.url');
    const photo = new File(['jpeg'], 'photo.jpg');
    expect(await externalDropContents(snapshot({ files: [shortcut, photo] })))
      .toEqual({ pages: [page('https://docs.example/', 'Docs')], unlinkable: ['photo.jpg'] });
    // A dragged image brings its file beside its address.
    expect(await externalDropContents(snapshot({ files: [photo], uriList: 'https://img.example/p.jpg' })))
      .toEqual({ pages: [page('https://img.example/p.jpg')], unlinkable: [] });
  });

  it('lands wherever a bookmark could be made or a tab opened', () => {
    const lands = (kind: string) => externalDropLands({ kind } as DragItemData);
    for (const kind of ['tree', 'tree-zone', 'favourite-slot', 'global-bookmarks', 'space', 'tabs-zone', 'tab']) {
      expect(lands(kind)).toBe(true);
    }
    for (const kind of ['trash', 'session-zone', 'session-tab']) expect(lands(kind)).toBe(false);
  });

  it('bookmarks into a tree where the drop shows, or last in a folder', () => {
    const tree = { kind: 'tree', nodeId: 'n' } as DragItemData;
    const treeDrop = { destination: { index: 3, parentId: 'folder' }, invalid: false } as TreeDropIntent;
    expect(externalDropPlan(contents('https://a.example/'), { target: tree, treeDrop }, places)).toEqual({
      index: 3,
      kind: 'bookmark-pages',
      pages: [page('https://a.example/')],
      parentId: 'folder',
    });
    expect(externalDropPlan(contents('https://a.example/'), { target: tree }, places)).toBeUndefined();
    expect(externalDropPlan(
      contents('https://a.example/'),
      { target: { index: 7, kind: 'tree-zone', parentId: 'root' } as DragItemData },
      places,
    )).toMatchObject({ index: 7, parentId: 'root' });
    expect(externalDropPlan(contents('https://a.example/'), { target: { kind: 'bookmarks-trigger' } as DragItemData }, places))
      .toEqual({ kind: 'bookmark-pages', pages: [page('https://a.example/')], parentId: 'space-root' });
    expect(externalDropPlan(contents('https://a.example/'), { target: { kind: 'global-bookmarks' } as DragItemData }, places))
      .toMatchObject({ parentId: 'global' });
  });

  it('pins into the slot dropped on, then the empty ones, and says when they run out', () => {
    const slot = { index: 2, kind: 'favourite-slot' } as DragItemData;
    expect(externalDropPlan(contents('https://a.example/', 'https://b.example/'), { target: slot }, places))
      .toMatchObject({ favouriteSlots: [2, 1], parentId: 'favourites' });
    expect(externalDropPlan(contents('https://a.example/'), { target: { kind: 'favourite-zone' } as DragItemData }, places))
      .toMatchObject({ favouriteSlots: [1] });
    const five = contents(...['a', 'b', 'c', 'd', 'e'].map((name) => `https://${name}.example/`));
    expect(externalDropPlan(five, { target: slot }, places))
      .toEqual({ kind: 'notice', message: 'There are not enough favourite slots' });
    expect(externalDropPlan(
      contents('https://a.example/'),
      { target: { kind: 'favourite-zone' } as DragItemData },
      { ...places, favouriteSlots: [node, node] },
    )).toEqual({ kind: 'notice', message: 'Favourites are full' });
  });

  it('opens tabs in the space dropped on, or the one shown', () => {
    expect(externalDropPlan(contents('https://a.example/'), { target: { kind: 'space', spaceId: 's2' } as DragItemData }, places))
      .toEqual({ activate: true, kind: 'open-pages', pages: [page('https://a.example/')], spaceId: 's2' });
    expect(externalDropPlan(contents('https://a.example/'), { target: { kind: 'tabs-zone' } as DragItemData }, places))
      .toEqual({ activate: true, kind: 'open-pages', pages: [page('https://a.example/')] });
  });

  it('explains a drop with nothing to link', () => {
    const target = { kind: 'tabs-zone' } as DragItemData;
    expect(externalDropPlan({ pages: [], unlinkable: [] }, { target }, places))
      .toEqual({ kind: 'notice', message: 'There is no link there to add' });
    expect(externalDropPlan({ pages: [], unlinkable: ['a.pdf'] }, { target }, places)).toMatchObject({
      message: expect.stringMatching(/^“a\.pdf” is a file, and browsers do not say where a dropped file is kept\./),
    });
    expect(externalDropPlan({ pages: [], unlinkable: ['a', 'b'] }, { target }, places)).toMatchObject({
      message: expect.stringMatching(/^2 of those are files/),
    });
  });

  it('adds what it read as one intent, then names the files it could not link', async () => {
    const submitSelection = vi.fn(async () => [{ created: true }]);
    const showNotice = vi.fn();
    await performExternalDrop(
      snapshot({ files: [new File(['[InternetShortcut]\nURL=https://docs.example/\n'], 'Docs.url'), new File(['x'], 'a.pdf')] }),
      { target: { kind: 'tabs-zone' } as DragItemData },
      { activeSpaceId: 's1', browserState: { submitSelection } as never, places, showNotice },
    );
    expect(submitSelection).toHaveBeenCalledExactlyOnceWith('openBookmark', [{
      active: true,
      destinationSpaceId: 's1',
      forceNew: true,
      reuse: 'browser',
      url: 'https://docs.example/',
    }]);
    expect(showNotice).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/^“a\.pdf” is a file/), 'warning');
  });
});
