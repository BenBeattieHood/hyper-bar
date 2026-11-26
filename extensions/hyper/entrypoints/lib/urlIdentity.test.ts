import { describe, expect, it } from 'vitest';
import {
  normaliseUrl,
  pageIdentity,
  pageUrlFromText,
  urlDomain,
  urlsShareDomain,
} from './urlIdentity';

describe('pasted page addresses', () => {
  it('takes web and file addresses, and nothing that could run or embed code', () => {
    expect(pageUrlFromText(' https://example.com/docs ')).toBe('https://example.com/docs');
    expect(pageUrlFromText('file:///Users/me/notes.html')).toBe('file:///Users/me/notes.html');
    expect(pageUrlFromText('javascript:alert(1)')).toBeUndefined();
    expect(pageUrlFromText('data:text/html,<p>hi</p>')).toBeUndefined();
    expect(pageUrlFromText('chrome://settings')).toBeUndefined();
    expect(pageUrlFromText('example.com')).toBeUndefined();
    expect(pageUrlFromText('see https://example.com')).toBeUndefined();
    expect(pageUrlFromText('')).toBeUndefined();
  });
});

describe('URL identity', () => {
  it('answers repeated and very long addresses the same as the first time', () => {
    const long = `https://example.com/${'a'.repeat(3_000)}`;

    expect(pageIdentity('https://example.com/a?tab=api#top')).toBe('https://example.com/a');
    expect(pageIdentity('https://example.com/a?tab=api#top')).toBe('https://example.com/a');
    expect(pageIdentity(`${long}?tab=api`)).toBe(long);
    expect(normaliseUrl('not a url')).toBe(normaliseUrl('not a url'));
    for (let index = 0; index < 20_100; index += 1) pageIdentity(`https://example.com/${index}`);
    expect(pageIdentity('https://example.com/7#top')).toBe('https://example.com/7');
  });

  it('matches equivalent browser and bookmark URLs', () => {
    expect(normaliseUrl('https://example.com/docs/#install')).toBe(
      'https://example.com/docs',
    );
    expect(normaliseUrl('https://example.com/docs/')).toBe(
      'https://example.com/docs',
    );
    expect(normaliseUrl('https://example.com/docs?view=all#top')).toBe(
      'https://example.com/docs?view=all',
    );
  });

  it('treats query variants as one page but preserves meaningful path changes', () => {
    expect(pageIdentity('https://example.com/docs?tab=api#method')).toBe(
      'https://example.com/docs',
    );
    expect(pageIdentity('https://example.com/docs/guides?tab=api')).not.toBe(
      pageIdentity('https://example.com/docs?tab=api'),
    );
  });

  it('preserves Google search terms and result pagination', () => {
    const icons = pageIdentity('https://www.google.com/search?q=icon');

    expect(icons).not.toBe(
      pageIdentity('https://www.google.com/search?q=figma'),
    );
    expect(icons).not.toBe(
      pageIdentity('https://www.google.com/search?q=icon&start=10'),
    );
  });

  it('preserves GitHub pull request and issue filters', () => {
    const openPulls = pageIdentity(
      'https://github.com/[REDACTED]-[REDACTED]/netbank-v2/pulls?q=is%3Apr+is%3Aopen+author%3A%40me',
    );

    expect(openPulls).not.toBe(pageIdentity(
      'https://github.com/[REDACTED]-[REDACTED]/netbank-v2/pulls?q=is%3Apr+is%3Aclosed+author%3A%40me',
    ));
    expect(openPulls).not.toBe(pageIdentity(
      'https://github.com/[REDACTED]-[REDACTED]/netbank-v2/issues?q=is%3Aissue+is%3Aopen',
    ));
    expect(openPulls).toBe(pageIdentity(
      'https://github.com/[REDACTED]-[REDACTED]/netbank-v2/pulls?q=is%3Apr+is%3Aopen+author%3A%40me#results',
    ));
  });

  it('matches navigation within the same normalized domain', () => {
    expect(urlDomain('https://www.Example.com/docs')).toBe('example.com');
    expect(urlsShareDomain(
      'https://www.example.com/start',
      'https://example.com/next?view=all',
    )).toBe(true);
    expect(urlsShareDomain(
      'https://docs.example.com/start',
      'https://example.com/next',
    )).toBe(false);
    expect(urlsShareDomain('about:blank', 'about:blank')).toBe(false);
  });
});