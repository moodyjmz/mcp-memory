import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { seedMemories, mockEmbed } from './test-helpers.js';
import { createMemoryDb, type MemoryDb } from './db.js';

// Catches order-of-magnitude slowdowns only; `npm run bench` measures the real budget (50 ms at 10k)
describe('search at 10k memories', () => {
  let dir: string;
  let db: MemoryDb;

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'claude-memory-perf-'));
    await seedMemories(dir, 10_000);
    db = createMemoryDb(path.join(dir, 'memory.db'));
  });

  afterAll(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('scans every project in under 500 ms', async () => {
    const query = await mockEmbed('a query');
    db.searchVectors(query, 5); // warm the statement and page cache
    const start = performance.now();
    const hits = db.searchVectors(query, 5);
    expect(performance.now() - start).toBeLessThan(500);
    expect(hits).toHaveLength(5);
  });
});
