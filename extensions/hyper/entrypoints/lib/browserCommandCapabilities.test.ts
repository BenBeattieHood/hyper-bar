import { describe, expect, it } from 'vitest';
import {
  noBrowserCommandCapabilities,
  readBrowserCommandCapabilities,
} from './browserCommandCapabilities';

describe('browser command capabilities', () => {
  it('reports only commands implemented by the current browser adapter', () => {
    expect(readBrowserCommandCapabilities({
      sessions: { restore: () => undefined },
      tabs: {
        createSplit: () => undefined,
        duplicate: () => undefined,
        getZoom: () => undefined,
        goBack: () => undefined,
        goForward: () => undefined,
        setZoom: () => undefined,
        unsplit: () => undefined,
      },
      windows: {},
    })).toEqual({
      available: true,
      duplicateTab: true,
      navigateBack: true,
      navigateForward: true,
      restoreClosedTab: true,
      splitViewTabs: 2,
      tabZoom: true,
    });
  });

  it('makes missing browser APIs unavailable rather than assuming support', () => {
    expect(readBrowserCommandCapabilities({ tabs: {}, windows: {} }))
      .toEqual({ ...noBrowserCommandCapabilities, available: true });
    // A browser that only shows splits cannot make one.
    expect(readBrowserCommandCapabilities({ tabs: { createSplit: () => undefined }, windows: {} })
      .splitViewTabs).toBe(0);
    expect(readBrowserCommandCapabilities()).toEqual(noBrowserCommandCapabilities);
  });
});