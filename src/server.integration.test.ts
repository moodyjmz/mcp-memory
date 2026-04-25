import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync } from 'fs';
import { createTestDb, createTestIndex } from './test-helpers.js';
import type { MemoryDb } from './db.js';
import type { MemoryIndex } from './memory-index.js';
import type { MemoryCategory } from './types.js';

describe('integration: store → query → forget', () => {
  let db: MemoryDb;
  let index: MemoryIndex;
  let dbDir: string;
  let idxDir: string;

  beforeEach(() => {
    ({ db, dir: dbDir } = createTestDb());
    ({ index, dir: idxDir } = createTestIndex());
  });

  afterEach(() => {
    db.close();
    rmSync(dbDir, { recursive: true, force: true });
    rmSync(idxDir, { recursive: true, force: true });
  });

  async function store(text: string, category: MemoryCategory, project?: string) {
    const result = await index.addFact(text, { category, project });
    if (result.added) {
      db.insertMemory(result.id, text, category, null, null, project);
    }
    return result;
  }

  it('full lifecycle: store, query, enrich, forget', async () => {
    const { id, added } = await store('_themVal drops fallback defaults', 'decision', 'web-apps');
    expect(added).toBe(true);

    // Query via index
    const results = await index.queryFacts('_themVal drops fallback defaults', 5);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].id).toBe(id);

    // Enrich from db
    const row = db.getMemory(id);
    expect(row).toBeDefined();
    expect(row!.text).toBe('_themVal drops fallback defaults');
    expect(row!.project).toBe('web-apps');

    // Track access
    db.updateLastAccessed([id]);
    expect(db.getMemory(id)!.last_accessed).not.toBeNull();

    // Forget
    await index.deleteFact(id);
    db.deleteMemory(id);
    expect(db.getMemory(id)).toBeUndefined();
  });

  it('dedup across store calls', async () => {
    const first = await store('SVG icons use sprite injection', 'architecture');
    const second = await store('SVG icons use sprite injection', 'architecture');

    expect(first.added).toBe(true);
    expect(second.added).toBe(false);
    expect(db.countMemories()).toBe(1);
  });

  it('update: amended text is returned by subsequent query', async () => {
    const { id } = await store('original fact about LESS variables', 'gotcha', 'web-apps');

    // Simulate memory_update — update DB text + re-embed
    await index.updateFact(id, 'amended fact about webpack config', { category: 'gotcha', project: 'web-apps' });
    db.updateMemory(id, { text: 'amended fact about webpack config' });

    const results = await index.queryFacts('amended fact about webpack config', 5);
    const found = results.find(r => r.id === id);
    expect(found).toBeDefined();

    // SQL row should reflect the update (SQL is authoritative for display)
    const row = db.getMemory(id)!;
    expect(row.text).toBe('amended fact about webpack config');
  });

  it('eviction removes least-accessed memories', async () => {
    const maxMemories = 3;

    // Store memories with very distinct texts to avoid dedup
    const texts = [
      'alpha bravo charlie delta echo foxtrot',
      'golf hotel india juliet kilo lima',
      'mike november oscar papa quebec romeo',
      'sierra tango uniform victor whiskey xray',
      'zulu one two three four five six',
    ];

    const ids: string[] = [];
    for (const text of texts) {
      const result = await store(text, 'gotcha');
      if (result.added) ids.push(result.id);
    }
    expect(ids).toHaveLength(5);
    expect(db.countMemories()).toBe(5);

    // Access the last two so they're protected
    db.updateLastAccessed([ids[3], ids[4]]);

    // Evict
    const evictable = db.getEvictableIds({ maxMemories, maxAgeDays: 90 });
    expect(evictable).toHaveLength(2); // 5 - 3 = 2

    for (const eid of evictable) {
      await index.deleteFact(eid);
      db.deleteMemory(eid);
    }

    expect(db.countMemories()).toBe(3);
  });
});
