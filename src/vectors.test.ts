import { describe, it, expect } from 'vitest';
import { encodeVector, decodeVector, cosine, vectorNorm } from './vectors.js';

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
