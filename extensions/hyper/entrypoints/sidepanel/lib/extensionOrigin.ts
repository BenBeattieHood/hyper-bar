export function extensionOrigin(): string {
  const runtime = (globalThis as typeof globalThis & {
    browser?: { runtime?: { getURL?: (path: string) => string } };
  }).browser?.runtime;
  return runtime?.getURL?.('') ?? `${location.origin}/`;
}
