import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  bookmarkTitleWithCustomName,
  tabBackingBookmarkLink,
  tabBackingTitleWithBookmarkLink,
  type BookmarkNode,
} from './bookmarks';
import type { HyperModelSnapshot, HyperModelStore } from './model';
import type { HyperModelPortClient } from './modelPort';
import type { TabBookmarkLink } from './tabBookmarkLink';
import { createTimedMessages } from './timedMessages';
import { createTabBookmarkLinkController } from './tabBookmarkLinkController';
import { renameTabBackingBookmark } from './bookmarkStorage';
import { renameTabDocumentTitle } from './tabDocumentTitle';

vi.mock('./bookmarkStorage', async (importOriginal) => ({
  ...await importOriginal<typeof import('./bookmarkStorage')>(),
  renameTabBackingBookmark: vi.fn(async () => undefined),
}));
vi.mock('./tabDocumentTitle', () => ({ renameTabDocumentTitle: vi.fn(async () => true) }));

const WINDOW_ID = 1;
const TAB_ID = 7;
const DOCS_URL = 'https://example.com/docs';
const client: HyperModelPortClient = { clientId: 'sidebar', role: 'sidebar', windowId: WINDOW_ID };

interface FakeTab { linkedBookmarkId?: string; url: string }

/** Tab `TAB_ID` is backed by `backing`, and any other tab by `backing-<id>`. */
const backingIdOf = (tabId: number) => tabId === TAB_ID ? 'backing' : `backing-${tabId}`;

function installBrowser(options: FakeTab, others: Record<number, FakeTab> = {}) {
  const fakes = new Map<number, FakeTab>([
    [TAB_ID, options],
    ...Object.entries(others).map(([tabId, fake]) => [Number(tabId), fake] as const),
  ]);
  const nodes = new Map<string, BookmarkNode>([
    ['docs', { id: 'docs', title: bookmarkTitleWithCustomName({ title: 'Docs' }, 'Team docs'), url: DOCS_URL } as BookmarkNode],
    ...[...fakes].map(([tabId, fake]) => [backingIdOf(tabId), {
      id: backingIdOf(tabId),
      title: tabBackingTitleWithBookmarkLink('Start {"hyper":{"tab":true}}', {
        ...(fake.linkedBookmarkId ? { linkedBookmarkId: fake.linkedBookmarkId } : {}),
      }),
      url: fake.url,
    } as BookmarkNode] as const),
  ]);
  const tabs = new Map([...fakes].map(([tabId, fake]) => [tabId, {
    active: tabId === TAB_ID, id: tabId, incognito: false, status: 'complete', url: fake.url, windowId: WINDOW_ID,
  }]));
  const tab = tabs.get(TAB_ID)!;
  vi.stubGlobal('browser', {
    bookmarks: {
      get: async (id: string) => nodes.has(id) ? [nodes.get(id)] : [],
      update: vi.fn(async (id: string, changes: { title: string }) => {
        nodes.set(id, { ...nodes.get(id)!, ...changes });
      }),
    },
    storage: {
      session: {
        get: async (keys: string | string[]) => Object.fromEntries((typeof keys === 'string' ? [keys] : keys)
          .flatMap((key) => {
            const tabId = Number(key.replace('tabSpaceId:', ''));
            return tabs.has(tabId) ? [[key, { backingId: backingIdOf(tabId), spaceId: 'work' }]] : [];
          })),
      },
    },
    tabs: { get: async (tabId: number) => tabs.get(tabId), query: async () => [...tabs.values()] },
  });
  const navigate = (url: string) => {
    tab.url = url;
    nodes.set('backing', { ...nodes.get('backing')!, url });
  };
  return { navigate, nodes };
}

function controller(modelLinks = new Map<number, TabBookmarkLink>()) {
  const snapshot = {
    derived: { tabBookmarkLinks: modelLinks },
    hyper: { favourites: [], localBookmarksBySpaceId: { work: [{ id: 'docs', title: 'Docs', url: DOCS_URL }] } },
  } as unknown as HyperModelSnapshot;
  const messages = createTimedMessages({ reconcile: async () => undefined });
  return Object.assign(createTabBookmarkLinkController({
    messages,
    queueMutation: (operation) => operation(),
    store: { get: () => snapshot } as unknown as HyperModelStore,
  }), { messages });
}

const linkOf = (nodes: Map<string, BookmarkNode>, tabId = TAB_ID) =>
  tabBackingBookmarkLink(nodes.get(backingIdOf(tabId))!);

