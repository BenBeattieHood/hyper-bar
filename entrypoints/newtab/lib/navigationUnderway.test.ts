import { describe, expect, it } from 'vitest';

import { tabNavigationUnderway, underwayText } from './navigationUnderway';

const NEW_TAB = 'chrome-extension://hyper/newtab.html';

describe('underwayText', () => {
  it('shows the words of a search engine query', () => {
    expect(underwayText('https://www.bing.com/search?q=hello+world&form=QBLH')).toBe('hello world');
    expect(underwayText('https://search.yahoo.com/search?p=tides')).toBe('tides');
  });

  it('shows the address of any other page', () => {
    expect(underwayText('https://example.com/docs?page=2')).toBe('https://example.com/docs?page=2');
  });
});

describe('tabNavigationUnderway', () => {
  it('reports a new tab page loading another page', () => {
    expect(tabNavigationUnderway({
      pendingUrl: 'https://www.google.com/search?q=weather',
      status: 'loading',
      url: 'chrome://newtab/',
    }, NEW_TAB)).toBe('weather');
  });

  it('ignores a tab that is not leaving a new tab page', () => {
    expect(tabNavigationUnderway({ status: 'complete', url: NEW_TAB }, NEW_TAB)).toBeUndefined();
    expect(tabNavigationUnderway({ pendingUrl: NEW_TAB, status: 'loading', url: NEW_TAB }, NEW_TAB)).toBeUndefined();
    expect(tabNavigationUnderway({
      pendingUrl: 'https://example.com/',
      status: 'loading',
      url: 'https://example.org/',
    }, NEW_TAB)).toBeUndefined();
  });
});
