import { describe, it, expect } from 'vitest';
import { fuseRanks } from './rank-fusion.js';

describe('fuseRanks', () => {
  it('ranks an id found by both lists above ids found by one', () => {
    expect(fuseRanks([['a', 'b', 'c'], ['c', 'd']])[0]).toBe('c');
  });

  it('interleaves two lists by rank, the first list winning ties', () => {
    expect(fuseRanks([['a', 'b'], ['x', 'y']])).toEqual(['a', 'x', 'b', 'y']);
  });

  it('counts an id once per list', () => {
    expect(fuseRanks([['a', 'a', 'b'], ['b']])).toEqual(['b', 'a']);
  });

  it('handles empty lists', () => {
    expect(fuseRanks([[], []])).toEqual([]);
    expect(fuseRanks([['a'], []])).toEqual(['a']);
  });
});
