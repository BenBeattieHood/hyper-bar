import { pageUrlFromText } from '../../lib/urlIdentity';

/** A page a shortcut file points at, titled by the file's own name unless it names itself. */
export interface ShortcutPage {
  title: string;
  url: string;
}

/** Larger files are not shortcuts, so they are never read. */
export const MAX_SHORTCUT_FILE_SIZE = 64 * 1024;

const SHORTCUT_EXTENSIONS = ['desktop', 'inetloc', 'lnk', 'url', 'webloc'] as const;
type ShortcutExtension = typeof SHORTCUT_EXTENSIONS[number];

function shortcutExtension(name: string): ShortcutExtension | undefined {
  const extension = name.toLowerCase().match(/\.([a-z]+)$/)?.[1];
  return SHORTCUT_EXTENSIONS.find((candidate) => candidate === extension);
}

/** Whether a file of this name and size may be a shortcut worth reading. */
export function mayBeShortcutFile(name: string, size: number): boolean {
  return size <= MAX_SHORTCUT_FILE_SIZE && shortcutExtension(name) !== undefined;
}

const fileTitle = (name: string) => name.replace(/\.[^.]+$/, '').trim() || name;

/**
 * The page a shortcut file points at: a Windows Internet Shortcut (`.url`) or
 * shell link (`.lnk`), a macOS `.webloc` or `.inetloc`, or a freedesktop
 * `.desktop` link. Anything else, or a shortcut to something that is not a web
 * or file page, gives nothing.
 */
export function shortcutPage(name: string, bytes: Uint8Array): ShortcutPage | undefined {
  const extension = shortcutExtension(name);
  if (!extension || bytes.length > MAX_SHORTCUT_FILE_SIZE) return undefined;
  const read = extension === 'lnk'
    ? shellLinkTarget(bytes)
    : extension === 'webloc' || extension === 'inetloc'
      ? plistUrl(bytes)
      : iniShortcut(new TextDecoder().decode(bytes), extension);
  const parsed = typeof read === 'string' ? { url: read } : read;
  const url = parsed?.url && pageUrlFromText(parsed.url);
  if (!url) return undefined;
  return { title: parsed.title?.trim() || fileTitle(name), url };
}

