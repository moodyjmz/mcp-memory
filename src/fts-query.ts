/** The trigram tokenizer can't match a term shorter than three characters. */
const MIN_TERM = 3;
/** A longer term is a substring search over its every trigram; its first 64 characters identify it. */
const MAX_TERM = 64;
/** Each term is a separate index lookup; common ones match most rows, so cost grows with the count. */
const MAX_TERMS = 16;
/**
 * Function words carry no search intent, and as substrings they match inside unrelated words
 * ("the" in "other").
 */
const STOPWORDS = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'any', 'can', 'had', 'has', 'her', 'his',
  'him', 'how', 'its', 'may', 'our', 'out', 'she', 'too', 'was', 'way', 'who', 'why', 'did', 'does',
  'get', 'got', 'let', 'say', 'use', 'yes', 'with', 'this', 'that', 'from', 'they', 'have', 'what',
  'when', 'were', 'will', 'your', 'been', 'more', 'some', 'than', 'them', 'then', 'there', 'these',
  'those', 'which', 'would', 'about', 'into', 'only', 'also', 'just', 'like', 'over', 'such', 'very',
  'each', 'other', 'could', 'should', 'their', 'where', 'while', 'after', 'before', 'because', 'here',
  'most', 'much', 'same', 'well', 'need', 'make', 'thing', 'things',
]);

/** A digit, underscore, inner capital, all caps, or a dot or hyphen inside: written as code, not prose. */
const IDENTIFIER = /[\p{N}_]|\p{Ll}\p{Lu}|^\p{Lu}{2,}$|[\p{L}\p{N}][.-][\p{L}\p{N}]/u;

/**
 * FTS5 MATCH expressions for free text, to try in order until one matches: first every word
 * of the text, then any identifier in it. Matching any single word instead lets one shared
 * common word ("fail") rank a memory as high as the best match by meaning.
 * Words match as substrings, case-insensitively. Every term is a double-quoted string, so
 * nothing in the text is read as query syntax (column filters, NEAR, AND/OR/NOT, `*`, `^`).
 */
export function toFtsQueries(text: string): string[] {
  const terms = new Map<string, boolean>(); // term → part of an identifier
  // NFC so an NFD and an NFC spelling of one word count once; the tokenizer folds diacritics itself
  collect: for (const [token] of text.normalize('NFC').matchAll(/[\p{L}\p{M}\p{N}_.-]+/gu)) {
    const identifier = IDENTIFIER.test(token);
    for (const [word] of token.toLowerCase().matchAll(/[\p{L}\p{M}\p{N}_]+/gu)) {
      const term = [...word].slice(0, MAX_TERM).join('');
      if ([...term].length < MIN_TERM || STOPWORDS.has(term)) continue;
      terms.set(term, identifier || (terms.get(term) ?? false));
      if (terms.size === MAX_TERMS) break collect;
    }
  }
  const quote = (term: string) => `"${term}"`;
  if (terms.size === 0) return [];
  const all = [...terms.keys()].map(quote).join(' AND ');
  const identifiers = [...terms].filter(([, identifier]) => identifier).map(([term]) => quote(term)).join(' OR ');
  return identifiers && identifiers !== all ? [all, identifiers] : [all];
}
