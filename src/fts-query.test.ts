import { describe, it, expect } from 'vitest';
import { rmSync } from 'fs';
import { toFtsQueries } from './fts-query.js';
import { createTestDb } from './test-helpers.js';

describe('toFtsQueries', () => {
  it('asks for every word, then for any identifier', () => {
    expect(toFtsQueries('Retry on 429 in fetchQuota')).toEqual([
      '"retry" AND "429" AND "fetchquota"',
      '"429" OR "fetchquota"',
    ]);
  });

  it('asks only for every word when the text has no identifier', () => {
    expect(toFtsQueries('big file uploads fail')).toEqual(['"big" AND "file" AND "uploads" AND "fail"']);
  });

  it('recognises identifiers by digits, underscores, inner capitals, all caps, dots and hyphens', () => {
    for (const id of ['E_QUOTA_429', 'v1024', 'fetchQuota', 'CSS', 'host.docker.internal', 'legacy-peer-deps']) {
      expect(toFtsQueries(`explain ${id}`)).toHaveLength(2);
    }
    expect(toFtsQueries('Ends a sentence.')).toHaveLength(1);
  });

  it('asks once when the only word is an identifier', () => {
    expect(toFtsQueries('MAX_COUNT')).toEqual(['"max_count"']);
  });

  it('skips function words, which would match inside unrelated words', () => {
    expect(toFtsQueries('how do I fix the thing in parser')).toEqual(['"fix" AND "parser"']);
    expect(toFtsQueries('what is the')).toEqual([]);
  });

  it('is empty when no word is long enough', () => {
    expect(toFtsQueries('a b ci')).toEqual([]);
    expect(toFtsQueries('')).toEqual([]);
  });

  it('counts code points, not UTF-16 units, toward the minimum', () => {
    expect(toFtsQueries('𝒜b')).toEqual([]);
  });

  it('normalises to NFC and keeps combining marks in the word', () => {
    expect(toFtsQueries('café')).toEqual(['"café"']);
  });

  it('dedups words and caps their number and length', () => {
    expect(toFtsQueries('word Word WORD')).toEqual(['"word"']);
    const many = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ');
    expect(toFtsQueries(many)[0].split(' AND ')).toHaveLength(16);
    expect(toFtsQueries('x'.repeat(8000))).toEqual([`"${'x'.repeat(64)}"`]);
  });

  it('never lets query syntax through to the index', () => {
    const { db, dir } = createTestDb();
    try {
      db.insertMemory('m1', 'text: NEAR(one two) ^start* "quoted"', 'gotcha', null, null, null, false, 'tags');
      const hostile = ['text : one', 'NEAR(one two)', '^start*', '"unterminated', 'a AND NOT b', 'tags:quoted', '(((', '-- ;',
        '‍‮', '\ud800', '\u0000abc', '́́́', 'x"y"z OR "w'];
      for (const text of hostile) expect(() => db.searchKeywords(text, 5)).not.toThrow();
      expect(db.searchKeywords('quoted', 5)).toEqual(['m1']);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
