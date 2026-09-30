import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { openStore, connectServer, type TestClient } from './test-helpers.js';
import type { MemoryDb } from './db.js';

const P = 'https://example.test/org/repo';

describe('tools', () => {
  let dataDir: string;
  let notesDir: string;
  let db: MemoryDb;
  let client: TestClient;

  beforeEach(async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), 'claude-memory-tools-'));
    notesDir = mkdtempSync(path.join(tmpdir(), 'claude-memory-notes-'));
    const store = openStore(dataDir);
    db = store.db;
    client = await connectServer({ ...store, eviction: { maxMemories: 3 }, notesRoot: () => notesDir });
  });

  afterEach(async () => {
    await client.close();
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(notesDir, { recursive: true, force: true });
  });

  it('memory_store stores a fact and reports what it stored', async () => {
    const res = await client.call('memory_store', { text: 'alpha fact', category: 'gotcha', project: P, tags: ['a', 'b'] });
    expect(res).toMatchObject({ stored: true, category: 'gotcha', project: P, tags: ['a', 'b'], pinned: false, ephemeral: false });
    expect(db.getMemory(res.id)?.tags).toBe('a, b');
  });

  it('memory_store rejects a semantic duplicate with the existing id', async () => {
    const first = await client.call('memory_store', { text: 'same fact', category: 'gotcha', project: P });
    const second = await client.call('memory_store', { text: 'same fact', category: 'gotcha', project: 'https://example.test/other/repo' });
    expect(second).toMatchObject({ stored: false, existing: 'same fact', existing_id: first.id });
    expect(db.countMemories()).toBe(1);
  });

  it('memory_store evicts the least recently used memories over the limit', async () => {
    for (const text of ['one', 'two', 'three']) {
      await client.call('memory_store', { text, category: 'gotcha', project: P });
    }
    const res = await client.call('memory_store', { text: 'four', category: 'gotcha', project: P });
    expect(res.evicted).toBe(1);
    expect(db.countMemories()).toBe(3);
    const found = await client.call('memory_query', { text: 'one', project: P, topK: 10 });
    expect(found.results.map((r: { text: string }) => r.text)).not.toContain('one');
  });

  it('memory_query returns the SQL row, scores and tag-linked also_relevant', async () => {
    const hit = await client.call('memory_store', { text: 'query target', category: 'decision', project: P, tags: ['shared'] });
    const linked = await client.call('memory_store', { text: 'unrelated wording', category: 'gotcha', project: P, tags: ['shared'] });
    // Tags are embedded with the text, so this is the exact string that was embedded
    const res = await client.call('memory_query', { text: 'query target shared', project: P, topK: 1 });
    expect(res.results).toHaveLength(1);
    expect(res.results[0]).toMatchObject({ id: hit.id, text: 'query target', category: 'decision', project: P, score: 1, stale: false });
    expect(res.also_relevant).toEqual([{ id: linked.id, text: 'unrelated wording', category: 'gotcha', tags: ['shared'], shared_tags: 1 }]);
    expect(db.getMemory(hit.id)?.last_accessed).not.toBeNull();
  });

  it('memory_query filters by project', async () => {
    await client.call('memory_store', { text: 'in project', category: 'gotcha', project: P });
    await client.call('memory_store', { text: 'elsewhere', category: 'gotcha', project: 'https://example.test/other/repo' });
    const res = await client.call('memory_query', { text: 'elsewhere', project: P, topK: 10 });
    expect(res.results.map((r: { text: string }) => r.text)).toEqual(['in project']);
  });

  it('memory_update re-embeds changed text so the new wording is found', async () => {
    const { id } = await client.call('memory_store', { text: 'old wording', category: 'gotcha', project: P });
    const res = await client.call('memory_update', { id, text: 'new wording', pinned: true });
    expect(res).toMatchObject({ updated: true, id, text: 'new wording', pinned: true, re_embedded: true });
    const found = await client.call('memory_query', { text: 'new wording', project: P, topK: 1 });
    expect(found.results[0]).toMatchObject({ id, score: 1 });
  });

  it('memory_update without text or tag changes does not re-embed', async () => {
    const { id } = await client.call('memory_store', { text: 'stable', category: 'gotcha', project: P });
    const res = await client.call('memory_update', { id, category: 'decision' });
    expect(res).toMatchObject({ updated: true, category: 'decision', re_embedded: false });
  });

  it('memory_update reports a missing id', async () => {
    expect(await client.call('memory_update', { id: 'nope', text: 'x' })).toEqual({ updated: false, reason: 'Memory not found' });
  });

  it('memory_forget removes the memory from search and the database', async () => {
    const { id } = await client.call('memory_store', { text: 'to forget', category: 'gotcha', project: P });
    expect(await client.call('memory_forget', { id })).toEqual({ forgotten: true, id, text: 'to forget' });
    expect(db.getMemory(id)).toBeUndefined();
    const found = await client.call('memory_query', { text: 'to forget', project: P });
    expect(found.results).toEqual([]);
    expect(await client.call('memory_forget', { id })).toEqual({ forgotten: false, reason: 'Memory not found' });
  });

  it('memory_list returns rows filtered by category', async () => {
    await client.call('memory_store', { text: 'listed', category: 'decision', project: P });
    await client.call('memory_store', { text: 'filtered out', category: 'gotcha', project: P });
    const rows = await client.call('memory_list', { category: 'decision', project: P });
    expect(rows.map((r: { text: string }) => r.text)).toEqual(['listed']);
  });

  it('memory_project_summary separates session state from long-term memories', async () => {
    await client.call('memory_store', { text: 'long term', category: 'decision', project: P, pinned: true });
    await client.call('memory_store', { text: 'working state', category: 'gotcha', project: P, ephemeral: true });
    const res = await client.call('memory_project_summary', { project: P });
    expect(res.total_memories).toBe(1);
    expect(res.category_counts).toEqual({ decision: 1 });
    expect(res.pinned_memories.map((m: { text: string }) => m.text)).toEqual(['long term']);
    expect(res.session_state.map((m: { text: string }) => m.text)).toEqual(['working state']);
  });

  it('memory_clear_ephemerals removes only the project ephemerals, from search too', async () => {
    const eph = await client.call('memory_store', { text: 'ephemeral note', category: 'gotcha', project: P, ephemeral: true });
    await client.call('memory_store', { text: 'kept', category: 'gotcha', project: P });
    const res = await client.call('memory_clear_ephemerals', { project: P });
    expect(res).toEqual({ cleared: 1, ids: [eph.id], project: P });
    const found = await client.call('memory_query', { text: 'ephemeral note', project: P, topK: 10 });
    expect(found.results.map((r: { text: string }) => r.text)).toEqual(['kept']);
  });

  it('memory_store_file writes the note and stores a searchable pointer', async () => {
    const res = await client.call('memory_store_file', {
      name: 'findings', content: '# notes', pointer_text: 'where the findings live', category: 'architecture', project: P,
    });
    expect(res).toMatchObject({ written: true, memory_stored: true, project: P });
    expect(readFileSync(res.file_path, 'utf8')).toBe('# notes');
    const found = await client.call('memory_query', { text: 'where the findings live', project: P, topK: 1 });
    expect(found.results[0]).toMatchObject({ id: res.memory_id, file_path: res.file_path });
  });

  it('memory_store_file refuses to overwrite an existing note', async () => {
    const args = { name: 'findings', content: 'first', pointer_text: 'first pointer', category: 'architecture', project: P };
    await client.call('memory_store_file', args);
    const res = await client.call('memory_store_file', { ...args, content: 'second', pointer_text: 'second pointer' });
    expect(res.written).toBe(false);
    expect(res.error).toMatch(/already exists/);
    expect(db.countMemories()).toBe(1);
  });

  it.each(['memory_project_summary', 'memory_graph', 'memory_clear_ephemerals'])('%s needs a project', async tool => {
    const res = await client.call(tool, {});
    expect(res.error).toMatch(/Could not determine project/);
  });

  it('memory_graph groups excerpts by category', async () => {
    const { id } = await client.call('memory_store', { text: 'x'.repeat(130), category: 'decision', project: P, tags: ['t'] });
    const res = await client.call('memory_graph', { project: P });
    expect(res).toMatchObject({ project: P, total: 1 });
    expect(res.by_category.decision).toEqual([{ id, excerpt: 'x'.repeat(117) + '...', tags: ['t'], file_path: null, pinned: false, load_with: null }]);
  });

  it('repo_link, repo_map and repo_unlink manage relationships', async () => {
    expect(await client.call('repo_map', {})).toEqual({ relationships: [], message: 'No cross-repo relationships stored yet' });
    const link = await client.call('repo_link', { source: 'lib', target: 'app', relationship_type: 'provides', description: 'types' });
    expect(link).toMatchObject({ linked: true, source: 'lib', target: 'app' });
    const map = await client.call('repo_map', { project: 'app' });
    expect(map.map((r: { id: number }) => r.id)).toEqual([link.id]);
    expect(await client.call('repo_unlink', { id: link.id })).toEqual({ unlinked: true, id: link.id });
  });
});

