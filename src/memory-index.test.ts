import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync, readFileSync } from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { createTestStore, mockEmbed } from './test-helpers.js';
import { createMemoryIndex, type MemoryIndex } from './memory-index.js';
import { DEDUP_THRESHOLD, type MemoryDb } from './db.js';
import { encodeVector } from './vectors.js';

describe('memory-index over SQLite', () => {
  let db: MemoryDb;
  let index: MemoryIndex;
  let dir: string;
  let raw: Database.Database;

  beforeEach(() => {
    ({ db, index, dir } = createTestStore({ maxMemories: 3 }));
    raw = new Database(path.join(dir, 'memory.db'));
  });

  afterEach(() => {
    raw.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const vectorCount = () => (raw.prepare('SELECT COUNT(*) AS n FROM memory_vectors').get() as { n: number }).n;
  const sourceOf = (id: string) => (raw.prepare('SELECT source FROM memory_vectors WHERE id = ?').get(id) as { source: string } | undefined)?.source;

  it('stores the row and its vector together', async () => {
    const res = await index.addFact({ text: 'fact', category: 'gotcha', project: 'p', tags: 'a, b', pinned: true });
    expect(res.stored).toBe(true);
    expect(db.getMemory(res.id)).toMatchObject({ text: 'fact', project: 'p', tags: 'a, b', pinned: 1 });
    expect(sourceOf(res.id)).toBe('fact a, b');
  });

  it('dedups across projects and against ephemerals', async () => {
    const first = await index.addFact({ text: 'same', category: 'gotcha', project: 'p1', ephemeral: true });
    const second = await index.addFact({ text: 'same', category: 'decision', project: 'p2' });
    expect(second).toEqual({ stored: false, id: first.id, existing: 'same' });
    expect(db.countMemories()).toBe(1);
  });

  it('queries by similarity, filtered by project and limited to topK', async () => {
    for (const text of ['alpha', 'bravo', 'charlie']) await index.addFact({ text, category: 'gotcha', project: 'p1' });
    await index.addFact({ text: 'delta', category: 'gotcha', project: 'p2' });
    const hits = await index.queryFacts('bravo', 2, 'p1');
    expect(hits).toHaveLength(2);
    expect(db.getMemory(hits[0].id)?.text).toBe('bravo');
    expect(hits[0].score).toBeCloseTo(1, 6);
    expect((await index.queryFacts('delta', 10, 'p1')).map(h => db.getMemory(h.id)?.project)).not.toContain('p2');
  });

  it('evicts in the store transaction and leaves no orphan vectors', async () => {
    for (const text of ['one', 'two', 'three']) await index.addFact({ text, category: 'gotcha' });
    const res = await index.addFact({ text: 'four', category: 'gotcha' });
    expect(res).toMatchObject({ stored: true, evicted: 1 });
    expect(db.countMemories()).toBe(3);
    expect(vectorCount()).toBe(3);
  });

  it('updateFact re-embeds when text or tags change', async () => {
    const { id } = await index.addFact({ text: 'old', category: 'gotcha' });
    expect(await index.updateFact(id, { text: 'new' })).toBe(true);
    expect(sourceOf(id)).toBe('new');
    expect(await index.updateFact(id, { tags: 'x' })).toBe(true);
    expect(sourceOf(id)).toBe('new x');
    const [hit] = await index.queryFacts('new x', 1);
    expect(hit).toMatchObject({ id });
  });

  it('updateFact without a text or tag change only updates the row', async () => {
    const { id } = await index.addFact({ text: 'stable', category: 'gotcha' });
    expect(await index.updateFact(id, { category: 'decision', pinned: true })).toBe(false);
    expect(db.getMemory(id)).toMatchObject({ category: 'decision', pinned: 1 });
    expect(sourceOf(id)).toBe('stable');
  });

  it('updateFact on a missing id does nothing', async () => {
    expect(await index.updateFact('missing', { text: 'x' })).toBe(false);
    expect(db.countMemories()).toBe(0);
  });

  it('updateFact keeps the old vector when another session changes the text mid-embed', async () => {
    const { id } = await index.addFact({ text: 'original', category: 'gotcha' });
    const racing = createMemoryIndex(db, {
      embed: async text => {
        db.updateMemory(id, { text: 'changed elsewhere' });
        return mockEmbed(text);
      },
    });
    expect(await racing.updateFact(id, { tags: 't' })).toBe(true);
    expect(db.getMemory(id)).toMatchObject({ text: 'changed elsewhere', tags: 't' });
    // The embedded 'original t' no longer describes the row, so it must not be written
    expect(sourceOf(id)).toBe('original');
  });

  it('deleting a row drops its vector, whichever server version deletes it', async () => {
    const { id } = await index.addFact({ text: 'gone', category: 'gotcha' });
    raw.prepare('DELETE FROM memories WHERE id = ?').run(id);
    expect(vectorCount()).toBe(0);
  });

  it('clearing ephemerals drops their vectors', async () => {
    await index.addFact({ text: 'eph', category: 'gotcha', project: 'p', ephemeral: true });
    await index.addFact({ text: 'kept', category: 'gotcha', project: 'p' });
    db.clearEphemeralMemories('p');
    expect(vectorCount()).toBe(1);
  });

  it('search skips vectors without a row and vectors of another dimension', async () => {
    const { id } = await index.addFact({ text: 'real', category: 'gotcha' });
    const put = raw.prepare('INSERT INTO memory_vectors (id, dim, source, vector) VALUES (?, ?, ?, ?)');
    put.run('orphan', 384, 'real', encodeVector(await mockEmbed('real')));
    db.insertMemory('short', 'short', 'gotcha');
    put.run('short', 3, 'short', encodeVector([1, 0, 0]));
    expect((await index.queryFacts('real', 10)).map(h => h.id)).toEqual([id]);
  });

  it('memory_list rows carry no vector data', async () => {
    await index.addFact({ text: 'listed', category: 'gotcha' });
    expect(Object.keys(db.listMemories()[0])).not.toContain('vector');
  });
});

describe('score parity with Vectra 0.15.0', () => {
  const fixture = JSON.parse(readFileSync(path.join(__dirname, 'fixtures', 'vectra-scores.json'), 'utf8')) as {
    items: Record<string, number[]>;
    queries: Record<string, number[]>;
    expected: Record<string, Array<{ id: string; score: number }>>;
  };
  let db: MemoryDb;
  let dir: string;

  beforeEach(() => {
    ({ db, dir } = createTestStore());
    // Seeded directly: several fixture items are near-duplicates that the store would refuse
    const raw = new Database(path.join(dir, 'memory.db'));
    for (const [id, vector] of Object.entries(fixture.items)) {
      db.insertMemory(id, id, 'gotcha');
      raw.prepare('INSERT INTO memory_vectors (id, dim, source, vector) VALUES (?, ?, ?, ?)').run(id, vector.length, id, encodeVector(vector));
    }
    raw.close();
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it.each(Object.keys(fixture.queries))('ranks and scores %s like Vectra', qid => {
    const hits = db.searchVectors(fixture.queries[qid], 50);
    expect(hits.map(h => h.id)).toEqual(fixture.expected[qid].map(e => e.id));
    hits.forEach((h, i) => expect(Math.abs(h.score - fixture.expected[qid][i].score)).toBeLessThan(1e-6));
  });

  it('puts the dedup boundary on the same side as Vectra', () => {
    const scores = Object.fromEntries(db.searchVectors(fixture.queries.q1, 50).map(h => [h.id, h.score]));
    expect(scores['boundary-above']).toBeGreaterThan(DEDUP_THRESHOLD);
    expect(scores['boundary-below']).toBeLessThanOrEqual(DEDUP_THRESHOLD);
  });

  it('dedups a store only when the best match is above the threshold', () => {
    const store = () => db.storeMemory({ text: 'q1', category: 'gotcha' }, { vector: fixture.queries.q1, source: 'q1' }, { maxMemories: 100 });
    db.deleteMemory('near');
    expect(store()).toMatchObject({ stored: false, id: 'boundary-above' });
    db.deleteMemory('boundary-above');
    expect(store().stored).toBe(true);
  });
});
