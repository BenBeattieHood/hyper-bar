import type { SearchItem } from './search';
import { pageIdentity } from './urlIdentity';

/**
 * Search compares every record against every keystroke, so the text it compares
 * is normalised once per record object and kept until that object is dropped.
 * The search controller hands over the same objects while a record is unchanged
 * (see `internSearchItems` in `searchProjection.ts`), so this survives revisions.
 */

/** Lowercased, accent-free letters and digits only, the form ordered fuzzy matching reads. */
export function fuzzyCharacters(value: string): string {
  return value
    .normalize('NFKD')
    .toLocaleLowerCase()
    .replace(/\p{M}/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

/**
 * True when every character of `query` appears in `value` in order. `value`
 * comes from `fuzzyCharacters`, and `query` is the characters of one, so a
 * character outside the Basic Multilingual Plane stays whole.
 */
export function orderedFuzzyCharactersMatch(value: string, query: readonly string[]): boolean {
  if (query.length === 0) return false;
  let offset = 0;
  for (const character of query) {
    offset = value.indexOf(character, offset);
    if (offset < 0) return false;
    offset += character.length;
  }
  return true;
}

/** What URL block matching searches: host, path, query and hash, decoded, letters only. */
export function urlSearchLetters(value: string): string {
  let searchable = value;
  try {
    const url = new URL(value);
    searchable = `${url.hostname}${url.pathname}${url.search}${url.hash}`;
  } catch {
    // Search non-standard URLs as supplied.
  }
  try {
    searchable = decodeURIComponent(searchable);
  } catch {
    // Keep malformed escape sequences intact.
  }
  return searchable.toLocaleLowerCase().replace(/[^\p{L}]+/gu, '');
}

const wordCharacter = /[\p{L}\p{N}]/u;

function isWordCharacter(character: string): boolean {
  const code = character.charCodeAt(0);
  if (code < 0x80) {
    return (code >= 0x61 && code <= 0x7a) || (code >= 0x30 && code <= 0x39) ||
      (code >= 0x41 && code <= 0x5a);
  }
  return wordCharacter.test(character);
}

/**
 * 4 when `value` is `term`, 3 when it begins with it, 2 when a word in it does,
 * else 0. Both are already lowercased; `term` is not empty.
 */
export function lowerWordStartQuality(value: string, term: string): number {
  let offset = value.indexOf(term);
  while (offset >= 0) {
    if (offset === 0) return value.length === term.length ? 4 : 3;
    if (!isWordCharacter(value[offset - 1]!)) return 2;
    offset = value.indexOf(term, offset + 1);
  }
  return 0;
}

/** One query, normalised once for every record it is compared with. */
export interface SearchTerm {
  /** Trimmed and lowercased. */
  text: string;
  /** Whether it is all letters and digits, so a match at a word start lies within one word. */
  singleWord: boolean;
  /** The query's distinct words, lowercased, when it has more than one. */
  words: readonly string[];
  /** The characters ordered fuzzy matching looks for. */
  fuzzy: readonly string[];
  urlLetters: string;
}

/** A query or text as search compares it: trimmed and lowercased. */
export function normaliseQuery(query: string): string {
  return query.trim().toLocaleLowerCase();
}

export function searchTerm(query: string): SearchTerm {
  const text = normaliseQuery(query);
  const words = [...new Set(text.split(/\s+/).filter(Boolean))];
  return {
    fuzzy: [...fuzzyCharacters(text)],
    singleWord: /^[\p{L}\p{N}]+$/u.test(text),
    text,
    urlLetters: text.replace(/[^\p{L}]+/gu, ''),
    words: words.length > 1 ? words : [],
  };
}

/**
 * 4 equal, 3 prefix, 2 a word begins with the term, 1 contains it, else 0.
 * `value` is lowercased already.
 */
export function lowerMatchQuality(value: string, term: SearchTerm): number {
  const { text } = term;
  if (value === text) return 4;
  if (value.startsWith(text)) return 3;
  // A term with a separator in it cannot begin one word of the value.
  if (term.singleWord && lowerWordStartQuality(value, text) > 0) return 2;
  return value.includes(text) ? 1 : 0;
}

/**
 * Whether a URL matches: the query's letters run unbroken through the URL's
 * (`urlSearchLetters`), or each word of a query of several begins a word of the
 * lowercased URL. Letters scattered in separate parts of the URL do not match.
 */
export function lowerUrlMatch(urlLetters: string, url: string, term: SearchTerm): boolean {
  if (term.urlLetters.length >= 3 && urlLetters.includes(term.urlLetters)) return true;
  return term.words.length > 0 && term.words.every((word) => lowerWordStartQuality(url, word) > 0);
}

/** The normalised text of one record. */
export class SearchItemText {
  readonly title: string;
  readonly detail: string;
  readonly url: string;
  readonly content: string;
  /** Names of the folders holding the record, outermost first, lowercased. */
  readonly folders: readonly string[];
  /** Names of the spaces holding the record, lowercased. */
  readonly spaces: readonly string[];
  readonly identity: string | undefined;
  private fuzzyFields: readonly string[] | undefined;
  private urlLettersValue: string | undefined;

  constructor(private readonly item: SearchItem) {
    this.title = item.title.toLocaleLowerCase();
    this.detail = item.detail.toLocaleLowerCase();
    this.url = (item.url ?? '').toLocaleLowerCase();
    this.content = (item.content ?? '').toLocaleLowerCase();
    this.folders = itemFolders(item).map((folder) => folder.toLocaleLowerCase());
    this.spaces = itemSpaceTitles(item).map((space) => space.toLocaleLowerCase());
    this.identity = item.kind === 'folder' ? undefined : pageIdentity(item.url) ?? undefined;
  }

  /** Title, detail, URL and page text in the form ordered fuzzy matching reads. */
  get fuzzy(): readonly string[] {
    this.fuzzyFields ??= [this.item.title, this.item.detail, this.item.url, this.item.content]
      .flatMap((value) => value === undefined ? [] : [fuzzyCharacters(value)]);
    return this.fuzzyFields;
  }

  get urlLetters(): string {
    this.urlLettersValue ??= this.item.url ? urlSearchLetters(this.item.url) : '';
    return this.urlLettersValue;
  }
}

const texts = new WeakMap<SearchItem, SearchItemText>();

export function searchItemText(item: SearchItem): SearchItemText {
  let text = texts.get(item);
  if (!text) texts.set(item, text = new SearchItemText(item));
  return text;
}

/**
 * The folders holding a bookmark, folder or tab. A bookmark's detail lists its
 * folders then its space or root, which is the fallback for records that do
 * not name their folders.
 */
export function itemFolders(item: SearchItem): readonly string[] {
  if (item.folders) return item.folders;
  if (item.kind !== 'bookmark' && item.kind !== 'folder') return [];
  return item.source === 'favourite' ? [] : item.detail.split(' / ').slice(0, -1);
}

/** The spaces a bookmark or tab lives in, by name. */
function itemSpaceTitles(item: SearchItem): readonly string[] {
  if (item.kind === 'tab') return item.openSpaces?.map((space) => space.title) ?? [];
  if ((item.kind === 'bookmark' || item.kind === 'folder') && item.spaceId) {
    return item.detail.split(' / ').slice(-1);
  }
  return [];
}
