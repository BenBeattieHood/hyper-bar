import { describe, expect, it } from 'vitest';
import { searchEngineSettings } from './searchEngineSettings';

describe('searchEngineSettings', () => {
  it('names Edge and its own settings page, and any other Chromium generically', () => {
    expect(searchEngineSettings(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36 Edg/154.0.0.0',
    )).toEqual({ browser: 'Edge', url: 'edge://settings/search' });
    expect(searchEngineSettings(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
    )).toEqual({ browser: 'Your browser', url: 'chrome://settings/search' });
  });
});
