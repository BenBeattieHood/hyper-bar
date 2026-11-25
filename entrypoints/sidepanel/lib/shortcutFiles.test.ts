import { describe, expect, it } from 'vitest';
import { MAX_SHORTCUT_FILE_SIZE, mayBeShortcutFile, shortcutPage, windowsPathUrl } from './shortcutFiles';

const text = (value: string) => new TextEncoder().encode(value);

const ascii = (value: string) => [...value].map((character) => character.charCodeAt(0));

/** A binary property list holding `{ URL: url }`, as macOS writes a `.webloc`. */
function binaryWebloc(url: string, { wide = false } = {}): Uint8Array {
  const length = (marker: number, count: number) => count < 15 ? [marker | count] : [marker | 0x0f, 0x10, count];
  const urlObject = wide
    ? [...length(0x60, url.length), ...[...url].flatMap((character) => [0, character.charCodeAt(0)])]
    : [...length(0x50, url.length), ...ascii(url)];
  const objects = [[0xd1, 1, 2], [0x53, ...ascii('URL')], urlObject];
  const bytes = [...ascii('bplist00')];
  const offsets = objects.map((object) => {
    const offset = bytes.length;
    bytes.push(...object);
    return offset;
  });
  const offsetTable = bytes.length;
  bytes.push(...offsets);
  const u64 = (value: number) => [0, 0, 0, 0, 0, 0, 0, value];
  bytes.push(0, 0, 0, 0, 0, 0, 1, 1, ...u64(objects.length), ...u64(0), ...u64(offsetTable));
  return Uint8Array.from(bytes);
}

const u32 = (value: number) => [value & 0xff, value >> 8 & 0xff, value >> 16 & 0xff, value >> 24 & 0xff];
const ansiZ = (value: string) => [...ascii(value), 0];
const wideZ = (value: string) => [...[...value].flatMap((character) => [character.charCodeAt(0), 0]), 0, 0];

/** A Windows shell link whose LinkInfo names its target. */
function shellLink(info: number[]): Uint8Array {
  const header = new Array<number>(0x4c).fill(0);
  header.splice(0, 4, ...u32(0x4c));
  header.splice(20, 4, ...u32(0x2));
  return Uint8Array.from([...header, ...info, 0, 0, 0, 0]);
}

function localLinkInfo(base: string, suffix: string, { unicode = false } = {}): number[] {
  const headerSize = unicode ? 0x24 : 0x1c;
  const baseOffset = headerSize;
  const suffixOffset = baseOffset + (unicode ? wideZ(base) : ansiZ(base)).length;
  const strings = unicode ? [...wideZ(base), ...wideZ(suffix)] : [...ansiZ(base), ...ansiZ(suffix)];
  const fields = unicode
    ? [...u32(0), ...u32(0), ...u32(0), ...u32(0), ...u32(baseOffset), ...u32(suffixOffset)]
    : [...u32(0), ...u32(baseOffset), ...u32(0), ...u32(suffixOffset)];
  const size = headerSize + strings.length;
  return [...u32(size), ...u32(headerSize), ...u32(0x1), ...fields, ...strings];
}

function networkLinkInfo(share: string, suffix: string): number[] {
  const network = [...u32(0x14 + ansiZ(share).length), ...u32(0), ...u32(0x14), ...u32(0), ...u32(0), ...ansiZ(share)];
  const networkOffset = 0x1c;
  const suffixOffset = networkOffset + network.length;
  const size = suffixOffset + ansiZ(suffix).length;
  return [
    ...u32(size), ...u32(0x1c), ...u32(0x2), ...u32(0), ...u32(0), ...u32(networkOffset), ...u32(suffixOffset),
    ...network, ...ansiZ(suffix),
  ];
}

