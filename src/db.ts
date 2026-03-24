import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';
import path from 'path';
import os from 'os';
import fs from 'fs';
import type { MemoryRow, MemoryCategory, EvictionConfig } from './types.js';

const DEFAULT_DATA_DIR = path.join(os.homedir(), '.claude-memory');

export interface RepoRelationship {
  id: number;
  source_project: string;
  target_project: string;
  relationship_type: string;
  description: string;
  file_path: string | null;
  created_at: string;
}

export interface MemoryDb {
  insertMemory(id: string, text: string, category: MemoryCategory, file_path?: string | null, git_sha?: string | null, project?: string | null): void;
  deleteMemory(id: string): void;
  getMemory(id: string): MemoryRow | undefined;
  listMemories(category?: MemoryCategory, project?: string): MemoryRow[];
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
  fs.mkdirSync(dir, { recursive: true });

  const db: BetterSqlite3.Database = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      category TEXT NOT NULL,
      file_path TEXT,
      git_sha TEXT,
      project TEXT,
      created_at TEXT NOT NULL,
      last_accessed TEXT
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

  // Migrate: add last_accessed column if missing (existing DBs)
  const columns = db.prepare("PRAGMA table_info(memories)").all() as { name: string }[];
  if (!columns.some(c => c.name === 'last_accessed')) {
    db.exec('ALTER TABLE memories ADD COLUMN last_accessed TEXT');
  }

  return {
    insertMemory(id, text, category, file_path, git_sha, project) {
      db.prepare(`
        INSERT OR REPLACE INTO memories (id, text, category, file_path, git_sha, project, created_at, last_accessed)
        VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
      `).run(id, text, category, file_path ?? null, git_sha ?? null, project ?? null, new Date().toISOString());
    },

    deleteMemory(id) {
      db.prepare('DELETE FROM memories WHERE id = ?').run(id);
    },

    getMemory(id) {
      return db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as MemoryRow | undefined;
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
      const row = db.prepare('SELECT COUNT(*) as count FROM memories').get() as { count: number };
      return row.count;
    },

    getEvictableIds(config) {
      const excess = this.countMemories() - config.maxMemories;
      if (excess <= 0) return [];

      return (db.prepare(`
        SELECT id FROM memories
        ORDER BY COALESCE(last_accessed, created_at) ASC
        LIMIT ?
      `).all(excess) as { id: string }[]).map(r => r.id);
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

export function getDefaultDb(): MemoryDb {
  if (!_default) {
    _default = createMemoryDb(path.join(DEFAULT_DATA_DIR, 'memory.db'));
  }
  return _default;
}
