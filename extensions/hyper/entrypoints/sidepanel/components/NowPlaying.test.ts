import { createElement, type ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserTab } from '../../lib/bookmarks';
import { NowPlaying } from './NowPlaying';

const audibleTab = {
  id: 17,
  windowId: 3,
  audible: true,
  title: 'Night drive',
  url: 'https://music.example/album/night-drive',
} as BrowserTab;

const render = (props: Partial<ComponentProps<typeof NowPlaying>> = {}) =>
  renderToStaticMarkup(createElement(NowPlaying, {
    tabs: [audibleTab],
    extensionOrigin: 'chrome-extension://hyper-extension/',
    playbackAccessEnabled: false,
    onFocus: vi.fn(),
    onTogglePlayback: vi.fn(),
    onToggleMuted: vi.fn(),
    ...props,
  }));

describe('NowPlaying', () => {
  beforeEach(() => {
    vi.stubGlobal('browser', {
      runtime: { getURL: (path: string) => `chrome-extension://hyper-extension/${path}` },
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders nothing without an audible tab', () => {
    expect(render({ tabs: [] })).toBe('');
  });

  it('shows the current audio source and available controls', () => {
    const markup = render();
    expect(markup).toContain('aria-label="Now playing"');
    expect(markup).toContain('title="Night drive"');
    expect(markup).toContain('aria-label="Open audio tab: Night drive"');
    expect(markup).toContain('aria-label="Mute Night drive"');
    expect(markup.match(/<button/g)).toHaveLength(2);
  });

  it('shows the previous tab as the return target while media is focused', () => {
    const markup = render({
      returnTab: {
        id: 18,
        windowId: 3,
        title: 'Previous page',
        url: 'https://previous.example/page',
      } as BrowserTab,
    });
    expect(markup).toContain('aria-label="Return to previous tab: Previous page"');
    expect(markup).not.toContain(encodeURIComponent('https://previous.example/page'));
    expect(markup).toContain(encodeURIComponent('https://music.example/album/night-drive'));
    expect(markup).toContain('data-icon-state="return"');
    expect(markup).toContain('now-playing-source-icon-cube is-returning');
    expect(markup).toContain('now-playing-source-icon-face is-media');
    expect(markup).toContain('now-playing-source-icon-face is-return');
    expect(markup).toContain('now-playing-return-icon');
    expect(markup).toContain('lucide-arrow-left');
    expect(markup).toContain('aria-label="Mute Night drive"');
  });

  it.each([
    ['playing', 'Pause', 'Mute'],
    ['paused', 'Play', 'Unmute'],
  ] as const)('shows play or pause instead of mute when media access is available (%s)', (playbackState, shown, hidden) => {
    const markup = render({ playbackAccessEnabled: true, playbackState });
    expect(markup).toContain(`aria-label="${shown} Night drive"`);
    expect(markup).not.toContain(`aria-label="${hidden} Night drive"`);
    expect(markup).toContain('data-playback-icon="true"');
    expect(markup).toContain(`data-playback-state="${playbackState}"`);
    expect(markup).toMatch(/data-playback-icon="true"[^>]*><path/);
  });

  it('falls back to mute when exact media playback is unsupported', () => {
    const markup = render({ playbackAccessEnabled: true });
    expect(markup.match(/<button/g)).toHaveLength(2);
    expect(markup).toContain('Mute Night drive');
    expect(markup).not.toContain('Play Night drive');
    expect(markup).not.toContain('Pause Night drive');
  });

  it.each([
    { playbackAccessEnabled: true, playbackState: 'playing' as const },
    { playbackAccessEnabled: false },
  ])('disables and greys playback and mute controls while media is unavailable (%o)', (props) => {
    const markup = render({ mediaUnavailable: true, ...props });
    expect(markup).toContain('now-playing has-control is-unavailable');
    expect(markup).toMatch(/class="now-playing-control" disabled=""/);
  });
});
