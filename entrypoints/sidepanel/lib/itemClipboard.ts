import { isRecord } from '../../lib/collections';
import { MAX_PAGE_URL_LENGTH, pageUrlFromText } from '../../lib/urlIdentity';

/** Where Hyper keeps its own account of what was copied; other apps read only the formats beside it. */
export const HYPER_CLIPBOARD_TYPE = 'application/x-hyper-items+json';

export type ClipboardOperation = 'copy' | 'cut';

export interface ClipboardEntry {
  /** A `session-tab` is a tab another session keeps, named by its backing. */
  kind: 'bookmark' | 'folder' | 'session-tab' | 'tab' | 'tab-folder';
  title: string;
  url?: string;
  /** What Hyper keeps after the title of the item's bookmark or tab record. */
  metadata?: Record<string, unknown>;
  /** The bookmark, folder, or tab record the item was in the Hyper that copied it. */
  nodeId?: string;
  tabId?: number;
  /** The bookmark was copied from the favourites. */
  favourite?: boolean;
  children?: ClipboardEntry[];
}

export interface HyperClipboard {
  hyper: 1;
  operation: ClipboardOperation;
  /** The installation that copied, whose IDs alone a paste may trust. */
  installationId?: string;
  windowId?: number;
  items: ClipboardEntry[];
}

export interface ClipboardContents {
  hyper?: HyperClipboard;
  text: string;
}

export interface ClipboardPage {
  title: string;
  url: string;
}

const MAX_ENTRIES = 5_000;
const MAX_DEPTH = 32;
const MAX_TITLE_LENGTH = 2_048;
const MAX_ID_LENGTH = 128;

/** Every web or file page the entries hold, folders' in order, each once. */
export function clipboardPages(entries: readonly ClipboardEntry[]): ClipboardPage[] {
  const pages = new Map<string, ClipboardPage>();
  const visit = (entry: ClipboardEntry) => {
    const url = entry.url && pageUrlFromText(entry.url);
    if (url && !pages.has(url)) pages.set(url, { title: entry.title, url });
    entry.children?.forEach(visit);
  };
  entries.forEach(visit);
  return [...pages.values()];
}

/** The pages in pasted text: one address per line, ignoring anything that is not one. */
export function pastedPages(text: string): ClipboardPage[] {
  const pages = new Map<string, ClipboardPage>();
  for (const line of text.split(/\r?\n/)) {
    const url = pageUrlFromText(line);
    if (url && !pages.has(url)) pages.set(url, { title: url, url });
  }
  return [...pages.values()];
}

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (character) => ({
  '"': '&quot;',
  '&': '&amp;',
  "'": '&#39;',
  '<': '&lt;',
  '>': '&gt;',
})[character] ?? character);

function entryHtml(entry: ClipboardEntry): string {
  const title = escapeHtml(entry.title || entry.url || '');
  const url = entry.url && pageUrlFromText(entry.url);
  if (url) return `<a href="${escapeHtml(url)}">${title}</a>`;
  const children = entry.children ?? [];
  return children.length > 0 ? `${title}${listHtml(children)}` : title;
}

const listHtml = (entries: readonly ClipboardEntry[]) =>
  `<ul>${entries.map((entry) => `<li>${entryHtml(entry)}</li>`).join('')}</ul>`;

/**
 * What the clipboard holds besides Hyper's own account: the addresses as text,
 * so a plain text field gets only them, and titled links for rich editors.
 */
export function clipboardFormats(clipboard: HyperClipboard): Record<string, string> {
  const urls = clipboardPages(clipboard.items).map((page) => page.url);
  const [only] = clipboard.items;
  return {
    'text/plain': urls.length > 0 ? urls.join('\n') : clipboard.items.map((entry) => entry.title).join('\n'),
    ...(urls.length > 0 ? { 'text/uri-list': urls.join('\r\n') } : {}),
    'text/html': clipboard.items.length === 1 && only?.url ? entryHtml(only) : listHtml(clipboard.items),
    [HYPER_CLIPBOARD_TYPE]: JSON.stringify(clipboard),
  };
}

