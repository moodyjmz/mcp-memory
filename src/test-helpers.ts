import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { createMemoryDb, type MemoryDb } from './db.js';
import { createMemoryIndex, type MemoryIndex } from './memory-index.js';
import { createServer, type ServerDeps } from './create-server.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

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
 * Create an isolated test vector index in a temp directory.
 * Uses mockEmbed by default.
 */
export function createTestIndex(embedFn = mockEmbed): { index: MemoryIndex; dir: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'claude-memory-idx-'));
  const index = createMemoryIndex(dir, embedFn);
  return { index, dir };
}

/**
 * Open the stores in a data dir the way one server process does. Two calls on
 * the same dir behave like two Claude sessions sharing ~/.claude-memory.
 */
export function openStore(dataDir: string, embedFn = mockEmbed): { db: MemoryDb; index: MemoryIndex } {
  return {
    db: createMemoryDb(path.join(dataDir, 'memory.db')),
    index: createMemoryIndex(path.join(dataDir, 'vector_index'), embedFn),
  };
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
