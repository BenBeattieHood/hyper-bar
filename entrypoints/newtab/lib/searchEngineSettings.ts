/** Where this browser keeps the address bar's default search engine. */
export function searchEngineSettings(userAgent: string): { browser: string; url: string } {
  return /\bEdg\//.test(userAgent)
    ? { browser: 'Edge', url: 'edge://settings/search' }
    : { browser: 'Your browser', url: 'chrome://settings/search' };
}
