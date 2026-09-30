import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { randomUUID } from 'crypto';
import { restrictToOwner } from './permissions.js';
import { embedSource } from './embed-source.js';
import { encodeVector, decodeVector, vectorNorm, cosine, type VectorHit } from './vectors.js';
import type { MemoryRow, MemoryCategory, EvictionConfig, NewMemory, Embedded, StoreResult } from './types.js';
import { EVICTION_EXEMPT_CATEGORIES } from './types.js';

export const DEFAULT_DATA_DIR = path.join(os.homedir(), '.claude-memory');

/** A new memory whose top match scores above this is a duplicate. Global: every project, ephemerals included. */
export const DEDUP_THRESHOLD = 0.85;

const SCHEMA_VERSION = 1;
const BUSY_TIMEOUT_MS = 5000;

/**
 * Switching a rollback-journal file to WAL needs an exclusive lock, and when several
 * processes race for it SQLite returns BUSY without waiting for the busy timeout.
 * That happens when sessions start together on a new or pre-WAL database.
 */
function enableWal(db: BetterSqlite3.Database): void {
  const deadline = Date.now() + BUSY_TIMEOUT_MS;
  for (;;) {
    try {
      db.pragma('journal_mode = WAL');
      return;
    } catch (err) {
      if ((err as { code?: string }).code !== 'SQLITE_BUSY' || Date.now() > deadline) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
}

export interface RepoRelationship {
  id: number;
  source_project: string;
  target_project: string;
  relationship_type: string;
  description: string;
  file_path: string | null;
  created_at: string;
}

export interface MemoryUpdateFields {
  text?: string;
  category?: MemoryCategory;
  file_path?: string | null;
  tags?: string | null;
  pinned?: boolean;
  load_with?: string | null;
  ephemeral?: boolean;
}

export interface UnsearchableRow {
  id: string;
  text: string;
  tags: string | null;
}

export interface MemoryDb {
  insertMemory(id: string, text: string, category: MemoryCategory, file_path?: string | null, git_sha?: string | null, project?: string | null, pinned?: boolean, tags?: string | null, load_with?: string | null, ephemeral?: boolean): void;
  updateMemory(id: string, fields: MemoryUpdateFields): void;
  pinMemory(id: string): void;
  unpinMemory(id: string): void;
  deleteMemory(id: string): void;
  /** Dedup, insert the row and its vector, then evict, as one transaction. */
  storeMemory(memory: NewMemory, embedded: Embedded, eviction: EvictionConfig): StoreResult;
  /** Update the row; write the vector only if it still matches the row's text and tags afterwards. Returns whether it did. */
  updateMemoryAndVector(id: string, fields: MemoryUpdateFields, embedded: Embedded): boolean;
  /** Write the vector only if it was embedded from the row's current text and tags. False if the row changed or is gone. */
  putVectorIfCurrent(id: string, embedded: Embedded): boolean;
  searchVectors(queryVector: ArrayLike<number>, k: number, project?: string): VectorHit[];
  /** Rows search can't find as they read now: no vector, or one embedded from other text or tags. */
  listUnsearchable(project?: string): UnsearchableRow[];
  /** The row as it reads now if it is still unsearchable, otherwise undefined. */
  getUnsearchable(id: string): UnsearchableRow | undefined;
  getMemory(id: string): MemoryRow | undefined;
  listMemories(category?: MemoryCategory, project?: string): MemoryRow[];
  listEphemeralMemories(project: string): MemoryRow[];
  clearEphemeralMemories(project: string): string[];
  updateLastAccessed(ids: string[]): void;
  countMemories(): number;
  getEvictableIds(config: EvictionConfig): string[];
  addRelationship(source: string, target: string, type: string, description: string, file_path?: string | null): number;
  removeRelationship(id: number): void;
  getRepoMap(project?: string): RepoRelationship[];
  close(): void;
}

export function createMemoryDb(dbPath: string): MemoryDb {
  const dir = path.dirname(dbPath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  // One server process runs per Claude session, all on this file; writers wait up to 5s for each other
  const db: BetterSqlite3.Database = new Database(dbPath, { timeout: BUSY_TIMEOUT_MS });
  enableWal(db);
  // SQLite gives new -wal/-shm files the db file's mode, but existing ones keep theirs
  restrictToOwner(dir, [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]);

  db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        category TEXT NOT NULL,
        file_path TEXT,
        git_sha TEXT,
        project TEXT,
        created_at TEXT NOT NULL,
        last_accessed TEXT,
        pinned INTEGER NOT NULL DEFAULT 0,
        tags TEXT,
        load_with TEXT,
        ephemeral INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category);
      CREATE INDEX IF NOT EXISTS idx_memories_project ON memories(project);
      CREATE INDEX IF NOT EXISTS idx_memories_file_path ON memories(file_path);

      CREATE TABLE IF NOT EXISTS repo_relationships (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_project TEXT NOT NULL,
        target_project TEXT NOT NULL,
        relationship_type TEXT NOT NULL,
        description TEXT NOT NULL,
        file_path TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_rel_source ON repo_relationships(source_project);
      CREATE INDEX IF NOT EXISTS idx_rel_target ON repo_relationships(target_project);
    `);

    // Column migrations for DBs made by older versions; checked inside the lock so two processes can't both add one
    const columns = db.prepare('PRAGMA table_info(memories)').all() as { name: string }[];
    if (!columns.some(c => c.name === 'last_accessed')) {
      db.exec('ALTER TABLE memories ADD COLUMN last_accessed TEXT');
    }
    if (!columns.some(c => c.name === 'pinned')) {
      db.exec('ALTER TABLE memories ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0');
    }
    if (!columns.some(c => c.name === 'tags')) {
      db.exec('ALTER TABLE memories ADD COLUMN tags TEXT');
    }
    if (!columns.some(c => c.name === 'load_with')) {
      db.exec('ALTER TABLE memories ADD COLUMN load_with TEXT');
    }
    if (!columns.some(c => c.name === 'ephemeral')) {
      db.exec('ALTER TABLE memories ADD COLUMN ephemeral INTEGER NOT NULL DEFAULT 0');
    }
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_memories_ephemeral ON memories(ephemeral);

      -- A separate table, not a column: memory_list is SELECT * over memories
      CREATE TABLE IF NOT EXISTS memory_vectors (
        id TEXT PRIMARY KEY,
        dim INTEGER NOT NULL,
        source TEXT NOT NULL,
        vector BLOB NOT NULL
      );
      -- In SQL rather than code so deletes by any server version drop the vector too
      CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories
        BEGIN DELETE FROM memory_vectors WHERE id = OLD.id; END;
    `);
    if ((db.pragma('user_version', { simple: true }) as number) < SCHEMA_VERSION) {
      db.pragma(`user_version = ${SCHEMA_VERSION}`);
    }
  }).immediate();

  const exemptList = [...EVICTION_EXEMPT_CATEGORIES].map(() => '?').join(',');
  const evictableSql = `
    SELECT id FROM memories
    WHERE id IS NOT ? AND pinned = 0 AND ephemeral = 0 AND category NOT IN (${exemptList})
    ORDER BY COALESCE(last_accessed, created_at) ASC
    LIMIT ?`;
  const countStmt = db.prepare('SELECT COUNT(*) as count FROM memories');
  const evictStmt = db.prepare(`DELETE FROM memories WHERE id IN (${evictableSql})`);
  const getStmt = db.prepare('SELECT * FROM memories WHERE id = ?');
  const insertStmt = db.prepare(`
    INSERT OR REPLACE INTO memories (id, text, category, file_path, git_sha, project, created_at, last_accessed, pinned, tags, load_with, ephemeral)
    VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)
  `);
  const putVectorStmt = db.prepare('INSERT OR REPLACE INTO memory_vectors (id, dim, source, vector) VALUES (?, ?, ?, ?)');
  // The inner join skips vectors whose row is gone
  const vectorsStmt = db.prepare('SELECT v.id, v.vector FROM memory_vectors v JOIN memories m USING(id) WHERE v.dim = ?');
  const projectVectorsStmt = db.prepare('SELECT v.id, v.vector FROM memory_vectors v JOIN memories m USING(id) WHERE v.dim = ? AND m.project = ?');
  const sourcesSql = 'SELECT m.id, m.text, m.tags, v.source FROM memories m LEFT JOIN memory_vectors v USING(id)';
  const sourcesStmt = db.prepare(sourcesSql);
  const projectSourcesStmt = db.prepare(`${sourcesSql} WHERE m.project = ?`);
  const sourceStmt = db.prepare(`${sourcesSql} WHERE m.id = ?`);
  const sameTextStmt = db.prepare(`${sourcesSql} WHERE m.text = ?`);
  type SourceRow = UnsearchableRow & { source: string | null };
  // Compared in JS so embedSource stays the only definition of what gets embedded
  const unsearchable = (r: SourceRow) => r.source !== embedSource(r.text, r.tags);
  const withoutSource = ({ id, text, tags }: SourceRow): UnsearchableRow => ({ id, text, tags });

  function insertRow(id: string, text: string, category: MemoryCategory, file_path?: string | null, git_sha?: string | null, project?: string | null, pinned = false, tags: string | null = null, load_with: string | null = null, ephemeral = false): void {
    insertStmt.run(id, text, category, file_path ?? null, git_sha ?? null, project ?? null, new Date().toISOString(), pinned ? 1 : 0, tags ?? null, load_with ?? null, ephemeral ? 1 : 0);
  }

  function putVector(id: string, { vector, source }: Embedded): void {
    putVectorStmt.run(id, vector.length, source, encodeVector(vector));
  }

  function updateRow(id: string, fields: MemoryUpdateFields): void {
    const setParts: string[] = [];
    const params: unknown[] = [];

    if (fields.text !== undefined) { setParts.push('text = ?'); params.push(fields.text); }
    if (fields.category !== undefined) { setParts.push('category = ?'); params.push(fields.category); }
    if ('file_path' in fields) { setParts.push('file_path = ?'); params.push(fields.file_path ?? null); }
    if ('tags' in fields) { setParts.push('tags = ?'); params.push(fields.tags ?? null); }
    if (fields.pinned !== undefined) { setParts.push('pinned = ?'); params.push(fields.pinned ? 1 : 0); }
    if ('load_with' in fields) { setParts.push('load_with = ?'); params.push(fields.load_with ?? null); }
    if (fields.ephemeral !== undefined) { setParts.push('ephemeral = ?'); params.push(fields.ephemeral ? 1 : 0); }

    if (setParts.length === 0) return;
    params.push(id);
    db.prepare(`UPDATE memories SET ${setParts.join(', ')} WHERE id = ?`).run(...params);
  }

  function search(queryVector: ArrayLike<number>, k: number, project?: string): VectorHit[] {
    if (k <= 0) return [];
    const queryNorm = vectorNorm(queryVector);
    const rows = (project
      ? projectVectorsStmt.all(queryVector.length, project)
      : vectorsStmt.all(queryVector.length)) as Array<{ id: string; vector: Buffer }>;
    const hits = rows
      .map(row => ({ id: row.id, score: cosine(queryVector, queryNorm, decodeVector(row.vector)) }))
      .sort((a, b) => b.score - a.score);
    // A vector embedded from text the memory no longer has (edited by an older server, or
    // by another session mid-embed) would match the old wording; skip it until it is healed
    const current: VectorHit[] = [];
    for (const hit of hits) {
      // Outside a transaction another session can delete a hit after the scan; skip it
      const row = sourceStmt.get(hit.id) as SourceRow | undefined;
      if (row && !unsearchable(row)) current.push(hit);
      if (current.length === k) break;
    }
    return current;
  }

  /** Evict down to the limit, never the memory just stored (`keep`). */
  function evict(config: EvictionConfig, keep: string): number {
    const excess = (countStmt.get() as { count: number }).count - config.maxMemories;
    if (excess <= 0) return 0;
    return evictStmt.run([keep, ...EVICTION_EXEMPT_CATEGORIES, excess]).changes;
  }

  const storeTx = db.transaction((memory: NewMemory, embedded: Embedded, eviction: EvictionConfig): StoreResult => {
    const [top] = search(embedded.vector, 1);
    if (top && top.score > DEDUP_THRESHOLD) {
      return { stored: false, id: top.id, existing: (getStmt.get(top.id) as MemoryRow).text };
    }
    // Memories with no current vector are invisible to the check above; an identical text still counts
    const twin = (sameTextStmt.all(memory.text) as SourceRow[]).find(unsearchable);
    if (twin) return { stored: false, id: twin.id, existing: twin.text };
    const id = randomUUID();
    insertRow(id, memory.text, memory.category, memory.file_path, memory.git_sha, memory.project, memory.pinned, memory.tags, memory.load_with, memory.ephemeral);
    putVector(id, embedded);
    return { stored: true, id, evicted: evict(eviction, id) };
  });

  function putIfCurrent(id: string, embedded: Embedded): boolean {
    const row = getStmt.get(id) as MemoryRow | undefined;
    // Another session may have changed the text or tags since this vector was embedded
    if (!row || embedSource(row.text, row.tags) !== embedded.source) return false;
    putVector(id, embedded);
    return true;
  }

  const putIfCurrentTx = db.transaction(putIfCurrent);

  const updateTx = db.transaction((id: string, fields: MemoryUpdateFields, embedded: Embedded): boolean => {
    updateRow(id, fields);
    return putIfCurrent(id, embedded);
  });

  return {
    insertMemory: insertRow,

    updateMemory: updateRow,

    pinMemory(id) {
      db.prepare('UPDATE memories SET pinned = 1 WHERE id = ?').run(id);
    },

    unpinMemory(id) {
      db.prepare('UPDATE memories SET pinned = 0 WHERE id = ?').run(id);
    },

    deleteMemory(id) {
      db.prepare('DELETE FROM memories WHERE id = ?').run(id);
    },

    storeMemory(memory, embedded, eviction) {
      return storeTx.immediate(memory, embedded, eviction);
    },

    updateMemoryAndVector(id, fields, embedded) {
      return updateTx.immediate(id, fields, embedded);
    },

    putVectorIfCurrent(id, embedded) {
      return putIfCurrentTx.immediate(id, embedded);
    },

    searchVectors(queryVector, k, project?) {
      return search(queryVector, k, project);
    },

    listUnsearchable(project?) {
      const rows = (project ? projectSourcesStmt.all(project) : sourcesStmt.all()) as SourceRow[];
      return rows.filter(unsearchable).map(withoutSource);
    },

    getUnsearchable(id) {
      const row = sourceStmt.get(id) as SourceRow | undefined;
      return row && unsearchable(row) ? withoutSource(row) : undefined;
    },

    getMemory(id) {
      return getStmt.get(id) as MemoryRow | undefined;
    },

    listMemories(category?, project?) {
      let sql = 'SELECT * FROM memories WHERE 1=1';
      const params: string[] = [];

      if (category) {
        sql += ' AND category = ?';
        params.push(category);
      }
      if (project) {
        sql += ' AND project = ?';
        params.push(project);
      }

      sql += ' ORDER BY created_at DESC';
      return db.prepare(sql).all(...params) as MemoryRow[];
    },

    updateLastAccessed(ids) {
      if (ids.length === 0) return;
      const now = new Date().toISOString();
      const stmt = db.prepare('UPDATE memories SET last_accessed = ? WHERE id = ?');
      const tx = db.transaction(() => {
        for (const id of ids) {
          stmt.run(now, id);
        }
      });
      tx();
    },

    countMemories() {
      return (countStmt.get() as { count: number }).count;
    },

    getEvictableIds(config) {
      const excess = this.countMemories() - config.maxMemories;
      if (excess <= 0) return [];
      return (db.prepare(evictableSql).all([null, ...EVICTION_EXEMPT_CATEGORIES, excess]) as { id: string }[]).map(r => r.id);
    },

    listEphemeralMemories(project) {
      return db.prepare(
        'SELECT * FROM memories WHERE ephemeral = 1 AND project = ? ORDER BY created_at DESC'
      ).all(project) as MemoryRow[];
    },

    clearEphemeralMemories(project) {
      const rows = db.prepare(
        'DELETE FROM memories WHERE ephemeral = 1 AND project = ? RETURNING id'
      ).all(project) as { id: string }[];
      return rows.map(r => r.id);
    },

    addRelationship(source, target, type, description, file_path) {
      const result = db.prepare(`
        INSERT INTO repo_relationships (source_project, target_project, relationship_type, description, file_path, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(source, target, type, description, file_path ?? null, new Date().toISOString());
      return Number(result.lastInsertRowid);
    },

    removeRelationship(id) {
      db.prepare('DELETE FROM repo_relationships WHERE id = ?').run(id);
    },

    getRepoMap(project?) {
      if (project) {
        return db.prepare(
          'SELECT * FROM repo_relationships WHERE source_project = ? OR target_project = ? ORDER BY created_at DESC'
        ).all(project, project) as RepoRelationship[];
      }
      return db.prepare('SELECT * FROM repo_relationships ORDER BY created_at DESC').all() as RepoRelationship[];
    },

    close() {
      db.close();
    },
  };
}

// Default singleton for production
let _default: MemoryDb | null = null;

// Singleton branch untestable without polluting production code with a reset hook
/* v8 ignore next 5 */
export function getDefaultDb(): MemoryDb {
  if (!_default) {
    _default = createMemoryDb(path.join(DEFAULT_DATA_DIR, 'memory.db'));
  }
  return _default;
}