// Two servers on one data dir model two Claude sessions: each runs its own process
describe('two sessions sharing one data dir', () => {
  let dataDir: string;
  let stores: Array<ReturnType<typeof openStore>>;
  let clients: TestClient[];

  async function session(): Promise<TestClient> {
    const store = openStore(dataDir);
    stores.push(store);
    const client = await connectServer(store);
    clients.push(client);
    return client;
  }

  beforeEach(() => {
    dataDir = mkdtempSync(path.join(tmpdir(), 'claude-memory-sessions-'));
    stores = [];
    clients = [];
  });

  afterEach(async () => {
    for (const c of clients) await c.close();
    for (const s of stores) s.db.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it.fails('a store in one session is searchable from another already running', async () => {
    const a = await session();
    const b = await session();
    await a.call('memory_query', { text: 'warm up', project: P });
    const stored = await b.call('memory_store', { text: 'stored by b', category: 'gotcha', project: P });
    const found = await a.call('memory_query', { text: 'stored by b', project: P, topK: 1 });
    expect(found.results[0]?.id).toBe(stored.id);
  });

  it.fails('dedup sees memories stored by another session', async () => {
    const a = await session();
    const b = await session();
    await a.call('memory_query', { text: 'warm up', project: P });
    await b.call('memory_store', { text: 'stored twice', category: 'gotcha', project: P });
    const second = await a.call('memory_store', { text: 'stored twice', category: 'gotcha', project: P });
    expect(second.stored).toBe(false);
  });

  it.fails('a store in one session does not erase a store made by another', async () => {
    const a = await session();
    const b = await session();
    await a.call('memory_query', { text: 'warm up', project: P });
    const fromB = await b.call('memory_store', { text: 'stored by b', category: 'gotcha', project: P });
    await a.call('memory_store', { text: 'stored by a', category: 'gotcha', project: P });
    const later = await session();
    const found = await later.call('memory_query', { text: 'stored by b', project: P, topK: 1 });
    expect(found.results[0]?.id).toBe(fromB.id);
  });
});
