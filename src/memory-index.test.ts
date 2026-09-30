import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync, readFileSync } from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { createTestStore, openStore, mockEmbed } from './test-helpers.js';
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

  it('updateFact reports no re-embed when the memory is deleted mid-embed', async () => {
    const { id } = await index.addFact({ text: 'doomed', category: 'gotcha' });
    const racing = createMemoryIndex(db, { embed: async text => { db.deleteMemory(id); return mockEmbed(text); } });
    expect(await racing.updateFact(id, { text: 'doomed v2' })).toBe(false);
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
    expect(await racing.updateFact(id, { tags: 't' })).toBe(false);
    expect(db.getMemory(id)).toMatchObject({ text: 'changed elsewhere', tags: 't' });
    // The embedded 'original t' no longer describes the row, so it must not be written
    expect(sourceOf(id)).toBe('original');
  });

  it('does not dedup or match against a vector the memory has outgrown', async () => {
    const { id } = await index.addFact({ text: 'fact A', category: 'gotcha' });
    // An older server edits the text without touching the vector
    raw.prepare("UPDATE memories SET text = 'fact B' WHERE id = ?").run(id);
    expect((await index.queryFacts('fact A', 5)).map(h => h.id)).not.toContain(id);
    const again = await index.addFact({ text: 'fact A', category: 'gotcha' });
    expect(again.stored).toBe(true);
    await index.heal();
    const [hit] = await index.queryFacts('fact B', 1);
    expect(hit).toMatchObject({ id });
  });

  it('refuses the exact text of a memory that has no vector yet', async () => {
    db.insertMemory('legacy', 'the build needs node 22', 'gotcha');
    expect(await index.addFact({ text: 'the build needs node 22', category: 'decision' }))
      .toEqual({ stored: false, id: 'legacy', existing: 'the build needs node 22' });
    expect(db.countMemories()).toBe(1);
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

describe('heal: re-embedding unsearchable memories', () => {
  let db: MemoryDb;
  let index: MemoryIndex;
  let dir: string;
  let raw: Database.Database;

  beforeEach(() => {
    ({ db, index, dir } = createTestStore());
    raw = new Database(path.join(dir, 'memory.db'));
  });

  afterEach(() => {
    raw.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const counts = () => raw.prepare(`SELECT (SELECT COUNT(*) FROM memories) AS rows, (SELECT COUNT(*) FROM memory_vectors) AS vectors`).get();

  it('embeds every row that has no vector, and a second pass does nothing', async () => {
    for (let i = 0; i < 5; i++) db.insertMemory(`m${i}`, `row ${i}`, 'gotcha', null, null, 'p', false, i % 2 ? 'tag' : null);
    expect(db.listUnsearchable()).toHaveLength(5);
    expect(await index.heal()).toEqual({ embedded: 5, changed: 0, skipped: 0 });
    expect(db.listUnsearchable()).toEqual([]);
    const [hit] = await index.queryFacts('row 1 tag', 1);
    expect(hit).toMatchObject({ id: 'm1' });
    expect(await index.heal()).toEqual({ embedded: 0, changed: 0, skipped: 0 });
  });

  it('shares one pass between concurrent calls in a process', async () => {
    db.insertMemory('m', 'row', 'gotcha');
    const first = index.heal();
    expect(index.heal()).toBe(first);
    await first;
  });

  it('is safe with two processes healing the same rows at once', async () => {
    for (let i = 0; i < 20; i++) db.insertMemory(`m${i}`, `row ${i}`, 'gotcha');
    const other = openStore(dir);
    try {
      const results = await Promise.all([index.heal(), other.index.heal()]);
      expect(results.every(r => !r.error)).toBe(true);
      expect(counts()).toEqual({ rows: 20, vectors: 20 });
    } finally {
      other.db.close();
    }
  });

  it('skips rows another process re-embedded after the pass listed them', async () => {
    for (let i = 0; i < 10; i++) db.insertMemory(`m${i}`, `row ${i}`, 'gotcha');
    const other = openStore(dir);
    try {
      let first = true;
      const slow = createMemoryIndex(db, {
        embed: async text => {
          // While this pass embeds its first row, another session heals everything
          if (first) { first = false; await other.index.heal(); }
          return mockEmbed(text);
        },
      });
      expect(await slow.heal()).toEqual({ embedded: 1, changed: 0, skipped: 9 });
      expect(counts()).toEqual({ rows: 10, vectors: 10 });
    } finally {
      other.db.close();
    }
  });

  it('never overwrites a vector written by a newer update', async () => {
    db.insertMemory('m', 'old text', 'gotcha');
    const racing = createMemoryIndex(db, {
      embed: async text => {
        if (text === 'old text') await index.updateFact('m', { text: 'newer text' });
        return mockEmbed(text);
      },
    });
    expect(await racing.heal()).toEqual({ embedded: 0, changed: 1, skipped: 0 });
    expect(raw.prepare("SELECT source FROM memory_vectors WHERE id = 'm'").get()).toEqual({ source: 'newer text' });
  });

  it('repairs what a pre-SQLite-vector server leaves behind', async () => {
    const { id: edited } = await index.addFact({ text: 'edited by an old server', category: 'gotcha' });
    const { id: deleted } = await index.addFact({ text: 'deleted by an old server', category: 'gotcha' });
    // What an old server does: it knows nothing of memory_vectors
    raw.prepare("INSERT INTO memories (id, text, category, created_at) VALUES ('new', 'stored by an old server', 'gotcha', '2026-01-01')").run();
    raw.prepare("UPDATE memories SET text = 'text an old server changed' WHERE id = ?").run(edited);
    raw.prepare('DELETE FROM memories WHERE id = ?').run(deleted);

    expect(db.listUnsearchable().map(r => r.id).sort()).toEqual([edited, 'new'].sort());
    expect(await index.heal()).toEqual({ embedded: 2, changed: 0, skipped: 0 });
    expect(db.listUnsearchable()).toEqual([]);
    expect(counts()).toEqual({ rows: 2, vectors: 2 });
  });

  it('logs and resolves when embedding fails', async () => {
    db.insertMemory('m', 'row', 'gotcha');
    const broken = createMemoryIndex(db, { embed: () => Promise.reject(new Error('model failed to load')) });
    expect(await broken.heal()).toEqual({ embedded: 0, changed: 0, skipped: 0, error: 'model failed to load' });
    expect(db.listUnsearchable()).toHaveLength(1);
  });

  it('counts unsearchable rows per project', () => {
    db.insertMemory('a', 'in p1', 'gotcha', null, null, 'p1');
    db.insertMemory('b', 'in p2', 'gotcha', null, null, 'p2');
    expect(db.listUnsearchable('p1')).toEqual([{ id: 'a', text: 'in p1', tags: null }]);
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
