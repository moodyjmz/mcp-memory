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
