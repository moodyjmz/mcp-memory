import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { createMemoryDb, type MemoryDb } from './db.js';
import { createMemoryIndex, type MemoryIndex } from './memory-index.js';
import { createServer, type ServerDeps } from './create-server.js';
import type { EvictionConfig } from './types.js';
import { encodeVector } from './vectors.js';
import Database from 'better-sqlite3';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

/**
 * Fill a data dir with `count` memories and vectors across `projects` projects,
 * bypassing dedup so large stores seed in one transaction. Used by the search
 * benchmark and its regression test.
 */
export async function seedMemories(dataDir: string, count: number, projects = 20): Promise<void> {
  createMemoryDb(path.join(dataDir, 'memory.db')).close();
  const raw = new Database(path.join(dataDir, 'memory.db'));
  const vectors = await Promise.all(Array.from({ length: count }, (_, i) => mockEmbed(`seed memory ${i}`)));
  const row = raw.prepare("INSERT INTO memories (id, text, category, project, created_at) VALUES (?, ?, 'gotcha', ?, '2026-01-01T00:00:00.000Z')");
  const vec = raw.prepare('INSERT INTO memory_vectors (id, dim, source, vector) VALUES (?, ?, ?, ?)');
  raw.transaction(() => {
    vectors.forEach((v, i) => {
      row.run(`seed-${i}`, `seed memory ${i}`, `project-${i % projects}`);
      vec.run(`seed-${i}`, v.length, `seed memory ${i}`, encodeVector(v));
    });
  })();
  raw.close();
}

/**
 * Deterministic 384-dim embedding from text.
 * Uses a seeded hash so different texts produce meaningfully different vectors.
 * No model download needed — fast for tests.
 */
export function mockEmbed(text: string): Promise<number[]> {
  const vector = new Array<number>(384).fill(0);

  // Hash each character into multiple spread-out dimensions with more entropy
  let seed = 0;
  for (let i = 0; i < text.length; i++) {
    seed = ((seed << 5) - seed + text.charCodeAt(i)) | 0;
  }

  // Use the seed to fill the vector — each text gets a very different pattern
  for (let i = 0; i < 384; i++) {
    seed = ((seed << 13) ^ seed) | 0;
    seed = (seed * 1664525 + 1013904223) | 0;
    vector[i] = (seed & 0xffff) / 0xffff - 0.5;
  }

  // Normalize to unit vector
  const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0)) || 1;
  for (let i = 0; i < vector.length; i++) {
    vector[i] /= norm;
  }

  return Promise.resolve(vector);
}

/**
 * Create an isolated test database in a temp directory.
 */
export function createTestDb(): { db: MemoryDb; dir: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'claude-memory-test-'));
  const db = createMemoryDb(path.join(dir, 'test.db'));
  return { db, dir };
}

/**
 * Create an isolated test database and an index over it in a temp directory.
 * Uses mockEmbed.
 */
export function createTestStore(eviction?: EvictionConfig): { db: MemoryDb; index: MemoryIndex; dir: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'claude-memory-test-'));
  return { ...openStore(dir, { eviction }), dir };
}

/**
 * Open the stores in a data dir the way one server process does. Two calls on
 * the same dir behave like two Claude sessions sharing ~/.claude-memory.
 */
export function openStore(dataDir: string, { eviction }: { eviction?: EvictionConfig } = {}): { db: MemoryDb; index: MemoryIndex } {
  const db = createMemoryDb(path.join(dataDir, 'memory.db'));
  return { db, index: createMemoryIndex(db, { embed: mockEmbed, eviction }) };
}

export interface TestClient {
  /** Call a tool and parse the JSON it returns */
  call(name: string, args?: Record<string, unknown>): Promise<any>;
  close(): Promise<void>;
}

/** Connect an MCP client to a createServer() instance over an in-memory transport. */
export async function connectServer(deps: ServerDeps): Promise<TestClient> {
  const server = createServer(deps);
  const client = new Client({ name: 'test', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    async call(name, args = {}) {
      const result = await client.callTool({ name, arguments: args });
      const content = result.content as Array<{ type: string; text: string }>;
      if (result.isError) throw new Error(`${name} failed: ${content[0]?.text}`);
      return JSON.parse(content[0].text);
    },
    async close() {
      await client.close();
      await server.close();
    },
  };
}
