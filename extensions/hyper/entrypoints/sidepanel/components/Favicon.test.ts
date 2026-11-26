import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  accessibleFaviconSource,
  Favicon,
  faviconAudioStateForTabs,
  faviconLoadingForTabs,
} from '@hyper/ui';

describe('accessibleFaviconSource', () => {
  const extensionRoot = 'chrome-extension://hyper-extension/';

  it('rejects private resources owned by another extension', () => {
    expect(accessibleFaviconSource(
      'chrome-extension://another-extension/img/icon_64.png',
      extensionRoot,
    )).toBeUndefined();
    expect(accessibleFaviconSource(
      'moz-extension://another-extension/icon.svg',
      'moz-extension://hyper-extension/',
    )).toBeUndefined();
  });

  it('keeps web, data, and current-extension favicon sources', () => {
    expect(accessibleFaviconSource('https://example.com/favicon.ico', extensionRoot))
      .toBe('https://example.com/favicon.ico');
    expect(accessibleFaviconSource('data:image/png;base64,AA==', extensionRoot))
      .toBe('data:image/png;base64,AA==');
    expect(accessibleFaviconSource(
      'chrome-extension://hyper-extension/icon.png',
      extensionRoot,
    )).toBe('chrome-extension://hyper-extension/icon.png');
    expect(accessibleFaviconSource(
      'moz-extension://hyper-extension/icon.svg',
      'moz-extension://hyper-extension/',
    )).toBe('moz-extension://hyper-extension/icon.svg');
  });
});

describe('Favicon', () => {
  beforeEach(() => {
    vi.stubGlobal('browser', {
      runtime: { getURL: (path: string) => `chrome-extension://hyper-extension/${path}` },
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders playing and paused equaliser states only for known audio', () => {
    const props = { title: 'Live set', url: 'https://music.example/' };
    const playingMarkup = renderToStaticMarkup(createElement(
      Favicon,
      { ...props, audioState: 'playing' },
    ));
    expect(playingMarkup).toContain('favicon-audio-overlay is-playing');
    expect(playingMarkup).toContain('data-audio-state="playing"');
    expect(playingMarkup.match(/<rect/g)).toHaveLength(4);
    expect(playingMarkup).toContain('audio-equaliser-outer is-left');
    expect(playingMarkup).toContain('audio-pause-half is-left');
    expect(playingMarkup).toContain('audio-pause-half is-right');
    expect(playingMarkup).toContain('audio-equaliser-outer is-right');
    expect(playingMarkup).toContain('viewBox="0 0 10 10"');
    const pausedMarkup = renderToStaticMarkup(createElement(
      Favicon,
      { ...props, audioState: 'paused' },
    ));
    expect(pausedMarkup).toContain('favicon-audio-overlay is-paused');
    expect(pausedMarkup).toContain('data-audio-state="paused"');
    expect(pausedMarkup.match(/<rect/g)).toHaveLength(4);
    expect(renderToStaticMarkup(createElement(Favicon, props)))
      .not.toContain('favicon-audio-overlay');
  });

  it('prefers playing when matching tabs have mixed audio states', () => {
    const tabs = [{ id: 1 }, { id: 2 }] as Browser.tabs.Tab[];
    expect(faviconAudioStateForTabs(tabs, { 1: 'paused', 2: 'playing' }))
      .toBe('playing');
    expect(faviconAudioStateForTabs(tabs, { 1: 'paused' })).toBe('paused');
    expect(faviconAudioStateForTabs(tabs, {})).toBeUndefined();
  });

  it('dims the icon and replaces audio with a spinner while loading', () => {
    const markup = renderToStaticMarkup(createElement(Favicon, {
      audioState: 'playing',
      loading: true,
      title: 'Loading page',
      url: 'https://example.com/',
    }));
    expect(markup).toContain('favicon-small has-image is-loading');
    expect(markup).toContain('class="favicon-visual"');
    expect(markup).toContain('data-loading-spinner="true"');
    expect(markup).not.toContain('favicon-audio-overlay');
  });

  it('detects loading across matching tabs', () => {
    expect(faviconLoadingForTabs([
      { status: 'complete' },
      { status: 'loading' },
    ] as Browser.tabs.Tab[])).toBe(true);
    expect(faviconLoadingForTabs([
      { status: 'complete' },
      {},
    ] as Browser.tabs.Tab[])).toBe(false);
  });
});