function parseEntry(value: unknown, depth: number, budget: { left: number }): ClipboardEntry | undefined {
  if (!isRecord(value) || depth > MAX_DEPTH || budget.left <= 0) return undefined;
  budget.left -= 1;
  const { kind } = value;
  if (
    kind !== 'bookmark' && kind !== 'folder' && kind !== 'session-tab' && kind !== 'tab' && kind !== 'tab-folder'
  ) return undefined;
  const url = typeof value.url === 'string' && value.url.length <= MAX_PAGE_URL_LENGTH ? value.url : undefined;
  const nodeId = typeof value.nodeId === 'string' && value.nodeId.length <= MAX_ID_LENGTH
    ? value.nodeId
    : undefined;
  const tabId = Number.isInteger(value.tabId) ? value.tabId as number : undefined;
  const children = Array.isArray(value.children)
    ? value.children.flatMap((child) => {
        const parsed = parseEntry(child, depth + 1, budget);
        return parsed ? [parsed] : [];
      })
    : undefined;
  return {
    kind,
    title: typeof value.title === 'string' ? value.title.slice(0, MAX_TITLE_LENGTH) : '',
    ...(url ? { url } : {}),
    ...(isRecord(value.metadata) ? { metadata: value.metadata } : {}),
    ...(nodeId ? { nodeId } : {}),
    ...(tabId === undefined ? {} : { tabId }),
    ...(value.favourite === true ? { favourite: true } : {}),
    ...(children ? { children } : {}),
  };
}

/** Hyper's account of a copy, read as the untrusted text any page could have written there. */
export function parseHyperClipboard(json: string): HyperClipboard | undefined {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (!isRecord(value) || value.hyper !== 1 || !Array.isArray(value.items)) return undefined;
  if (value.operation !== 'copy' && value.operation !== 'cut') return undefined;
  const budget = { left: MAX_ENTRIES };
  const items = value.items.flatMap((item) => {
    const entry = parseEntry(item, 0, budget);
    return entry ? [entry] : [];
  });
  if (items.length === 0) return undefined;
  return {
    hyper: 1,
    operation: value.operation,
    ...(typeof value.installationId === 'string' && value.installationId.length <= MAX_ID_LENGTH
      ? { installationId: value.installationId }
      : {}),
    ...(Number.isInteger(value.windowId) ? { windowId: value.windowId as number } : {}),
    items,
  };
}

export function clipboardContents(data: Pick<DataTransfer, 'getData'> | null): ClipboardContents {
  const json = data?.getData(HYPER_CLIPBOARD_TYPE);
  const hyper = json ? parseHyperClipboard(json) : undefined;
  return { ...(hyper ? { hyper } : {}), text: data?.getData('text/plain') ?? '' };
}

/** Runs the browser's copy or paste command, serving its event with `handle`; true once `handle` did. */
function clipboardCommand(command: 'copy' | 'paste', handle: (event: ClipboardEvent) => boolean): boolean {
  let handled = false;
  const listener = (event: ClipboardEvent) => {
    if (!handle(event)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    handled = true;
  };
  document.addEventListener(command, listener, true);
  try {
    document.execCommand(command);
  } finally {
    document.removeEventListener(command, listener, true);
  }
  return handled;
}

/**
 * Puts a copy on the system clipboard in every format at once. The browser
 * only lets a page set several formats from a copy event, so this starts one.
 */
export async function writeClipboard(clipboard: HyperClipboard): Promise<void> {
  const formats = clipboardFormats(clipboard);
  const written = clipboardCommand('copy', (event) => {
    if (!event.clipboardData) return false;
    for (const [type, value] of Object.entries(formats)) event.clipboardData.setData(type, value);
    return true;
  });
  if (written) return;
  if (!navigator.clipboard?.writeText) throw new Error('Clipboard access is unavailable.');
  await navigator.clipboard.writeText(formats['text/plain'] ?? '');
}

/**
 * Reads the clipboard for a paste Hyper starts itself, from a menu or a key it
 * handles. Only a paste event shows Hyper's own format; reading text is the
 * fallback where the browser will not start one.
 */
export async function readClipboard(): Promise<ClipboardContents | undefined> {
  let contents: ClipboardContents | undefined;
  clipboardCommand('paste', (event) => {
    contents = clipboardContents(event.clipboardData);
    return true;
  });
  if (contents) return contents;
  try {
    return { text: await navigator.clipboard.readText() };
  } catch {
    return undefined;
  }
}
