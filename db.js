import Database from 'better-sqlite3';
import path from 'path';
import os from 'os';
import fs from 'fs';

const DATA_DIR = path.join(os.homedir(), '.claude-memory');
const DB_PATH = path.join(DATA_DIR, 'memory.db');

let _db = null;

function getDb() {
  if (_db) return _db;

  fs.mkdirSync(DATA_DIR, { recursive: true });
  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');

  _db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      category TEXT NOT NULL,
      file_path TEXT,
      git_sha TEXT,
      project TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category);
    CREATE INDEX IF NOT EXISTS idx_memories_project ON memories(project);
    CREATE INDEX IF NOT EXISTS idx_memories_file_path ON memories(file_path);
  `);

  return _db;
}

export function insertMemory(id, text, category, file_path, git_sha, project) {
  const db = getDb();
  db.prepare(`
    INSERT OR REPLACE INTO memories (id, text, category, file_path, git_sha, project, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, text, category, file_path || null, git_sha || null, project || null, new Date().toISOString());
}

export function deleteMemory(id) {
  const db = getDb();
  return db.prepare('DELETE FROM memories WHERE id = ?').run(id);
}

export function getMemory(id) {
  const db = getDb();
  return db.prepare('SELECT * FROM memories WHERE id = ?').get(id);
}

export function listMemories(category, project) {
  const db = getDb();
  let sql = 'SELECT * FROM memories WHERE 1=1';
  const params = [];

  if (category) {
    sql += ' AND category = ?';
    params.push(category);
  }
  if (project) {
    sql += ' AND project = ?';
    params.push(project);
  }

  sql += ' ORDER BY created_at DESC';
  return db.prepare(sql).all(...params);
}