describe('shortcut files', () => {
  it('reads only small files named as shortcuts', () => {
    expect(mayBeShortcutFile('Docs.URL', 120)).toBe(true);
    expect(mayBeShortcutFile('page.webloc', 300)).toBe(true);
    expect(mayBeShortcutFile('report.pdf', 300)).toBe(false);
    expect(mayBeShortcutFile('big.url', MAX_SHORTCUT_FILE_SIZE + 1)).toBe(false);
  });

  it('reads an Internet Shortcut, titled by its file name', () => {
    const file = '[DEFAULT]\r\nBASEURL=https://wrong.example/\r\n[InternetShortcut]\r\nIconIndex=0\r\nURL=https://example.com/a?b=1\r\n';
    expect(shortcutPage('Example docs.url', text(file))).toEqual({
      title: 'Example docs',
      url: 'https://example.com/a?b=1',
    });
  });

  it('reads a desktop link by the name it gives itself, and nothing else a desktop entry runs', () => {
    expect(shortcutPage('x.desktop', text('[Desktop Entry]\nType=Link\nName=Wiki\nURL[$e]=https://wiki.example/\n')))
      .toEqual({ title: 'Wiki', url: 'https://wiki.example/' });
    expect(shortcutPage('x.desktop', text('[Desktop Entry]\nType=Application\nExec=rm -rf ~\nURL=https://a.example/\n')))
      .toBeUndefined();
  });

  it('reads a webloc in XML or binary form', () => {
    const xml = '<?xml version="1.0"?><plist version="1.0"><dict><key>URL</key><string>https://example.com/?a=1&amp;b=2</string></dict></plist>';
    expect(shortcutPage('Example.webloc', text(xml))).toEqual({
      title: 'Example',
      url: 'https://example.com/?a=1&b=2',
    });
    expect(shortcutPage('Short.webloc', binaryWebloc('https://a.io/'))?.url).toBe('https://a.io/');
    expect(shortcutPage('Long.inetloc', binaryWebloc('https://example.com/a/long/path'))?.url)
      .toBe('https://example.com/a/long/path');
    expect(shortcutPage('Wide.webloc', binaryWebloc('https://example.com/wide', { wide: true }))?.url)
      .toBe('https://example.com/wide');
  });

  it('reads where a Windows shell link points, on a drive or a share', () => {
    expect(shortcutPage('Report.lnk', shellLink(localLinkInfo('C:\\Users\\Me\\', 'My report.pdf'))))
      .toEqual({ title: 'Report', url: 'file:///C:/Users/Me/My%20report.pdf' });
    expect(shortcutPage('Wide.lnk', shellLink(localLinkInfo('D:\\Données\\', 'été.txt', { unicode: true })))?.url)
      .toBe('file:///D:/Donn%C3%A9es/%C3%A9t%C3%A9.txt');
    expect(shortcutPage('Share.lnk', shellLink(networkLinkInfo('\\\\server\\team', 'plan.docx')))?.url)
      .toBe('file://server/team/plan.docx');
  });

  it('gives nothing for broken, foreign, or unsafe shortcuts', () => {
    expect(shortcutPage('a.url', text('[InternetShortcut]\nURL=javascript:alert(1)\n'))).toBeUndefined();
    expect(shortcutPage('a.url', text('URL=https://outside.example/\n'))).toBeUndefined();
    expect(shortcutPage('a.webloc', Uint8Array.from([...ascii('bplist00'), 1, 2, 3]))).toBeUndefined();
    const truncated = binaryWebloc('https://example.com/');
    expect(shortcutPage('a.webloc', truncated.subarray(0, truncated.length - 4))).toBeUndefined();
    expect(shortcutPage('a.lnk', Uint8Array.from([0x4c, 0, 0, 0, 1, 2]))).toBeUndefined();
    expect(shortcutPage('a.lnk', shellLink(localLinkInfo('C:\\', 'x')).subarray(0, 0x50))).toBeUndefined();
    expect(shortcutPage('a.txt', text('[InternetShortcut]\nURL=https://example.com/\n'))).toBeUndefined();
  });

  it('turns Windows paths into file addresses', () => {
    expect(windowsPathUrl('C:\\a #1\\b.txt')).toBe('file:///C:/a%20%231/b.txt');
    expect(windowsPathUrl('\\\\host\\share\\c')).toBe('file://host/share/c');
    expect(windowsPathUrl('relative\\path')).toBeUndefined();
  });
});
