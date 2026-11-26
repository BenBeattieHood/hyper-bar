import { describe, expect, it } from 'vitest';
import {
  bookmarkTitleWithCustomName,
  bookmarkTitleWithoutCustomName,
  tabBackingBookmarkTitle,
  tabBackingPageTitle,
  tabBackingTitleLeavingDomain,
  tabBackingTitleWithBookmarkLink,
  tabBackingTitleWithName,
  tabBackingTitleWithoutName,
  visibleBookmarkTitle,
  type BookmarkNode,
} from './bookmarks';
import {
  deriveTabBookmarkLink,
  deriveTabBookmarkState,
  deriveTabName,
  deriveTabTitle,
  isAppliedTabName,
  indexLinkableBookmarks,
  tabNameText,
  tabPageTitle,
} from './tabBookmarkLink';
import { testBookmark, testFolder } from './testBookmarkTree';
import { testTab } from './testFixtures';

const bookmark = (id: string, url: string) => testBookmark(id, 'Page', url);

const named = (node: BookmarkNode, name: string): BookmarkNode =>
  ({ ...node, title: bookmarkTitleWithCustomName(node, name) });

const backing = (url: string, link: { linkedBookmarkId?: string; declinedBookmarkId?: string } = {}) =>
  ({ id: 'backing', title: tabBackingTitleWithBookmarkLink('Page {"hyper":{"tab":true}}', link), url } as BookmarkNode);

describe('tab bookmark links', () => {
  const docs = bookmark('docs', 'https://example.com/docs');
  const favourite = bookmark('fav', 'https://example.com/docs');

  it('prefers the space bookmarks to favourites, and nests none', () => {
    const folder = testFolder('folder', 'Folder', undefined, [docs]);
    const indexed = indexLinkableBookmarks([folder], [favourite]);
    expect([...indexed.byId.keys()]).toEqual(['docs', 'fav']);
    expect(indexed.byPage.get('https://example.com/docs')?.map((node) => node.id)).toEqual(['docs', 'fav']);
  });

  it('ranks global bookmarks after the space bookmarks and favourites', () => {
    const global = bookmark('global', 'https://example.com/docs');
    const indexed = indexLinkableBookmarks([docs], [favourite], [global]);
    expect(indexed.byPage.get('https://example.com/docs')?.map((node) => node.id))
      .toEqual(['docs', 'fav', 'global']);
  });

  it('links a tab in any space to a drifted global bookmark', () => {
    const global = bookmark('global', 'https://example.com/docs');
    const state = deriveTabBookmarkState({
      backingNodes: new Map([['backing', backing('https://example.com/other', { linkedBookmarkId: 'global' })]]),
      favourites: [],
      globalBookmarks: [testFolder('folder', 'Folder', undefined, [global])],
      localBookmarksBySpaceId: {},
      ownerships: { 1: { backingId: 'backing', spaceId: 'any' } },
      tabs: [testTab({ id: 1, url: 'https://example.com/other' })],
    });
    expect(state.links.get(1)).toEqual({ bookmarkId: 'global', drifted: true, persisted: true });
  });

  it('links an exact page without recording it', () => {
    expect(deriveTabBookmarkLink(
      'https://example.com/docs',
      backing('https://example.com/docs'),
      indexLinkableBookmarks([docs], []),
    )).toEqual({ bookmarkId: 'docs', drifted: false, persisted: false });
  });

  it('keeps a recorded link while the tab stays on the bookmark domain', () => {
    expect(deriveTabBookmarkLink(
      'https://example.com/other',
      backing('https://example.com/other', { linkedBookmarkId: 'docs' }),
      indexLinkableBookmarks([docs], []),
    )).toEqual({ bookmarkId: 'docs', drifted: true, persisted: true });
  });

  it('drops a recorded link once the tab leaves the domain', () => {
    expect(deriveTabBookmarkLink(
      'https://elsewhere.test/',
      backing('https://elsewhere.test/', { linkedBookmarkId: 'docs' }),
      indexLinkableBookmarks([docs], []),
    )).toBeUndefined();
  });

  it('does not relink a bookmark the user unlinked', () => {
    expect(deriveTabBookmarkLink(
      'https://example.com/docs',
      backing('https://example.com/docs', { declinedBookmarkId: 'docs' }),
      indexLinkableBookmarks([docs], [favourite]),
    )).toEqual({ bookmarkId: 'fav', drifted: false, persisted: false });
  });
});

