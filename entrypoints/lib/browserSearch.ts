import { CommandFailureError } from './modelActions';

interface BrowserSearchApi {
  query?: (options: { text: string; tabId?: number }) => Promise<void> | void;
  search?: (options: { query: string; tabId?: number }) => Promise<void> | void;
}

// Chromium's search API rejects with "Missing default search provider." when no engine is set.
function missingDefaultEngine(error: unknown): boolean {
  return error instanceof Error && /default search provider/i.test(error.message);
}

export async function searchWithDefaultEngine(
  query: string,
  tabId: number,
  searchApi?: BrowserSearchApi | null,
): Promise<void> {
  const resolvedApi = searchApi === undefined
    ? (browser as unknown as { search?: BrowserSearchApi }).search
    : searchApi ?? undefined;
  if (resolvedApi?.query) {
    try {
      await resolvedApi.query({ text: query, tabId });
    } catch (error) {
      if (!missingDefaultEngine(error)) throw error;
      throw new CommandFailureError('unsupported', 'The browser has no default search engine.');
    }
    return;
  }
  if (resolvedApi?.search) {
    await resolvedApi.search({ query, tabId });
    return;
  }
  throw new Error('Search through the browser default engine is unavailable.');
}