describe('tab bookmark link controller', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('links a tab that reaches a bookmark page by itself, with an opt-out message', async () => {
    const fake = installBrowser({ url: 'https://example.com/start' });
    const links = controller();

    await links.followNavigation(TAB_ID, 'https://example.com/start', async () => fake.navigate(DOCS_URL));

    expect(linkOf(fake.nodes)).toEqual({ linkedBookmarkId: 'docs' });
    expect(links.messages.current(WINDOW_ID)).toMatchObject({
      detail: 'Linked to Docs',
      kind: 'opt-out',
      tabId: TAB_ID,
      text: 'Linked to bookmark',
    });
  });

  it('keeps the link silently when the tab drifts within the bookmark domain', async () => {
    const fake = installBrowser({ url: DOCS_URL });
    const links = controller();

    await links.followNavigation(TAB_ID, DOCS_URL, async () => fake.navigate('https://example.com/other'));

    expect(linkOf(fake.nodes)).toEqual({ linkedBookmarkId: 'docs' });
    expect(links.messages.current(WINDOW_ID)).toBeUndefined();
  });

  it('ends the link when the tab leaves the bookmark domain', async () => {
    const fake = installBrowser({ linkedBookmarkId: 'docs', url: 'https://example.com/other' });

    await controller().followNavigation(TAB_ID, 'https://example.com/other', async () => fake.navigate('https://elsewhere.test/'));

    expect(linkOf(fake.nodes)).toEqual({});
  });

  it('unlinks when its cross is pressed and does not relink the same bookmark', async () => {
    const fake = installBrowser({ url: 'https://example.com/start' });
    const links = controller();
    await links.followNavigation(TAB_ID, 'https://example.com/start', async () => fake.navigate(DOCS_URL));

    await links.messages.handlers.actOnTimedMessage.run(
      { messageId: links.messages.current(WINDOW_ID)!.id },
      client,
    );
    await links.followNavigation(TAB_ID, DOCS_URL, async () => undefined);

    expect(linkOf(fake.nodes)).toEqual({ declinedBookmarkId: 'docs' });
    expect(links.messages.current(WINDOW_ID)).toBeUndefined();
  });

  it('unlinks tabs that drifted from a bookmark once it is opened in another tab', async () => {
    const fake = installBrowser({ url: DOCS_URL }, {
      8: { linkedBookmarkId: 'docs', url: 'https://example.com/other' },
      9: { linkedBookmarkId: 'docs', url: DOCS_URL },
    });
    const links = controller(new Map([
      [8, { bookmarkId: 'docs', drifted: true, persisted: true }],
      [9, { bookmarkId: 'docs', drifted: false, persisted: true }],
    ]));

    await links.claim(TAB_ID);

    expect(linkOf(fake.nodes)).toEqual({ linkedBookmarkId: 'docs' });
    expect(linkOf(fake.nodes, 8)).toEqual({ declinedBookmarkId: 'docs' });
    // Another tab on the bookmark's exact page is as good a match, so it keeps its link.
    expect(linkOf(fake.nodes, 9)).toEqual({ linkedBookmarkId: 'docs' });
  });

  it('returns a linked tab and its bookmark to the page title when the name is cleared', async () => {
    const fake = installBrowser({ linkedBookmarkId: 'docs', url: DOCS_URL });
    const tab = await browser.tabs.get(TAB_ID);
    const location = { backingId: 'backing', backingToken: 'token', spaceId: 'work', windowId: WINDOW_ID };

    await controller().renameTab({ ...tab, title: 'Team docs' }, '  ', location);

    expect(renameTabBackingBookmark).toHaveBeenCalledWith('backing', '', location, 'Start');
    expect(fake.nodes.get('docs')?.title).toBe('Start');
    expect(renameTabDocumentTitle).toHaveBeenCalledWith(TAB_ID, 'Start');
  });

  it('keeps a bookmark name when its page is not open to title it', async () => {
    const fake = installBrowser({ url: 'https://example.com/other' });
    const links = controller();

    await links.renameBookmark('docs', '');
    expect(fake.nodes.get('docs')?.title).toBe(bookmarkTitleWithCustomName({ title: 'Docs' }, 'Team docs'));

    fake.navigate(DOCS_URL);
    await links.renameBookmark('docs', '');
    expect(fake.nodes.get('docs')?.title).toBe('Start');
  });

  it('renames the linked bookmark with its tab', async () => {
    const fake = installBrowser({ linkedBookmarkId: 'docs', url: DOCS_URL });

    await controller().renameLinkedBookmark(TAB_ID, 'Handbook');

    expect(fake.nodes.get('docs')?.title).toBe(bookmarkTitleWithCustomName({ title: 'Docs' }, 'Handbook'));
  });

  it('records an inferred link only once a tab has settled', async () => {
    const fake = installBrowser({ url: DOCS_URL });
    const links = controller();
    const snapshot = (status: string) => ({
      browser: { tabs: [{ id: TAB_ID, status }] },
      derived: { tabBookmarkLinks: new Map([[TAB_ID, { bookmarkId: 'docs', drifted: false, persisted: false }]]) },
      runtime: { tabOwnerships: { [TAB_ID]: { backingId: 'backing', spaceId: 'work' } } },
    }) as unknown as HyperModelSnapshot;

    links.recordInferredLinks(snapshot('loading'));
    await Promise.resolve();
    expect(linkOf(fake.nodes)).toEqual({});

    links.recordInferredLinks(snapshot('complete'));
    await vi.waitFor(() => expect(linkOf(fake.nodes)).toEqual({ linkedBookmarkId: 'docs' }));
  });
});
