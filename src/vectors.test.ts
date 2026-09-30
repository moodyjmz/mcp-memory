import { describe, it, expect } from 'vitest';
import { encodeVector, decodeVector, cosine, vectorNorm, topK } from './vectors.js';

describe('vector encoding', () => {
  it('round-trips through Float32 bytes', () => {
    const v = [0.5, -1.25, 3, 1e-7];
    const blob = encodeVector(v);
    expect(blob.byteLength).toBe(16);
    expect(Array.from(decodeVector(blob))).toEqual(v.map(Math.fround));
  });

  it('decodes a blob that starts at an offset which is not 4-aligned', () => {
    const encoded = encodeVector([1, 2, 3]);
    const backing = Buffer.alloc(encoded.byteLength + 1);
    encoded.copy(backing, 1);
    expect(Array.from(decodeVector(backing.subarray(1)))).toEqual([1, 2, 3]);
  });
});

describe('cosine', () => {
  it('ignores magnitude', () => {
    const a = [1, 2, 3];
    expect(cosine(a, vectorNorm(a), [2, 4, 6])).toBeCloseTo(1, 12);
  });

  it('scores a zero vector 0, not NaN', () => {
    expect(cosine([0, 0], 0, [1, 1])).toBe(0);
    expect(cosine([1, 1], vectorNorm([1, 1]), [0, 0])).toBe(0);
  });
});

describe('topK', () => {
  const hits = [0.2, 0.9, -0.5, 0.7, 0.9, 0.1].map((score, i) => ({ id: `h${i}`, score }));

  it('returns the k best, highest first, keeping first-seen order on ties', () => {
    expect(topK(hits, 3)).toEqual([{ id: 'h1', score: 0.9 }, { id: 'h4', score: 0.9 }, { id: 'h3', score: 0.7 }]);
  });

  it('returns everything sorted when k exceeds the count', () => {
    expect(topK(hits, 50).map(h => h.score)).toEqual([0.9, 0.9, 0.7, 0.2, 0.1, -0.5]);
  });

  it('returns nothing for k = 0', () => {
    expect(topK(hits, 0)).toEqual([]);
  });
});
