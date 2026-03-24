import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rmSync } from 'fs';
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

    const ids = db.getEvictableIds({ maxMemories: 1, maxAgeDays: 90 });
    // Should evict 2 (3 - 1 = 2), oldest/least-accessed first
    expect(ids).toHaveLength(2);
    // 'old' and 'mid' have no last_accessed, so sort by created_at ASC
    expect(ids).toContain('old');
    expect(ids).toContain('mid');
    expect(ids).not.toContain('new');
  });

  it('returns no evictable IDs when under limit', () => {
    db.insertMemory('m1', 'one', 'gotcha');
    const ids = db.getEvictableIds({ maxMemories: 10, maxAgeDays: 90 });
    expect(ids).toHaveLength(0);
  });

  it('handles insertMemory with nullish optional fields', () => {
    db.insertMemory('m1', 'test', 'architecture', null, null, null);
    const row = db.getMemory('m1');
    expect(row!.file_path).toBeNull();
    expect(row!.git_sha).toBeNull();
    expect(row!.project).toBeNull();
  });
});
