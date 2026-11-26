import { describe, expect, it } from 'vitest';
import {
  clipboardContents,
  clipboardFormats,
  HYPER_CLIPBOARD_TYPE,
  parseHyperClipboard,
  pastedPages,
  type HyperClipboard,
} from './itemClipboard';

const clipboard = (items: HyperClipboard['items']): HyperClipboard => ({
  hyper: 1,
  installationId: 'install',
  items,
  operation: 'copy',
});

describe('clipboard formats', () => {
  it('gives a plain text field only the address, and rich editors a titled link', () => {
    const formats = clipboardFormats(clipboard([{
      kind: 'bookmark',
      metadata: { isCustomName: true },
      nodeId: 'b1',
      title: 'Docs & "guides"',
      url: 'https://example.test/docs?a=1&b=2',
    }]));

    expect(formats['text/plain']).toBe('https://example.test/docs?a=1&b=2');
    expect(formats['text/uri-list']).toBe('https://example.test/docs?a=1&b=2');
    expect(formats['text/html']).toBe(
      '<a href="https://example.test/docs?a=1&amp;b=2">Docs &amp; &quot;guides&quot;</a>',
    );
    expect(parseHyperClipboard(formats[HYPER_CLIPBOARD_TYPE] ?? '')).toEqual(clipboard([{
      kind: 'bookmark',
      metadata: { isCustomName: true },
      nodeId: 'b1',
      title: 'Docs & "guides"',
      url: 'https://example.test/docs?a=1&b=2',
    }]));
  });

  it('lists a folder\u2019s pages one per line and nests them in the link list', () => {
    const formats = clipboardFormats(clipboard([
      {
        children: [
          { kind: 'bookmark', title: 'Guide', url: 'https://example.test/guide' },
          { kind: 'bookmark', title: 'Run me', url: 'javascript:alert(1)' },
          { kind: 'bookmark', title: 'Guide again', url: 'https://example.test/guide' },
        ],
        kind: 'folder',
        title: 'Docs',
      },
      { kind: 'tab', tabId: 4, title: 'News', url: 'https://example.test/news' },
    ]));

    expect(formats['text/plain']).toBe('https://example.test/guide\nhttps://example.test/news');
    expect(formats['text/uri-list']).toBe('https://example.test/guide\r\nhttps://example.test/news');
    expect(formats['text/html']).toBe(
      '<ul><li>Docs<ul><li><a href="https://example.test/guide">Guide</a></li><li>Run me</li>' +
      '<li><a href="https://example.test/guide">Guide again</a></li></ul></li>' +
      '<li><a href="https://example.test/news">News</a></li></ul>',
    );
  });

  it('falls back to titles when nothing copied has an address', () => {
    const formats = clipboardFormats(clipboard([{ children: [], kind: 'folder', title: 'Empty' }]));

    expect(formats['text/plain']).toBe('Empty');
    expect(formats['text/uri-list']).toBeUndefined();
  });
});

describe('reading a paste', () => {
  it('reads Hyper\u2019s own format strictly, as any page could have written it', () => {
    expect(parseHyperClipboard('not json')).toBeUndefined();
    expect(parseHyperClipboard(JSON.stringify({ hyper: 2, items: [], operation: 'copy' }))).toBeUndefined();
    expect(parseHyperClipboard(JSON.stringify({
      hyper: 1,
      items: [{ kind: 'tab', title: 'x' }],
      operation: 'move',
    }))).toBeUndefined();
    expect(parseHyperClipboard(JSON.stringify({
      hyper: 1,
      installationId: 7,
      items: [
        { kind: 'script', title: 'Nope' },
        { kind: 'tab', nodeId: 'n'.repeat(200), tabId: 1.5, title: 'x'.repeat(3_000), url: 3 },
      ],
      operation: 'cut',
      windowId: 'nine',
    }))).toEqual({
      hyper: 1,
      items: [{ kind: 'tab', title: 'x'.repeat(2_048) }],
      operation: 'cut',
    });
    expect(parseHyperClipboard(JSON.stringify({
      hyper: 1,
      items: [{ kind: 'session-tab', nodeId: 'r1', title: 'Remote', url: 'https://remote.test/' }],
      operation: 'cut',
    }))?.items).toEqual([{ kind: 'session-tab', nodeId: 'r1', title: 'Remote', url: 'https://remote.test/' }]);
  });

  it('finds the addresses in pasted text, one per line', () => {
    expect(pastedPages('https://a.test/\r\nnot an address\nhttps://b.test/x\nhttps://a.test/'))
      .toEqual([
        { title: 'https://a.test/', url: 'https://a.test/' },
        { title: 'https://b.test/x', url: 'https://b.test/x' },
      ]);
    expect(pastedPages('javascript:alert(1)')).toEqual([]);
  });

  it('takes Hyper\u2019s account and the text from a paste event', () => {
    const json = JSON.stringify(clipboard([{ kind: 'tab', tabId: 1, title: 'Tab', url: 'https://a.test/' }]));
    const data = new Map([[HYPER_CLIPBOARD_TYPE, json], ['text/plain', 'https://a.test/']]);
    const transfer = { getData: (type: string) => data.get(type) ?? '' };

    expect(clipboardContents(transfer)).toEqual({
      hyper: clipboard([{ kind: 'tab', tabId: 1, title: 'Tab', url: 'https://a.test/' }]),
      text: 'https://a.test/',
    });
    expect(clipboardContents({ getData: (type) => type === 'text/plain' ? 'hello' : '' }))
      .toEqual({ text: 'hello' });
    expect(clipboardContents(null)).toEqual({ text: '' });
  });
});
