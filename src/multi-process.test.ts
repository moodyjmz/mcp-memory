import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { createMemoryDb } from './db.js';
import { TEST_DIST } from '../vitest.global-setup.js';

// Real processes on one data dir, as with one server per Claude session
const WORKER = path.join(__dirname, 'fixtures', 'store-worker.mjs');

interface Run { code: number | null; results: Array<{ stored: boolean; id: string }>; child: ChildProcess }

function worker(dataDir: string, mode: string, count: number, startAt: number, onLine?: (n: number, child: ChildProcess) => void): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WORKER, TEST_DIST, dataDir, mode, String(count), String(startAt)], { stdio: ['ignore', 'pipe', 'inherit'] });
    const results: Run['results'] = [];
    let buffered = '';
    child.stdout!.on('data', chunk => {
      buffered += chunk;
      const lines = buffered.split('\n');
      buffered = lines.pop()!;
      for (const line of lines) results.push(JSON.parse(line));
      onLine?.(results.length, child);
    });
    child.on('error', reject);
    child.on('close', code => resolve({ code, results, child }));
  });
}

describe('several server processes on one data dir', () => {
  let dataDir: string;
  let raw: Database.Database | undefined;

  beforeEach(() => {
    dataDir = mkdtempSync(path.join(tmpdir(), 'claude-memory-procs-'));
    createMemoryDb(path.join(dataDir, 'memory.db')).close();
  });

  afterEach(() => {
    raw?.close();
    raw = undefined;
    rmSync(dataDir, { recursive: true, force: true });
  });

  const counts = () => {
    raw ??= new Database(path.join(dataDir, 'memory.db'));
    return raw.prepare(`SELECT
      (SELECT COUNT(*) FROM memories) AS rows,
      (SELECT COUNT(*) FROM memory_vectors) AS vectors,
      (SELECT COUNT(*) FROM memories m LEFT JOIN memory_vectors v USING(id) WHERE v.id IS NULL) AS rows_without_vector`).get();
  };

  it('8 writers storing 25 facts each keep all 200 rows and vectors', async () => {
    const startAt = Date.now() + 1500;
    const runs = await Promise.all(Array.from({ length: 8 }, () => worker(dataDir, 'distinct', 25, startAt)));
    expect(runs.map(r => r.code)).toEqual(Array(8).fill(0));
    expect(runs.flatMap(r => r.results).every(r => r.stored)).toBe(true);
    expect(counts()).toEqual({ rows: 200, vectors: 200, rows_without_vector: 0 });
  });

  it('writers storing the same text at once keep one row, and every loser gets its id', async () => {
    const startAt = Date.now() + 1500;
    const runs = await Promise.all(Array.from({ length: 6 }, () => worker(dataDir, 'same', 1, startAt)));
    const results = runs.flatMap(r => r.results);
    const winners = results.filter(r => r.stored);
    expect(winners).toHaveLength(1);
    expect(results.filter(r => !r.stored).map(r => r.id)).toEqual(Array(5).fill(winners[0].id));
    expect(counts()).toEqual({ rows: 1, vectors: 1, rows_without_vector: 0 });
  });

  it('a writer killed mid-loop leaves no row without its vector', async () => {
    const run = await worker(dataDir, 'forever', 0, Date.now(), (n, child) => {
      if (n >= 30) child.kill('SIGKILL');
    });
    expect(run.child.signalCode).toBe('SIGKILL');
    const { rows, vectors, rows_without_vector } = counts() as { rows: number; vectors: number; rows_without_vector: number };
    expect(rows).toBeGreaterThanOrEqual(30);
    expect({ vectors, rows_without_vector }).toEqual({ vectors: rows, rows_without_vector: 0 });
  });

  it('processes migrating an old database at the same time all succeed', async () => {
    rmSync(dataDir, { recursive: true, force: true });
    dataDir = mkdtempSync(path.join(tmpdir(), 'claude-memory-procs-'));
    const old = new Database(path.join(dataDir, 'memory.db'));
    old.exec('CREATE TABLE memories (id TEXT PRIMARY KEY, text TEXT NOT NULL, category TEXT NOT NULL, file_path TEXT, git_sha TEXT, project TEXT, created_at TEXT NOT NULL)');
    old.close();

    const startAt = Date.now() + 1500;
    const runs = await Promise.all(Array.from({ length: 6 }, () => worker(dataDir, 'open', 0, startAt)));
    expect(runs.map(r => r.code)).toEqual(Array(6).fill(0));
    raw = new Database(path.join(dataDir, 'memory.db'));
    const columns = (raw.prepare('PRAGMA table_info(memories)').all() as { name: string }[]).map(c => c.name);
    expect(columns).toEqual(expect.arrayContaining(['last_accessed', 'pinned', 'tags', 'load_with', 'ephemeral']));
    expect(raw.pragma('user_version', { simple: true })).toBe(1);
  });
});