/** `URL=` from an Internet Shortcut's section, or from a desktop entry of type Link. */
function iniShortcut(text: string, extension: 'desktop' | 'url'): { title?: string; url?: string } | undefined {
  const section = extension === 'url' ? 'internetshortcut' : 'desktop entry';
  const values = new Map<string, string>();
  let current: string | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const heading = line.match(/^\[(.+)\]$/);
    if (heading) {
      current = heading[1]?.trim().toLowerCase();
      continue;
    }
    const pair = current === section ? line.match(/^([^=#;]+?)\s*=\s*(.*)$/) : null;
    // Desktop entries mark values with locale or expansion suffixes such as `URL[$e]`.
    const key = pair?.[1]?.replace(/\[.*\]$/, '').toLowerCase();
    if (key && pair?.[2] !== undefined && !values.has(key)) values.set(key, pair[2]);
  }
  if (extension === 'desktop' && values.get('type')?.toLowerCase() !== 'link') return undefined;
  const url = values.get('url');
  return url ? { url, ...(extension === 'desktop' && values.get('name') ? { title: values.get('name') } : {}) } : undefined;
}

/** Decodes the character references of dragged HTML or a property list's XML. */
export const decodeEntities = (value: string) => value
  .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
  .replace(/&#(\d+);/g, (_, decimal: string) => String.fromCodePoint(Number.parseInt(decimal, 10)))
  .replace(/&nbsp;/g, ' ')
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'")
  .replace(/&amp;/g, '&');

/** The `URL` string of a property list, in XML or binary form. */
function plistUrl(bytes: Uint8Array): string | undefined {
  if (startsWith(bytes, 'bplist00')) return binaryPlistUrl(bytes);
  const text = new TextDecoder().decode(bytes);
  const match = text.match(/<key>\s*URL\s*<\/key>\s*<string>([\s\S]*?)<\/string>/);
  return match?.[1] === undefined ? undefined : decodeEntities(match[1].trim());
}

function startsWith(bytes: Uint8Array, prefix: string): boolean {
  return [...prefix].every((character, index) => bytes[index] === character.charCodeAt(0));
}

/**
 * Reads the top-level dictionary's `URL` string from a binary property list,
 * as macOS writes `.webloc` files. Every offset is checked, as the file is
 * whatever was dropped.
 */
function binaryPlistUrl(bytes: Uint8Array): string | undefined {
  if (bytes.length < 40) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const trailer = bytes.length - 32;
  const offsetSize = bytes[trailer + 6] ?? 0;
  const refSize = bytes[trailer + 7] ?? 0;
  const objectCount = readUnsigned(view, trailer + 8, 8);
  const topObject = readUnsigned(view, trailer + 16, 8);
  const offsetTable = readUnsigned(view, trailer + 24, 8);
  if (
    offsetSize < 1 || offsetSize > 8 || refSize < 1 || refSize > 8 ||
    objectCount === undefined || topObject === undefined || offsetTable === undefined ||
    topObject >= objectCount || offsetTable + objectCount * offsetSize > trailer
  ) return undefined;
  const objectAt = (ref: number) => ref < objectCount
    ? readUnsigned(view, offsetTable + ref * offsetSize, offsetSize)
    : undefined;
  const lengthAt = (offset: number): { length: number; start: number } | undefined => {
    const marker = bytes[offset];
    if (marker === undefined) return undefined;
    if ((marker & 0x0f) !== 0x0f) return { length: marker & 0x0f, start: offset + 1 };
    const intMarker = bytes[offset + 1];
    if (intMarker === undefined || intMarker >> 4 !== 0x1) return undefined;
    const size = 1 << (intMarker & 0x0f);
    const length = readUnsigned(view, offset + 2, size);
    return length === undefined ? undefined : { length, start: offset + 2 + size };
  };
  const stringAt = (ref: number): string | undefined => {
    const offset = objectAt(ref);
    const marker = offset === undefined ? undefined : bytes[offset];
    if (offset === undefined || marker === undefined) return undefined;
    const type = marker >> 4;
    if (type !== 0x5 && type !== 0x6) return undefined;
    const span = lengthAt(offset);
    if (!span) return undefined;
    const byteLength = type === 0x5 ? span.length : span.length * 2;
    if (span.start + byteLength > trailer) return undefined;
    const slice = bytes.subarray(span.start, span.start + byteLength);
    return new TextDecoder(type === 0x5 ? 'latin1' : 'utf-16be').decode(slice);
  };
  const top = objectAt(topObject);
  const marker = top === undefined ? undefined : bytes[top];
  if (top === undefined || marker === undefined || marker >> 4 !== 0xd) return undefined;
  const span = lengthAt(top);
  if (!span || span.start + span.length * 2 * refSize > trailer) return undefined;
  for (let index = 0; index < span.length; index += 1) {
    const keyRef = readUnsigned(view, span.start + index * refSize, refSize);
    if (keyRef === undefined || stringAt(keyRef) !== 'URL') continue;
    const valueRef = readUnsigned(view, span.start + (span.length + index) * refSize, refSize);
    return valueRef === undefined ? undefined : stringAt(valueRef);
  }
  return undefined;
}

function readUnsigned(view: DataView, offset: number, size: number): number | undefined {
  if (offset < 0 || offset + size > view.byteLength) return undefined;
  let value = 0;
  for (let index = 0; index < size; index += 1) value = value * 256 + view.getUint8(offset + index);
  return Number.isSafeInteger(value) ? value : undefined;
}

const LINK_HEADER_SIZE = 0x4c;
const HAS_TARGET_ID_LIST = 0x1;
const HAS_LINK_INFO = 0x2;
const LOCAL_BASE_PATH = 0x1;
const NETWORK_RELATIVE_LINK = 0x2;

/**
 * The file a Windows shell link points at, as a `file:` address, read from the
 * link's LinkInfo structure (MS-SHLLINK 2.3).
 */
function shellLinkTarget(bytes: Uint8Array): string | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (offset: number) => offset + 2 <= view.byteLength ? view.getUint16(offset, true) : undefined;
  const u32 = (offset: number) => offset + 4 <= view.byteLength ? view.getUint32(offset, true) : undefined;
  if (u32(0) !== LINK_HEADER_SIZE) return undefined;
  const flags = u32(20) ?? 0;
  if (!(flags & HAS_LINK_INFO)) return undefined;
  let offset = LINK_HEADER_SIZE;
  if (flags & HAS_TARGET_ID_LIST) {
    const idListSize = u16(offset);
    if (idListSize === undefined) return undefined;
    offset += 2 + idListSize;
  }
  const info = offset;
  const infoSize = u32(info);
  const headerSize = u32(info + 4);
  const infoFlags = u32(info + 8);
  if (!infoSize || !headerSize || infoFlags === undefined || info + infoSize > bytes.length) return undefined;
  const infoBytes = bytes.subarray(info, info + infoSize);
  const unicode = headerSize >= 0x24;
  const suffix = unicode
    ? wideStringAt(infoBytes, u32(info + 0x20)) ?? ansiStringAt(infoBytes, u32(info + 0x18))
    : ansiStringAt(infoBytes, u32(info + 0x18));
  let base: string | undefined;
  if (infoFlags & LOCAL_BASE_PATH) {
    base = unicode
      ? wideStringAt(infoBytes, u32(info + 0x1c)) ?? ansiStringAt(infoBytes, u32(info + 0x10))
      : ansiStringAt(infoBytes, u32(info + 0x10));
  } else if (infoFlags & NETWORK_RELATIVE_LINK) {
    const network = u32(info + 0x14);
    if (network === undefined || network >= infoSize) return undefined;
    const networkView = new DataView(infoBytes.buffer, infoBytes.byteOffset + network, infoSize - network);
    if (networkView.byteLength < 0x14) return undefined;
    const nameOffset = networkView.getUint32(8, true);
    const networkBytes = infoBytes.subarray(network);
    base = nameOffset > 0x14 && networkView.byteLength >= 0x1c
      ? wideStringAt(networkBytes, networkView.getUint32(0x14, true))
      : ansiStringAt(networkBytes, nameOffset);
    if (base && suffix) base += '\\';
  }
  return base ? windowsPathUrl(base + (suffix ?? '')) : undefined;
}

function ansiStringAt(bytes: Uint8Array, offset: number | undefined): string | undefined {
  if (!offset || offset >= bytes.length) return undefined;
  const end = bytes.indexOf(0, offset);
  const value = new TextDecoder('windows-1252').decode(bytes.subarray(offset, end < 0 ? bytes.length : end));
  return value || undefined;
}

function wideStringAt(bytes: Uint8Array, offset: number | undefined): string | undefined {
  if (!offset || offset >= bytes.length) return undefined;
  let end = offset;
  while (end + 1 < bytes.length && (bytes[end] !== 0 || bytes[end + 1] !== 0)) end += 2;
  const value = new TextDecoder('utf-16le').decode(bytes.subarray(offset, end));
  return value || undefined;
}

/** `C:\a b\c.pdf` as `file:///C:/a%20b/c.pdf`, and `\\host\share\c` as `file://host/share/c`. */
export function windowsPathUrl(path: string): string | undefined {
  const segments = path.split(/[\\/]+/).filter(Boolean).map(encodeURIComponent);
  if (/^[a-z]:/i.test(path)) {
    const [drive, ...rest] = segments;
    return drive ? `file:///${decodeURIComponent(drive)}/${rest.join('/')}` : undefined;
  }
  if (path.startsWith('\\\\')) {
    const [host, ...rest] = segments;
    return host ? `file://${decodeURIComponent(host)}/${rest.join('/')}` : undefined;
  }
  return undefined;
}
