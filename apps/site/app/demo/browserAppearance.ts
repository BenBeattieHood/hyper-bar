'use client';

import { useEffect, useState } from 'react';

export type DemoBrowser = 'brave' | 'chrome' | 'edge' | 'firefox' | 'other';
export type DemoTheme = 'dark' | 'light';
export type DemoPlatform = 'mac' | 'other';

export interface BrowserAppearance {
  browser: DemoBrowser;
  label: string;
  platform: DemoPlatform;
  theme: DemoTheme;
}

const labels: Record<DemoBrowser, string> = {
  brave: 'Brave',
  chrome: 'Chrome',
  edge: 'Edge',
  firefox: 'Firefox',
  other: 'Browser',
};

function browserFromUserAgent(): DemoBrowser {
  const ua = navigator.userAgent;
  if (/Edg(?:e|A|iOS)?\//i.test(ua)) return 'edge';
  if (/Firefox|FxiOS\//i.test(ua)) return 'firefox';
  if (/Chrome|CriOS\//i.test(ua)) return 'chrome';
  return 'other';
}

export function useBrowserAppearance(): BrowserAppearance {
  const [browser, setBrowser] = useState<DemoBrowser>('other');
  const [theme, setTheme] = useState<DemoTheme>('light');
  const [platform, setPlatform] = useState<DemoPlatform>('other');

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const updateTheme = () => setTheme(media.matches ? 'dark' : 'light');
    updateTheme();
    media.addEventListener('change', updateTheme);

    setPlatform(/Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent) ? 'mac' : 'other');
    setBrowser(browserFromUserAgent());

    let disposed = false;
    const brave = (navigator as Navigator & { brave?: { isBrave?: () => Promise<boolean> } }).brave;
    brave?.isBrave?.().then((isBrave) => {
      if (!disposed && isBrave) setBrowser('brave');
    }).catch(() => undefined);

    return () => {
      disposed = true;
      media.removeEventListener('change', updateTheme);
    };
  }, []);

  return { browser, label: labels[browser], platform, theme };
}