describe('tab names', () => {
  const docs = named(bookmark('docs', 'https://example.com/docs'), 'Team docs');

  it('takes a linked bookmark name and marks a drifted tab', () => {
    const link = { bookmarkId: 'docs', drifted: true, persisted: true };
    const name = deriveTabName('https://example.com/other', link, docs, undefined);
    expect(name).toEqual({ drifted: true, source: 'bookmark', title: 'Team docs' });
    expect(tabNameText(name!)).toBe('Team docs*');
  });

  it('ignores a bookmark title that only follows its page', () => {
    const link = { bookmarkId: 'plain', drifted: false, persisted: false };
    expect(deriveTabName('https://example.com/', link, bookmark('plain', 'https://example.com/'), undefined))
      .toBeUndefined();
  });

  it('keeps a tab name only on the site it was given on', () => {
    const renamed = named(backing('https://example.com/a'), 'Mine');
    expect(deriveTabName('https://example.com/b', undefined, undefined, renamed))
      .toEqual({ drifted: false, source: 'tab', title: 'Mine' });
    expect(deriveTabName('https://elsewhere.test/', undefined, undefined, renamed)).toBeUndefined();
  });

  it('strips the name and link when a backing leaves its domain', () => {
    const left = { title: tabBackingTitleLeavingDomain(named(backing('https://example.com/', { linkedBookmarkId: 'docs' }), 'Mine').title) };
    expect(left.title).not.toContain('isCustomName');
    expect(left.title).not.toContain('linkedBookmarkId');
    expect(left.title).toContain('"tab":true');
  });

  it('keeps a named backing page title beside its name, and returns to it', () => {
    const page = { title: 'Docs - Example {"hyper":{"tab":true}}' };
    const named = { title: tabBackingTitleWithName(page, 'Mine') };
    expect(visibleBookmarkTitle(named)).toBe('Mine');
    expect(tabBackingPageTitle(named)).toBe('Docs - Example');

    // The page retitles itself while named; the name stays and the page title follows.
    const retitled = { title: tabBackingBookmarkTitle('Docs v2 - Example', 0, 'token', 'work', named.title) };
    expect(visibleBookmarkTitle(retitled)).toBe('Mine');
    expect(tabBackingPageTitle(retitled)).toBe('Docs v2 - Example');
    // The tab strip showing the name is not the page retitling itself.
    const echoed = { title: tabBackingBookmarkTitle('Mine', 0, 'token', 'work', retitled.title) };
    expect(tabBackingPageTitle(echoed)).toBe('Docs v2 - Example');

    const unnamed = { title: tabBackingTitleWithoutName(echoed, 'https://example.com/') };
    expect(visibleBookmarkTitle(unnamed)).toBe('Docs v2 - Example');
    expect(unnamed.title).not.toContain('isCustomName');
    expect(unnamed.title).not.toContain('pageTitle');
  });

  it('returns a bookmark to its page title, or keeps its words until the page is known', () => {
    const custom = { title: bookmarkTitleWithCustomName({ title: 'Docs' }, 'Team docs') };
    expect(bookmarkTitleWithoutCustomName(custom, 'Docs v2')).toBe('Docs v2');
    expect(bookmarkTitleWithoutCustomName(custom)).toBe('Team docs');
  });

  it('recognises a title Hyper applied from the linked bookmark', () => {
    expect(isAppliedTabName('Team docs*', docs)).toBe(true);
    expect(isAppliedTabName('Team docs', docs)).toBe(true);
    expect(isAppliedTabName('Docs - Example', docs)).toBe(false);
  });

  it('derives links and names for owned tabs only', () => {
    const state = deriveTabBookmarkState({
      backingNodes: new Map([['backing', backing('https://example.com/docs')]]),
      favourites: [],
      localBookmarksBySpaceId: { work: [docs] },
      ownerships: { 1: { backingId: 'backing', spaceId: 'work' } },
      tabs: [
        testTab({ id: 1, url: 'https://example.com/docs' }),
        testTab({ id: 2, url: 'https://example.com/docs' }),
      ],
    });
    expect([...state.links.keys()]).toEqual([1]);
    expect(state.names.get(1)).toEqual({ drifted: false, source: 'bookmark', title: 'Team docs' });
  });
});

describe('tab titles', () => {
  const url = 'https://example.com/docs';
  const pageBacking = (title: string) =>
    ({ id: 'backing', title: tabBackingBookmarkTitle(title), url } as BookmarkNode);

  it('keeps the last known page title while the browser shows only a placeholder', () => {
    const kept = pageBacking('Docs page');
    expect(tabPageTitle('example.com', url, kept, undefined)).toBe('Docs page');
    expect(tabPageTitle('', url, kept, undefined)).toBe('Docs page');
    expect(tabPageTitle('New docs', url, kept, undefined)).toBe('New docs');
    expect(tabPageTitle('example.com', 'https://example.com/other', kept, undefined)).toBe('example.com');
    expect(tabPageTitle(undefined, url, undefined, undefined)).toBe(url);
  });

  it('never takes a name Hyper applied as the page title', () => {
    const kept = tabBackingTitleWithName(pageBacking('Docs page'), 'Mine');
    const namedBacking = { id: 'backing', title: kept, url } as BookmarkNode;
    expect(tabPageTitle('Mine', url, namedBacking, undefined)).toBe('Docs page');
    const linked = named(bookmark('docs', url), 'Team docs');
    expect(tabPageTitle('Team docs*', url, pageBacking('Docs page'), linked)).toBe('Docs page');
  });

  it('calls a tab by its name, else its kept page title, else what the browser reports', () => {
    const tab = testTab({ id: 1, title: 'example.com', url });
    expect(deriveTabTitle(tab, pageBacking('Docs page'), { drifted: true, source: 'bookmark', title: 'Team docs' }))
      .toBe('Team docs*');
    expect(deriveTabTitle(tab, pageBacking('Docs page'), undefined)).toBe('Docs page');
    expect(deriveTabTitle(testTab({ id: 1, title: 'Live', url }), undefined, undefined)).toBe('Live');
  });

  it('does not show a backing title after its tab has left that page', () => {
    expect(deriveTabTitle(
      testTab({ id: 1, title: 'Other page', url: 'https://example.com/other' }),
      pageBacking('Docs page'),
      undefined,
    )).toBe('Other page');
  });

  it('derives every tab title and each backed tab page title', () => {
    const state = deriveTabBookmarkState({
      backingNodes: new Map([['backing', pageBacking('Docs page')]]),
      favourites: [],
      localBookmarksBySpaceId: {},
      ownerships: { 1: { backingId: 'backing', spaceId: 'work' } },
      tabs: [
        testTab({ id: 1, title: 'example.com', url }),
        testTab({ id: 2, title: 'Loose tab', url }),
      ],
    });
    expect(Object.fromEntries(state.titles)).toEqual({ 1: 'Docs page', 2: 'Loose tab' });
    expect(Object.fromEntries(state.pageTitles)).toEqual({ 1: 'Docs page' });
  });
});
