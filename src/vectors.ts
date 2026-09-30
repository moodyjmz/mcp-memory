import os from 'os';

// Vectors are stored as Float32Array bytes; that layout is only portable between
// little-endian hosts, which is every platform onnxruntime-node ships for.
if (os.endianness() !== 'LE') {
  throw new Error('claude-memory stores vectors little-endian and cannot run on a big-endian host');
}

export interface VectorHit {
  id: string;
  score: number;
}

export function encodeVector(vector: ArrayLike<number>): Buffer {
  const f32 = Float32Array.from(vector);
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
}

/** Copies the bytes: a BLOB's Buffer can start at an offset that isn't 4-aligned. */
export function decodeVector(blob: Uint8Array): Float32Array {
  const copy = new Uint8Array(blob.byteLength);
  copy.set(blob);
  return new Float32Array(copy.buffer);
}

export function vectorNorm(v: ArrayLike<number>): number {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += v[i] * v[i];
  return Math.sqrt(sum);
}

/** Cosine similarity, dot / (|a|·|b|), the formula Vectra used. A zero vector scores 0. */
export function cosine(a: ArrayLike<number>, aNorm: number, b: ArrayLike<number>): number {
  let dot = 0;
  let bb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    bb += b[i] * b[i];
  }
  if (aNorm === 0 || bb === 0) return 0;
  return dot / (aNorm * Math.sqrt(bb));
}
