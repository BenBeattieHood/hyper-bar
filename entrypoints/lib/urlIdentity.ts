/** Whether a scheme, as `URL.protocol` gives it, is http or https. */
export function isHttpProtocol(protocol: string): boolean {
  return protocol === 'http:' || protocol === 'https:';
}

/** Whether `url` is an http or https address, judged by its scheme alone. */
export function isHttpUrl(url: string | undefined): url is string {
  return /^https?:\/\//i.test(url ?? '');
}

function parseNormalisedUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    if (
      isHttpProtocol(parsed.protocol) &&
      parsed.pathname.length > 1
    ) {
      parsed.pathname = parsed.pathname.replace(/\/+$/, '');
    }
    return parsed.href;
  } catch {
    return url.trim() || null;
  }
}

function parsePageIdentity(url: string): string | null {
  const normalised = normaliseUrl(url);
  if (!normalised) return null;
  try {
    const parsed = new URL(normalised);
    const googleSearch = parsed.pathname === '/search' &&
      /(^|\.)google\.[a-z]{2,}(?:\.[a-z]{2,})?$/.test(parsed.hostname);
    const githubFilteredList = parsed.hostname === 'github.com' && (
      parsed.pathname === '/search' ||
      /^\/[^/]+\/[^/]+\/(?:issues|pulls)$/.test(parsed.pathname)
    );
    if (
      isHttpProtocol(parsed.protocol) &&
      !googleSearch &&
      !githubFilteredList
    ) {
      parsed.search = '';
    }
    return parsed.href;
  } catch {
    return normalised;
  }
}

/**
 * Parsing a URL is the costliest step when Search and the model compare
 * thousands of pages on every revision, and the same addresses recur, so
 * results are kept per address. A cache is dropped whole when it fills, and
 * very long addresses, such as `data:` pages, are not kept.
 */
const MEMO_LIMIT = 20_000;
const MEMO_URL_LENGTH = 2_048;
const normalisedUrls = new Map<string, string | null>();
const pageIdentities = new Map<string, string | null>();

function memoised(
  cache: Map<string, string | null>,
  url: string | undefined,
  parse: (url: string) => string | null,
): string | null {
  if (!url) return null;
  if (url.length > MEMO_URL_LENGTH) return parse(url);
  let result = cache.get(url);
  if (result === undefined) {
    if (cache.size >= MEMO_LIMIT) cache.clear();
    result = parse(url);
    cache.set(url, result);
  }
  return result;
}

export function normaliseUrl(url?: string): string | null {
  return memoised(normalisedUrls, url, parseNormalisedUrl);
}

export function pageIdentity(url?: string): string | null {
  return memoised(pageIdentities, url, parsePageIdentity);
}

/** The address a tab is loading, or else the one it shows. */
export function tabUrl(tab: { pendingUrl?: string; url?: string } | undefined): string | undefined {
  return tab?.pendingUrl ?? tab?.url;
}

export function tabPageIdentity(tab: { pendingUrl?: string; url?: string } | undefined): string | null {
  return pageIdentity(tabUrl(tab));
}

export const MAX_PAGE_URL_LENGTH = 8_192;

/**
 * An address pasted or carried in from outside, if it is a web or file page:
 * a `javascript:` or `data:` address on the clipboard must never become a
 * bookmark or a tab.
 */
export function pageUrlFromText(text: string): string | undefined {
  const value = text.trim();
  if (!value || value.length > MAX_PAGE_URL_LENGTH || /\s/.test(value)) return undefined;
  try {
    const parsed = new URL(value);
    return ['http:', 'https:', 'file:'].includes(parsed.protocol) ? parsed.href : undefined;
  } catch {
    return undefined;
  }
}

export function urlDomain(url?: string): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLocaleLowerCase().replace(/^www\./, '') || null;
  } catch {
    return null;
  }
}

export function urlsShareDomain(left?: string, right?: string): boolean {
  const leftDomain = urlDomain(left);
  return Boolean(leftDomain && leftDomain === urlDomain(right));
}

export function urlsRepresentSamePage(left?: string, right?: string): boolean {
  const leftIdentity = pageIdentity(left);
  return Boolean(leftIdentity && leftIdentity === pageIdentity(right));
}