import { describe, expect, it } from 'vitest';
import { recentlyClosedTabsFromSessions } from './recentlyClosed';
import { testTab } from './testFixtures';

describe('recentlyClosedTabsFromSessions', () => {
  it('keeps closed web pages in session order and drops windows, private tabs, and browser pages', () => {
    const closed = (sessionId: string, url: string, extra: Partial<Browser.tabs.Tab> = {}) =>
      ({ tab: testTab({ sessionId, url, title: `${sessionId} title`, ...extra }) });

    expect(recentlyClosedTabsFromSessions([
      closed('a', 'https://one.test/', { favIconUrl: 'https://one.test/icon.png' }),
      { window: {} } as { tab?: Browser.tabs.Tab },
      closed('b', 'https://private.test/', { incognito: true }),
      closed('c', 'chrome-extension://hyper/newtab.html'),
      closed('e', 'about:blank'),
      closed('d', 'https://two.test/', { title: '' }),
    ], 'chrome-extension://hyper/')).toEqual([
      {
        favIconUrl: 'https://one.test/icon.png',
        sessionId: 'a',
        title: 'a title',
        url: 'https://one.test/',
      },
      { sessionId: 'd', title: 'https://two.test/', url: 'https://two.test/' },
    ]);
  });
});
