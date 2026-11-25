import { describe, expect, it } from 'vitest';
import { isMusicSite } from './musicSites';

describe('music sites', () => {
  it('recognises music players and their subdomains', () => {
    expect(isMusicSite('https://music.youtube.com/watch?v=abc')).toBe(true);
    expect(isMusicSite('https://open.spotify.com/playlist/1')).toBe(true);
    expect(isMusicSite('https://soundcloud.com/artist')).toBe(true);
    expect(isMusicSite('https://listen.tidal.com/')).toBe(true);
    expect(isMusicSite('https://music.amazon.co.uk/')).toBe(true);
  });

  it('leaves out general sites, lookalikes and non-web pages', () => {
    expect(isMusicSite('https://www.youtube.com/watch?v=abc')).toBe(false);
    expect(isMusicSite('https://notspotify.com/')).toBe(false);
    expect(isMusicSite('https://www.amazon.com/music')).toBe(false);
    expect(isMusicSite('chrome-extension://spotify.com/')).toBe(false);
    expect(isMusicSite('not a url')).toBe(false);
    expect(isMusicSite(undefined)).toBe(false);
  });
});
