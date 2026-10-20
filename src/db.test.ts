import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, statSync, chmodSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { createMemoryDb } from './db.js';
import { createTestDb } from './test-helpers.js';
import type { MemoryDb } from './db.js';

describe('db', () => {
  let db: MemoryDb;
  let dir: string;

  beforeEach(() => {
    ({ db, dir } = createTestDb());
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('inserts and retrieves a memory', () => {
    db.insertMemory('m1', 'LESS vars use lazy eval', 'convention', '/a/b.less', 'abc123', 'web-apps');
    const row = db.getMemory('m1');

    expect(row).toBeDefined();
    expect(row!.text).toBe('LESS vars use lazy eval');
    expect(row!.category).toBe('convention');
    expect(row!.file_path).toBe('/a/b.less');
    expect(row!.git_sha).toBe('abc123');
    expect(row!.project).toBe('web-apps');
    expect(row!.last_accessed).toBeNull();
  });

  it('returns undefined for missing memory', () => {
    expect(db.getMemory('nonexistent')).toBeUndefined();
  });

  it('deletes a memory', () => {
    db.insertMemory('m1', 'test', 'gotcha');
    db.deleteMemory('m1');
    expect(db.getMemory('m1')).toBeUndefined();
  });

  it('lists memories filtered by category', () => {
    db.insertMemory('m1', 'arch fact', 'architecture');
    db.insertMemory('m2', 'gotcha fact', 'gotcha');
    db.insertMemory('m3', 'another arch', 'architecture');

    const archRows = db.listMemories('architecture');
    expect(archRows).toHaveLength(2);
    expect(archRows.every(r => r.category === 'architecture')).toBe(true);
  });

  it('lists memories filtered by project', () => {
    db.insertMemory('m1', 'fact a', 'decision', null, null, 'project-a');
    db.insertMemory('m2', 'fact b', 'decision', null, null, 'project-b');

    const rows = db.listMemories(undefined, 'project-a');
    expect(rows).toHaveLength(1);
    expect(rows[0].project).toBe('project-a');
  });

  it('lists all memories when no filter', () => {
    db.insertMemory('m1', 'one', 'gotcha');
    db.insertMemory('m2', 'two', 'convention');
    expect(db.listMemories()).toHaveLength(2);
  });

  it('counts memories', () => {
    expect(db.countMemories()).toBe(0);
    db.insertMemory('m1', 'one', 'gotcha');
    db.insertMemory('m2', 'two', 'convention');
    expect(db.countMemories()).toBe(2);
  });

  it('updateLastAccessed is a no-op for empty array', () => {
    db.insertMemory('m1', 'one', 'gotcha');
    db.updateLastAccessed([]);
    expect(db.getMemory('m1')!.last_accessed).toBeNull();
  });

  it('updates last_accessed timestamps', () => {
    db.insertMemory('m1', 'one', 'gotcha');
    db.insertMemory('m2', 'two', 'convention');

    expect(db.getMemory('m1')!.last_accessed).toBeNull();

    db.updateLastAccessed(['m1']);

    expect(db.getMemory('m1')!.last_accessed).not.toBeNull();
    expect(db.getMemory('m2')!.last_accessed).toBeNull();
  });

  it('returns evictable IDs ordered by least recently used', () => {
    db.insertMemory('old', 'old fact', 'gotcha');
    db.insertMemory('mid', 'mid fact', 'gotcha');
    db.insertMemory('new', 'new fact', 'gotcha');

    // Access 'new' so it's least evictable
    db.updateLastAccessed(['new']);

    const ids = db.getEvictableIds({ maxMemories: 1 });
    // Should evict 2 (3 - 1 = 2), oldest/least-accessed first
    expect(ids).toHaveLength(2);
    // 'old' and 'mid' have no last_accessed, so sort by created_at ASC
    expect(ids).toContain('old');
    expect(ids).toContain('mid');
    expect(ids).not.toContain('new');
  });

  it('returns no evictable IDs when under limit', () => {
    db.insertMemory('m1', 'one', 'gotcha');
    const ids = db.getEvictableIds({ maxMemories: 10 });
    expect(ids).toHaveLength(0);
  });

  it('handles insertMemory with nullish optional fields', () => {
    db.insertMemory('m1', 'test', 'architecture', null, null, null);
    const row = db.getMemory('m1');
    expect(row!.file_path).toBeNull();
    expect(row!.git_sha).toBeNull();
    expect(row!.project).toBeNull();
  });

  it('stores a pinned memory', () => {
    db.insertMemory('m1', 'user preference', 'preference', null, null, null, true);
    const row = db.getMemory('m1');
    expect(row!.pinned).toBe(1);
  });

  it('defaults to unpinned', () => {
    db.insertMemory('m1', 'normal fact', 'gotcha');
    const row = db.getMemory('m1');
    expect(row!.pinned).toBe(0);
  });

  it('pins and unpins a memory', () => {
    db.insertMemory('m1', 'fact', 'gotcha');
    expect(db.getMemory('m1')!.pinned).toBe(0);

    db.pinMemory('m1');
    expect(db.getMemory('m1')!.pinned).toBe(1);

    db.unpinMemory('m1');
    expect(db.getMemory('m1')!.pinned).toBe(0);
  });

  it('excludes pinned memories from eviction', () => {
    db.insertMemory('pinned1', 'permanent fact', 'preference', null, null, null, true);
    db.insertMemory('normal1', 'temporary fact', 'gotcha');
    db.insertMemory('normal2', 'another temp', 'gotcha');

    const ids = db.getEvictableIds({ maxMemories: 1 });
    expect(ids).not.toContain('pinned1');
    expect(ids).toHaveLength(2); // both unpinned are candidates
  });
});

describe('updateMemory', () => {
  let db: MemoryDb;
  let dir: string;

  beforeEach(() => {
    ({ db, dir } = createTestDb());
    db.insertMemory('m1', 'original text', 'gotcha', '/a/b.ts', null, 'proj', false, 'tag1, tag2', null);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('updates text', () => {
    db.updateMemory('m1', { text: 'updated text' });
    expect(db.getMemory('m1')!.text).toBe('updated text');
  });

  it('updates category', () => {
    db.updateMemory('m1', { category: 'architecture' });
    expect(db.getMemory('m1')!.category).toBe('architecture');
  });

  it('updates tags', () => {
    db.updateMemory('m1', { tags: 'new1, new2' });
    expect(db.getMemory('m1')!.tags).toBe('new1, new2');
  });

  it('clears tags with null', () => {
    db.updateMemory('m1', { tags: null });
    expect(db.getMemory('m1')!.tags).toBeNull();
  });

  it('updates pinned', () => {
    db.updateMemory('m1', { pinned: true });
    expect(db.getMemory('m1')!.pinned).toBe(1);
    db.updateMemory('m1', { pinned: false });
    expect(db.getMemory('m1')!.pinned).toBe(0);
  });

  it('sets load_with', () => {
    db.updateMemory('m1', { load_with: 'abc,def' });
    expect(db.getMemory('m1')!.load_with).toBe('abc,def');
  });

  it('clears load_with with null', () => {
    db.updateMemory('m1', { load_with: 'abc' });
    db.updateMemory('m1', { load_with: null });
    expect(db.getMemory('m1')!.load_with).toBeNull();
  });

  it('leaves unmentioned fields unchanged', () => {
    db.updateMemory('m1', { text: 'changed' });
    const row = db.getMemory('m1')!;
    expect(row.category).toBe('gotcha');
    expect(row.tags).toBe('tag1, tag2');
    expect(row.file_path).toBe('/a/b.ts');
  });

  it('updates file_path', () => {
    db.updateMemory('m1', { file_path: '/new/path.ts' });
    expect(db.getMemory('m1')!.file_path).toBe('/new/path.ts');
  });

  it('clears file_path with null', () => {
    db.updateMemory('m1', { file_path: null });
    expect(db.getMemory('m1')!.file_path).toBeNull();
  });

  it('updates ephemeral to true', () => {
    db.updateMemory('m1', { ephemeral: true });
    expect(db.getMemory('m1')!.ephemeral).toBe(1);
  });

  it('no-op when no fields provided', () => {
    db.updateMemory('m1', {});
    expect(db.getMemory('m1')!.text).toBe('original text');
  });
});

describe('load_with on insertMemory', () => {
  let db: MemoryDb;
  let dir: string;

  beforeEach(() => ({ db, dir } = createTestDb()));

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('stores and retrieves load_with', () => {
    db.insertMemory('m1', 'fact one', 'gotcha', null, null, null, false, null, 'm2,m3');
    expect(db.getMemory('m1')!.load_with).toBe('m2,m3');
  });

  it('defaults load_with to null', () => {
    db.insertMemory('m1', 'fact one', 'gotcha');
    expect(db.getMemory('m1')!.load_with).toBeNull();
  });
});

describe('repo relationships', () => {
  let db: MemoryDb;
  let dir: string;

  beforeEach(() => {
    ({ db, dir } = createTestDb());
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('adds and retrieves a relationship', () => {
    const id = db.addRelationship('core-lib', 'frontend', 'provides', 'shared config constants', '/core-lib/src/config.ts');
    const map = db.getRepoMap();

    expect(map).toHaveLength(1);
    expect(map[0].id).toBe(id);
    expect(map[0].source_project).toBe('core-lib');
    expect(map[0].target_project).toBe('frontend');
    expect(map[0].relationship_type).toBe('provides');
    expect(map[0].description).toBe('shared config constants');
    expect(map[0].file_path).toBe('/core-lib/src/config.ts');
  });

  it('filters by project', () => {
    db.addRelationship('core-lib', 'frontend', 'provides', 'shared types');
    db.addRelationship('api-server', 'frontend', 'provides', 'REST endpoints');
    db.addRelationship('core-lib', 'mobile-app', 'provides', 'utility functions');

    const frontend = db.getRepoMap('frontend');
    expect(frontend).toHaveLength(2);

    const coreLib = db.getRepoMap('core-lib');
    expect(coreLib).toHaveLength(2);

    const mobile = db.getRepoMap('mobile-app');
    expect(mobile).toHaveLength(1);
  });

  it('removes a relationship', () => {
    const id = db.addRelationship('repo-a', 'repo-b', 'depends_on', 'build output');
    db.removeRelationship(id);
    expect(db.getRepoMap()).toHaveLength(0);
  });

  it('returns empty array when no relationships', () => {
    expect(db.getRepoMap()).toHaveLength(0);
    expect(db.getRepoMap('nonexistent')).toHaveLength(0);
  });
});

describe('migrations', () => {
  it('adds missing columns to an existing legacy database', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'claude-memory-migration-test-'));
    const dbPath = path.join(dir, 'legacy.db');

    // Create a minimal legacy schema without the migration columns
    const raw = new Database(dbPath);
    raw.exec(`
      CREATE TABLE memories (
        id TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        category TEXT NOT NULL,
        file_path TEXT,
        git_sha TEXT,
        project TEXT,
        created_at TEXT NOT NULL
      );
    `);
    raw.close();

    // createMemoryDb should run migrations and add the missing columns
    const db = createMemoryDb(dbPath);
    const columns = (new Database(dbPath)).prepare('PRAGMA table_info(memories)').all() as { name: string }[];
    const names = columns.map(c => c.name);

    expect(names).toContain('last_accessed');
    expect(names).toContain('pinned');
    expect(names).toContain('tags');
    expect(names).toContain('load_with');
    expect(names).toContain('ephemeral');

    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('adds the vector table and schema version to a v4 database, keeping its rows', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'claude-memory-migration-test-'));
    const dbPath = path.join(dir, 'memory.db');
    try {
      const v4 = new Database(dbPath);
      v4.exec(`
        CREATE TABLE memories (id TEXT PRIMARY KEY, text TEXT NOT NULL, category TEXT NOT NULL, file_path TEXT, git_sha TEXT,
          project TEXT, created_at TEXT NOT NULL, last_accessed TEXT, pinned INTEGER NOT NULL DEFAULT 0, tags TEXT, load_with TEXT,
          ephemeral INTEGER NOT NULL DEFAULT 0);
        INSERT INTO memories (id, text, category, created_at) VALUES ('old', 'migrated from v4', 'gotcha', '2026-01-01T00:00:00.000Z');
      `);
      v4.close();

      createMemoryDb(dbPath).close();
      const db = createMemoryDb(dbPath); // a second open must be a no-op
      const raw = new Database(dbPath);
      expect(raw.pragma('user_version', { simple: true })).toBe(3);
      expect(raw.prepare("SELECT name FROM sqlite_master WHERE name IN ('memory_vectors', 'memories_ad', 'memories_fts', 'memories_au_stamp')").all()).toHaveLength(4);
      expect(db.searchKeywords('migrated', 5)).toEqual(['old']);
      expect(db.getMemory('old')?.text).toBe('migrated from v4');
      expect(raw.prepare('SELECT COUNT(*) AS n FROM memory_vectors').get()).toEqual({ n: 0 });
      raw.close();
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('ephemeral memories', () => {
  let db: MemoryDb;
  let dir: string;

  beforeEach(() => {
    ({ db, dir } = createTestDb());
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('defaults to non-ephemeral', () => {
    db.insertMemory('m1', 'fact', 'gotcha');
    expect(db.getMemory('m1')!.ephemeral).toBe(0);
  });

  it('stores an ephemeral memory', () => {
    db.insertMemory('m1', 'current task', 'decision', null, null, 'proj', false, null, null, true);
    expect(db.getMemory('m1')!.ephemeral).toBe(1);
  });

  it('promotes via updateMemory', () => {
    db.insertMemory('m1', 'docker setup', 'architecture', null, null, 'proj', false, null, null, true);
    db.updateMemory('m1', { ephemeral: false });
    expect(db.getMemory('m1')!.ephemeral).toBe(0);
  });

  it('listEphemeralMemories returns only ephemerals for the project', () => {
    db.insertMemory('e1', 'task spec', 'decision', null, null, 'proj-a', false, null, null, true);
    db.insertMemory('e2', 'working cmd', 'convention', null, null, 'proj-a', false, null, null, true);
    db.insertMemory('p1', 'long-term fact', 'architecture', null, null, 'proj-a');
    db.insertMemory('e3', 'other project ephemeral', 'decision', null, null, 'proj-b', false, null, null, true);

    const rows = db.listEphemeralMemories('proj-a');
    expect(rows).toHaveLength(2);
    expect(rows.every(r => r.ephemeral === 1)).toBe(true);
    expect(rows.every(r => r.project === 'proj-a')).toBe(true);
  });

  it('clearEphemeralMemories removes only ephemerals for the project', () => {
    db.insertMemory('e1', 'task spec', 'decision', null, null, 'proj-a', false, null, null, true);
    db.insertMemory('e2', 'working cmd', 'convention', null, null, 'proj-a', false, null, null, true);
    db.insertMemory('p1', 'long-term fact', 'architecture', null, null, 'proj-a');
    db.insertMemory('e3', 'other project ephemeral', 'decision', null, null, 'proj-b', false, null, null, true);

    const cleared = db.clearEphemeralMemories('proj-a');
    expect(cleared).toHaveLength(2);
    expect(cleared).toContain('e1');
    expect(cleared).toContain('e2');

    // long-term memory untouched
    expect(db.getMemory('p1')).toBeDefined();
    // other project untouched
    expect(db.getMemory('e3')).toBeDefined();
    // ephemerals gone
    expect(db.getMemory('e1')).toBeUndefined();
    expect(db.getMemory('e2')).toBeUndefined();
  });

  it('clearEphemeralMemories returns empty array when none exist', () => {
    db.insertMemory('p1', 'long-term fact', 'architecture', null, null, 'proj-a');
    expect(db.clearEphemeralMemories('proj-a')).toHaveLength(0);
  });

  it('getEvictableIds excludes ephemeral memories', () => {
    db.insertMemory('e1', 'ephemeral', 'gotcha', null, null, null, false, null, null, true);
    db.insertMemory('n1', 'normal', 'gotcha');
    db.insertMemory('n2', 'normal2', 'gotcha');

    // With cap of 1, 2 are evictable — but only normal memories qualify
    const ids = db.getEvictableIds({ maxMemories: 1 });
    expect(ids).not.toContain('e1');
    expect(ids).toHaveLength(2);
    expect(ids).toContain('n1');
    expect(ids).toContain('n2');
  });
});

describe('data file permissions', () => {
  it('tightens an existing data folder, db and WAL sidecars when the next process opens it', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'claude-memory-dbperm-'));
    const dbPath = path.join(dir, 'memory.db');
    try {
      const first = createMemoryDb(dbPath);
      first.insertMemory('id-1', 'fact', 'gotcha', null, null, 'p');
      for (const f of [dir, dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
        if (existsSync(f)) chmodSync(f, f === dir ? 0o755 : 0o644);
      }

      const second = createMemoryDb(dbPath);
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
        if (existsSync(f)) expect(statSync(f).mode & 0o777, f).toBe(0o600);
      }
      expect(existsSync(`${dbPath}-wal`)).toBe(true);
      second.close();
      first.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('keyword index', () => {
  let db: MemoryDb;
  let dir: string;
  let raw: Database.Database;
  const dbPath = () => path.join(dir, 'test.db');
  const ftsCount = () => (raw.prepare('SELECT COUNT(*) AS n FROM memories_fts').get() as { n: number }).n;

  beforeEach(() => {
    ({ db, dir } = createTestDb());
    raw = new Database(dbPath());
  });

  afterEach(() => {
    raw.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('finds a memory by a substring of its text or tags, filtered by project', () => {
    db.insertMemory('m1', 'call onUploadAttachFile after upload', 'gotcha', null, null, 'p1');
    db.insertMemory('m2', 'unrelated', 'gotcha', null, null, 'p2', false, 'quota, http 429');
    expect(db.searchKeywords('AttachFile', 5)).toEqual(['m1']);
    expect(db.searchKeywords('429', 5)).toEqual(['m2']);
    expect(db.searchKeywords('429', 5, 'p1')).toEqual([]);
    expect(db.searchKeywords('a b', 5)).toEqual([]);
  });

  it('stays in sync with writes made by plain SQL, as older server versions make them', () => {
    raw.prepare("INSERT INTO memories (id, text, category, created_at) VALUES ('old', 'written by an older server', 'gotcha', '2026-01-01T00:00:00.000Z')").run();
    expect(db.searchKeywords('older', 5)).toEqual(['old']);
    raw.prepare("UPDATE memories SET text = 'edited elsewhere', tags = 'retagged' WHERE id = 'old'").run();
    expect(db.searchKeywords('older', 5)).toEqual([]);
    expect(db.searchKeywords('retagged', 5)).toEqual(['old']);
    raw.prepare("DELETE FROM memories WHERE id = 'old'").run();
    expect(db.searchKeywords('edited', 5)).toEqual([]);
    expect(ftsCount()).toBe(0);
  });

  it('leaves the index alone when an update does not change text or tags', () => {
    db.insertMemory('m1', 'stable text', 'gotcha', null, null, null, false, 'tag');
    const before = raw.prepare('SELECT rowid FROM memories_fts').get();
    db.updateMemory('m1', { tags: 'tag', pinned: true });
    db.updateLastAccessed(['m1']);
    expect(raw.prepare('SELECT rowid FROM memories_fts').get()).toEqual(before);
  });

  it('refuses to insert an id that already exists rather than replacing it', () => {
    db.insertMemory('m1', 'first', 'gotcha');
    expect(() => db.insertMemory('m1', 'second', 'gotcha')).toThrow(/UNIQUE/);
    expect(db.searchKeywords('first', 5)).toEqual(['m1']);
  });

  it('rebuilds the index on open when rows were written past the triggers', () => {
    db.insertMemory('m1', 'kept in the index', 'gotcha');
    raw.exec('DELETE FROM memories_fts; DELETE FROM memory_fts_keys;');
    db.close();
    db = createMemoryDb(dbPath());
    expect(db.searchKeywords('kept', 5)).toEqual(['m1']);
  });

  it('rebuilds an index left with an orphaned row by a REPLACE', () => {
    db.insertMemory('m1', 'first wording', 'gotcha');
    raw.prepare("INSERT OR REPLACE INTO memories (id, text, category, created_at) VALUES ('m1', 'second wording', 'gotcha', '2026-01-01T00:00:00.000Z')").run();
    db.close();
    db = createMemoryDb(dbPath());
    expect(ftsCount()).toBe(1);
    expect(db.searchKeywords('first', 5)).toEqual([]);
    expect(db.searchKeywords('second', 5)).toEqual(['m1']);
  });

  it('recreates a missing trigger on open, so later edits stay indexed', () => {
    db.insertMemory('m1', 'before', 'gotcha');
    raw.exec('DROP TRIGGER memories_fts_au; DROP TRIGGER memories_au_stamp;');
    db.close();
    db = createMemoryDb(dbPath());
    db.updateMemory('m1', { text: 'revised' });
    expect(db.searchKeywords('revised', 5)).toEqual(['m1']);
    expect(db.getMemory('m1')!.updated_at).not.toBeNull();
  });

  it('matches across accents and Unicode normalisation forms', () => {
    db.insertMemory('nfd', 'Ordner Übersicht'.normalize('NFD'), 'gotcha');
    db.insertMemory('nfc', 'Ordner Übersicht'.normalize('NFC'), 'gotcha');
    for (const q of ['Übersicht'.normalize('NFC'), 'Übersicht'.normalize('NFD'), 'Ubersicht']) {
      expect(db.searchKeywords(q, 5).sort()).toEqual(['nfc', 'nfd']);
    }
  });

  it('migrates a v1 database by building the index from its rows', () => {
    db.insertMemory('m1', 'from schema one', 'gotcha');
    raw.exec('DROP TRIGGER memories_fts_ai; DROP TRIGGER memories_fts_au; DROP TRIGGER memories_fts_ad; DROP TABLE memories_fts; DROP TABLE memory_fts_keys; PRAGMA user_version = 1;');
    db.close();
    db = createMemoryDb(dbPath());
    expect(raw.pragma('user_version', { simple: true })).toBe(3);
    expect(db.searchKeywords('schema', 5)).toEqual(['m1']);
  });

  it('evicts a large batch without scanning the index per row', () => {
    raw.transaction(() => {
      const ins = raw.prepare("INSERT INTO memories (id, text, category, created_at) VALUES (?, ?, 'gotcha', '2026-01-01T00:00:00.000Z')");
      for (let i = 0; i < 5000; i++) ins.run(`m${i}`, `memory number ${i} about some part of a codebase`.repeat(4));
    })();
    const vector = Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : 0));
    const start = performance.now();
    const res = db.storeMemory({ text: 'the one that stays', category: 'gotcha' }, { vector, source: 'the one that stays' }, { maxMemories: 1 });
    // About 30 ms with keyed deletes; a delete that scans the index takes about a second
    expect(performance.now() - start).toBeLessThan(250);
    expect(res).toMatchObject({ stored: true, evicted: 5000 });
    expect(ftsCount()).toBe(1);
    expect(db.searchKeywords('stays', 5)).toEqual([res.id]);
  });

  it('needs every word of a sentence, so one shared common word is no match', () => {
    db.insertMemory('sync', 'address book sync fails when the token expires', 'gotcha');
    db.insertMemory('upload', 'large uploads fail behind the proxy unless the body size limit is raised', 'gotcha');
    expect(db.searchKeywords('big file uploads fail', 5)).toEqual([]);
    expect(db.searchKeywords('uploads fail proxy', 5)).toEqual(['upload']);
  });

  it('falls back to the identifiers in a query when not every word matches', () => {
    db.insertMemory('quota', 'the limiter returns E_QUOTA_429 on burst', 'gotcha');
    db.insertMemory('other', 'bursts are smoothed by the queue', 'gotcha');
    expect(db.searchKeywords('why does E_QUOTA_429 happen', 5)).toEqual(['quota']);
  });

  it('leaves the index of a newer schema alone', () => {
    raw.exec('DROP TRIGGER memories_fts_au; PRAGMA user_version = 99;');
    db.close();
    db = createMemoryDb(dbPath());
    expect(raw.prepare("SELECT name FROM sqlite_master WHERE name = 'memories_fts_au'").get()).toBeUndefined();
    expect(raw.pragma('user_version', { simple: true })).toBe(99);
  });
});

describe('updated_at', () => {
  let db: MemoryDb;
  let dir: string;
  let raw: Database.Database;
  const updatedAt = (id: string) => db.getMemory(id)!.updated_at;

  beforeEach(() => {
    ({ db, dir } = createTestDb());
    raw = new Database(path.join(dir, 'test.db'));
  });

  afterEach(() => {
    raw.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('is null until the content changes, then an ISO timestamp', () => {
    db.insertMemory('m1', 'text', 'gotcha');
    expect(updatedAt('m1')).toBeNull();
    db.updateMemory('m1', { text: 'new text' });
    expect(updatedAt('m1')).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(Date.now() - Date.parse(updatedAt('m1')!)).toBeLessThan(60_000);
  });

  it('counts tags, category and file_path as content', () => {
    for (const [id, fields] of [['t', { tags: 'x' }], ['c', { category: 'decision' as const }], ['f', { file_path: 'a.ts' }]] as const) {
      db.insertMemory(id, 'text', 'gotcha');
      db.updateMemory(id, fields);
      expect(updatedAt(id)).not.toBeNull();
    }
  });

  it('ignores pinning, ephemeral, load_with, access and unchanged values', () => {
    db.insertMemory('m1', 'text', 'gotcha', null, null, null, false, 'tag');
    db.updateMemory('m1', { pinned: true, ephemeral: true, load_with: 'm2', tags: 'tag', text: 'text' });
    db.updateLastAccessed(['m1']);
    expect(updatedAt('m1')).toBeNull();
  });

  it('is stamped for edits made by plain SQL, as older server versions make them', () => {
    db.insertMemory('m1', 'text', 'gotcha');
    raw.prepare("UPDATE memories SET text = 'edited' WHERE id = 'm1'").run();
    expect(updatedAt('m1')).not.toBeNull();
  });

  it('adds the column and trigger to a v2 database', () => {
    db.insertMemory('m1', 'text', 'gotcha');
    raw.exec('DROP TRIGGER memories_au_stamp; ALTER TABLE memories DROP COLUMN updated_at; PRAGMA user_version = 2;');
    db.close();
    db = createMemoryDb(path.join(dir, 'test.db'));
    expect(updatedAt('m1')).toBeNull();
    db.updateMemory('m1', { text: 'edited' });
    expect(updatedAt('m1')).not.toBeNull();
  });
});
