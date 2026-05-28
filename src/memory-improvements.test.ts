/**
 * Integration tests for the three memory improvements:
 * 1. memory_project_summary claude_files (auto-scan .claude/ with drift detection)
 * 2. memory_project_summary memories_for_recent_files (git-aware)
 * 3. memory_store_file (atomic write + pointer memory)
 *
 * These tests exercise the helper functions and the db/index layer directly,
 * mirroring the approach in server.integration.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { execSync } from 'child_process';
import path from 'path';
import { createTestDb, createTestIndex } from './test-helpers.js';
import { scanClaudeFiles, getRecentlyChangedFiles } from './project-utils.js';
import type { MemoryDb } from './db.js';
import type { MemoryIndex } from './memory-index.js';
import type { MemoryCategory } from './types.js';

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeTempDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'claude-memory-mi-test-'));
}

function initGitRepo(dir: string): void {
  execSync('git init', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.email "test@test.com"', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.name "Test"', { cwd: dir, stdio: 'pipe' });
}

function gitCommit(dir: string, files: Record<string, string>, message: string): void {
  for (const [name, content] of Object.entries(files)) {
    const abs = path.join(dir, name);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
    execSync(`git add "${name}"`, { cwd: dir, stdio: 'pipe' });
  }
  execSync(`git commit -m "${message}"`, { cwd: dir, stdio: 'pipe' });
}

// ─── drift detection (claude_files) ──────────────────────────────────────────

describe('memory_project_summary: claude_files drift detection', () => {
  let db: MemoryDb;
  let index: MemoryIndex;
  let dbDir: string;
  let idxDir: string;
  let repoDir: string;

  beforeEach(() => {
    ({ db, dir: dbDir } = createTestDb());
    ({ index, dir: idxDir } = createTestIndex());
    repoDir = makeTempDir();
    initGitRepo(repoDir);
    mkdirSync(path.join(repoDir, '.claude'));
  });

  afterEach(() => {
    db.close();
    rmSync(dbDir, { recursive: true, force: true });
    rmSync(idxDir, { recursive: true, force: true });
    rmSync(repoDir, { recursive: true, force: true });
  });

  it('reports has_pointer: false when no pointer memory exists for a .claude/ file', () => {
    writeFileSync(path.join(repoDir, '.claude', 'icon-migration.md'), '# Icons');

    const files = scanClaudeFiles(repoDir);
    expect(files).toHaveLength(1);

    const allMemories = db.listMemories(undefined, 'test-project');
    const withPointer = files.map(f => ({
      ...f,
      has_pointer: allMemories.some(m => m.file_path && m.file_path === f.rel_path),
    }));

    expect(withPointer[0].has_pointer).toBe(false);
  });

  it('reports has_pointer: true when a matching pointer memory exists', async () => {
    writeFileSync(path.join(repoDir, '.claude', 'icon-migration.md'), '# Icons');
    const relPath = path.join('.claude', 'icon-migration.md');

    // Store a pointer memory
    const { id, added } = await index.addFact('Icon migration reference', {
      category: 'architecture',
      file_path: relPath,
      project: 'test-project',
    });
    expect(added).toBe(true);
    db.insertMemory(id, 'Icon migration reference', 'architecture', relPath, null, 'test-project');

    const files = scanClaudeFiles(repoDir);
    const allMemories = db.listMemories(undefined, 'test-project');
    const withPointer = files.map(f => ({
      ...f,
      has_pointer: allMemories.some(m => m.file_path && m.file_path === f.rel_path),
    }));

    expect(withPointer[0].has_pointer).toBe(true);
  });

  it('correctly distinguishes files with and without pointers', async () => {
    writeFileSync(path.join(repoDir, '.claude', 'icon-migration.md'), '# Icons');
    writeFileSync(path.join(repoDir, '.claude', 'pr-reviews.md'), '# PRs');

    const relPathIcons = path.join('.claude', 'icon-migration.md');

    // Only store a pointer for icon-migration.md
    const { id, added } = await index.addFact('Icon migration reference', {
      category: 'architecture',
      file_path: relPathIcons,
      project: 'test-project',
    });
    expect(added).toBe(true);
    db.insertMemory(id, 'Icon migration reference', 'architecture', relPathIcons, null, 'test-project');

    const files = scanClaudeFiles(repoDir);
    const allMemories = db.listMemories(undefined, 'test-project');
    const withPointer = files.map(f => ({
      name: f.name,
      has_pointer: allMemories.some(m => m.file_path && m.file_path === f.rel_path),
    }));

    const iconEntry = withPointer.find(f => f.name === 'icon-migration.md')!;
    const prEntry = withPointer.find(f => f.name === 'pr-reviews.md')!;

    expect(iconEntry.has_pointer).toBe(true);
    expect(prEntry.has_pointer).toBe(false);
  });
});

// ─── git-aware memories_for_recent_files ─────────────────────────────────────

describe('memory_project_summary: memories_for_recent_files', () => {
  let db: MemoryDb;
  let index: MemoryIndex;
  let dbDir: string;
  let idxDir: string;
  let repoDir: string;

  beforeEach(() => {
    ({ db, dir: dbDir } = createTestDb());
    ({ index, dir: idxDir } = createTestIndex());
    repoDir = makeTempDir();
    initGitRepo(repoDir);
  });

  afterEach(() => {
    db.close();
    rmSync(dbDir, { recursive: true, force: true });
    rmSync(idxDir, { recursive: true, force: true });
    rmSync(repoDir, { recursive: true, force: true });
  });

  it('surfaces memories whose file_path matches recently changed files', async () => {
    gitCommit(repoDir, { 'src/Toolbar.js': 'toolbar code' }, 'add toolbar');

    const { id, added } = await index.addFact('Toolbar uses iconCls pattern', {
      category: 'convention',
      file_path: 'src/Toolbar.js',
      project: 'test-project',
    });
    expect(added).toBe(true);
    db.insertMemory(id, 'Toolbar uses iconCls pattern', 'convention', 'src/Toolbar.js', null, 'test-project');

    const recentFiles = getRecentlyChangedFiles(repoDir, 20);
    const recentSet = new Set(recentFiles);
    const allMemories = db.listMemories(undefined, 'test-project');
    const matched = allMemories.filter(r => r.file_path && recentSet.has(r.file_path));

    expect(matched).toHaveLength(1);
    expect(matched[0].id).toBe(id);
  });

  it('does not surface memories for files not in recent commits', async () => {
    gitCommit(repoDir, { 'src/Other.js': 'other' }, 'add other');

    const { id, added } = await index.addFact('Memory about unrelated file', {
      category: 'convention',
      file_path: 'src/Toolbar.js', // NOT in recent commits
      project: 'test-project',
    });
    expect(added).toBe(true);
    db.insertMemory(id, 'Memory about unrelated file', 'convention', 'src/Toolbar.js', null, 'test-project');

    const recentFiles = getRecentlyChangedFiles(repoDir, 20);
    const recentSet = new Set(recentFiles);
    const allMemories = db.listMemories(undefined, 'test-project');
    const matched = allMemories.filter(r => r.file_path && recentSet.has(r.file_path));

    expect(matched).toHaveLength(0);
  });

  it('returns empty when repo has no commits', () => {
    const recentFiles = getRecentlyChangedFiles(repoDir, 20);
    expect(recentFiles).toEqual([]);
  });
});

// ─── memory_store_file: atomic write + pointer ────────────────────────────────

describe('memory_store_file: atomic write and pointer memory', () => {
  let db: MemoryDb;
  let index: MemoryIndex;
  let dbDir: string;
  let idxDir: string;
  let repoDir: string;

  beforeEach(() => {
    ({ db, dir: dbDir } = createTestDb());
    ({ index, dir: idxDir } = createTestIndex());
    repoDir = makeTempDir();
    initGitRepo(repoDir);
    mkdirSync(path.join(repoDir, '.claude'));
  });

  afterEach(() => {
    db.close();
    rmSync(dbDir, { recursive: true, force: true });
    rmSync(idxDir, { recursive: true, force: true });
    rmSync(repoDir, { recursive: true, force: true });
  });

  async function storeFile(
    filePath: string,
    content: string,
    pointerText: string,
    category: MemoryCategory,
    project: string,
    ephemeral?: boolean,
  ): Promise<{ written: boolean; memoryId: string; memoryAdded: boolean }> {
    // Simulate memory_store_file logic (mirrors server handler)
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, content, 'utf8');

    const result = await index.addFact(pointerText, {
      category,
      file_path: path.relative(repoDir, filePath),
      project,
    });

    if (result.added) {
      db.insertMemory(
        result.id, pointerText, category,
        path.relative(repoDir, filePath), null, project,
        undefined, undefined, undefined, ephemeral,
      );
    }

    return { written: true, memoryId: result.id, memoryAdded: result.added };
  }

  it('writes the file and stores a pointer memory', async () => {
    const filePath = path.join(repoDir, '.claude', 'icon-migration.md');
    const content = '# Icon Migration\nUse SVG sprites.';

    const { written, memoryId, memoryAdded } = await storeFile(
      filePath, content, 'Icon migration reference doc', 'architecture', 'test-project',
    );

    expect(written).toBe(true);
    expect(existsSync(filePath)).toBe(true);
    expect(readFileSync(filePath, 'utf8')).toBe(content);
    expect(memoryAdded).toBe(true);

    const row = db.getMemory(memoryId);
    expect(row).toBeDefined();
    expect(row!.text).toBe('Icon migration reference doc');
    expect(row!.file_path).toBe(path.join('.claude', 'icon-migration.md'));
    expect(row!.project).toBe('test-project');
  });

  it('stores pointer as ephemeral when ephemeral: true', async () => {
    const filePath = path.join(repoDir, '.claude', 'session-notes.md');

    const { memoryId, memoryAdded } = await storeFile(
      filePath, '# Session notes', 'Temp session notes', 'gotcha', 'test-project', true,
    );

    expect(memoryAdded).toBe(true);
    const row = db.getMemory(memoryId);
    expect(row!.ephemeral).toBe(1);
  });

  it('does not duplicate pointer memory on second write of same content', async () => {
    const filePath = path.join(repoDir, '.claude', 'icon-migration.md');

    const first = await storeFile(filePath, '# Icons', 'Icon migration reference', 'architecture', 'test-project');
    const second = await storeFile(filePath, '# Icons updated', 'Icon migration reference', 'architecture', 'test-project');

    expect(first.memoryAdded).toBe(true);
    expect(second.memoryAdded).toBe(false); // deduped by semantic similarity
    expect(db.countMemories()).toBe(1);
  });

  it('pointer memory is discoverable via file_path', async () => {
    const filePath = path.join(repoDir, '.claude', 'pr-reviews.md');

    const { memoryId } = await storeFile(
      filePath, '# PR Reviews', 'PR review findings for spreadsheet checkbox', 'architecture', 'test-project',
    );

    const rows = db.listMemories(undefined, 'test-project');
    const found = rows.find(r => r.id === memoryId);
    expect(found).toBeDefined();
    expect(found!.file_path).toBe(path.join('.claude', 'pr-reviews.md'));
  });
});
