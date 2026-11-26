/// <reference types="wxt/vite-builder-env" />
/// <reference path="../../extensions/hyper/.wxt/wxt.d.ts" />

import type { Browser } from '@wxt-dev/browser';
import type { browser as wxtBrowser } from 'wxt/browser';

declare global {
  export type { Browser };
  const browser: typeof wxtBrowser;
}

export {};
