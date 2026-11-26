'use client';

import { useEffect, useState, type CSSProperties } from 'react';

const fallbackColours = [
  '#c9513b',
  '#22776c',
  '#3c6e9f',
  '#8d5e3d',
  '#a34161',
  '#697538',
] as const;

interface TabWithDisplayState {
  id?: number;
  status?: string;
}

function pickByText(items: readonly [string, ...string[]], text: string): string {
  const total = Array.from(text).reduce((sum, character) => sum + character.charCodeAt(0), 0);
  return items[Math.abs(Math.trunc(total)) % items.length] ?? items[0];
}

function initialFor(title: string, url: string): string {
  const trimmedTitle = title.trim();
  if (trimmedTitle) return trimmedTitle.slice(0, 1).toLocaleUpperCase();
  try {
    return new URL(url).hostname.slice(0, 1).toLocaleUpperCase() || '?';
  } catch {
    return '?';
  }
}

function runtimeRoot(): string {
  const runtime = (globalThis as typeof globalThis & {
    browser?: { runtime?: { getURL?: (path: string) => string } };
  }).browser?.runtime;
  if (runtime?.getURL) return runtime.getURL('/');
  return globalThis.location?.origin ? `${globalThis.location.origin}/` : 'https://demo.hyper.local/';
}

interface FaviconProps {
  audioState?: FaviconAudioState;
  loading?: boolean;
  url: string;
  title: string;
  size?: 'small' | 'large';
  sourceUrl?: string;
}

export type FaviconAudioState = 'paused' | 'playing';

export type FaviconAudioStates = Readonly<Record<
  number,
  FaviconAudioState | undefined
>>;

export function faviconAudioStateForTabs(
  tabs: readonly TabWithDisplayState[],
  states: FaviconAudioStates,
): FaviconAudioState | undefined {
  let paused = false;
  for (const tab of tabs) {
    if (tab.id === undefined) continue;
    const state = states[tab.id];
    if (state === 'playing') return 'playing';
    if (state === 'paused') paused = true;
  }
  return paused ? 'paused' : undefined;
}

export function faviconLoadingForTabs(tabs: readonly TabWithDisplayState[]): boolean {
  return tabs.some((tab) => tab.status === 'loading');
}

export function accessibleFaviconSource(
  sourceUrl: string | undefined,
  extensionRoot: string,
): string | undefined {
  if (!sourceUrl) return undefined;
  try {
    const source = new URL(sourceUrl, extensionRoot);
    if (source.protocol !== 'chrome-extension:' && source.protocol !== 'moz-extension:') {
      return sourceUrl;
    }
    const currentExtension = new URL(extensionRoot);
    return source.protocol === currentExtension.protocol && source.host === currentExtension.host
      ? sourceUrl
      : undefined;
  } catch {
    return sourceUrl;
  }
}

export function Favicon({
  audioState,
  loading = false,
  url,
  title,
  size = 'small',
  sourceUrl,
}: FaviconProps) {
  const extensionRoot = runtimeRoot();
  const accessibleSource = accessibleFaviconSource(sourceUrl, extensionRoot);
  const fallbackSrc = new URL(
    `_favicon/?pageUrl=${encodeURIComponent(url)}&size=${size === 'large' ? 32 : 16}`,
    extensionRoot,
  ).href;
  const [sourceFailed, setSourceFailed] = useState(false);
  const [fallbackFailed, setFallbackFailed] = useState(false);

  useEffect(() => {
    setSourceFailed(false);
    setFallbackFailed(false);
  }, [accessibleSource, fallbackSrc]);

  const usingSource = Boolean(accessibleSource && !sourceFailed);
  const src = usingSource ? accessibleSource as string : fallbackSrc;
  const showingFallbackText = !usingSource && fallbackFailed;

  return (
    <span
      className={`favicon favicon-${size}${showingFallbackText ? '' : ' has-image'}${loading ? ' is-loading' : ''}`}
      style={{ '--favicon-colour': pickByText(fallbackColours, url) } as CSSProperties}
      aria-hidden="true"
    >
      <span className="favicon-visual">
        {!showingFallbackText && (
          <img
            src={src}
            alt=""
            onError={() => {
              if (usingSource) setSourceFailed(true);
              else setFallbackFailed(true);
            }}
            draggable={false}
          />
        )}
        {showingFallbackText && <span>{initialFor(title, url)}</span>}
      </span>
      {audioState && !loading && (
        <svg
          className={`favicon-audio-overlay is-${audioState}`}
          data-audio-equaliser="true"
          data-audio-state={audioState}
          viewBox="0 0 10 10"
          aria-hidden="true"
        >
          <rect className="audio-equaliser-outer is-left" x="1" y="2" width="2" height="6" rx="1" />
          <rect className="audio-pause-half is-left" x="4" y="4" width="2" height="4" rx="1" />
          <rect className="audio-pause-half is-right" x="4" y="4" width="2" height="4" rx="1" />
          <rect className="audio-equaliser-outer is-right" x="7" y="3" width="2" height="5" rx="1" />
        </svg>
      )}
      {loading && <span className="favicon-loading-spinner" data-loading-spinner="true" />}
    </span>
  );
}
