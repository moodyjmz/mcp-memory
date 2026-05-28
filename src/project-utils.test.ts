import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { execSync } from 'child_process';
import path from 'path';
import { scanClaudeFiles, getRecentlyChangedFiles, isValidClaudeFilePath } from './project-utils.js';

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeTempDir(): string {
  return mkdtempSync(path.join(tmpdir(), 'claude-memory-pu-test-'));
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

// ─── isValidClaudeFilePath ───────────────────────────────────────────────────

describe('isValidClaudeFilePath', () => {
  it('accepts a .md file inside .claude/', () => {
    expect(isValidClaudeFilePath('/repo/.claude/icon-migration.md')).toBe(true);
  });

  it('rejects a non-.md file inside .claude/', () => {
    expect(isValidClaudeFilePath('/repo/.claude/settings.json')).toBe(false);
  });

  it('rejects a .md file not inside .claude/', () => {
    expect(isValidClaudeFilePath('/repo/docs/readme.md')).toBe(false);
  });

  it('rejects a path where .claude is part of a longer directory name', () => {
    expect(isValidClaudeFilePath('/repo/x.claude.extra/icon.md')).toBe(false);
  });

  it('rejects a file named .claude.md at repo root (not inside .claude/)', () => {
    expect(isValidClaudeFilePath('/repo/.claude.md')).toBe(false);
  });

  it('accepts nested paths within .claude/', () => {
    expect(isValidClaudeFilePath('/repo/.claude/sub/notes.md')).toBe(true);
  });
});

// ─── scanClaudeFiles ─────────────────────────────────────────────────────────

describe('scanClaudeFiles', () => {
  let dir: string;

  beforeEach(() => { dir = makeTempDir(); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('returns empty array when .claude/ does not exist', () => {
    expect(scanClaudeFiles(dir)).toEqual([]);
  });

  it('returns empty array when .claude/ exists but has no .md files', () => {
    mkdirSync(path.join(dir, '.claude'));
    writeFileSync(path.join(dir, '.claude', 'settings.json'), '{}');
    expect(scanClaudeFiles(dir)).toEqual([]);
  });

  it('returns .md files with correct rel_path and name', () => {
    mkdirSync(path.join(dir, '.claude'));
    writeFileSync(path.join(dir, '.claude', 'icon-migration.md'), '# Icons');
    writeFileSync(path.join(dir, '.claude', 'pr-reviews.md'), '# PRs');
    writeFileSync(path.join(dir, '.claude', 'settings.json'), '{}');

    const result = scanClaudeFiles(dir);
    expect(result).toHaveLength(2);

    const names = result.map(f => f.name).sort();
    expect(names).toEqual(['icon-migration.md', 'pr-reviews.md']);

    for (const f of result) {
      expect(f.rel_path).toBe(path.join('.claude', f.name));
    }
  });
});

// ─── getRecentlyChangedFiles ──────────────────────────────────────────────────

describe('getRecentlyChangedFiles', () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir();
    initGitRepo(dir);
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('returns empty array when repo has no commits', () => {
    expect(getRecentlyChangedFiles(dir)).toEqual([]);
  });

  it('returns files changed in the most recent commits', () => {
    gitCommit(dir, { 'README.md': '# Hello', 'src/index.ts': 'export {}' }, 'initial');
    gitCommit(dir, { 'src/utils.ts': 'export const x = 1' }, 'add utils');

    const result = getRecentlyChangedFiles(dir, 20);
    expect(result).toContain('README.md');
    expect(result).toContain('src/index.ts');
    expect(result).toContain('src/utils.ts');
  });

  it('deduplicates files changed across multiple commits', () => {
    gitCommit(dir, { 'README.md': 'v1' }, 'first');
    gitCommit(dir, { 'README.md': 'v2' }, 'second');

    const result = getRecentlyChangedFiles(dir, 5);
    const readmeCount = result.filter(f => f === 'README.md').length;
    expect(readmeCount).toBe(1);
  });

  it('respects the n commit limit', () => {
    gitCommit(dir, { 'a.ts': 'a' }, 'commit 1');
    gitCommit(dir, { 'b.ts': 'b' }, 'commit 2');
    gitCommit(dir, { 'c.ts': 'c' }, 'commit 3');

    // n=1 should only return c.ts from the most recent commit
    const result = getRecentlyChangedFiles(dir, 1);
    expect(result).toContain('c.ts');
    expect(result).not.toContain('a.ts');
    expect(result).not.toContain('b.ts');
  });

  it('returns empty array for non-git directory', () => {
    const nonGit = makeTempDir();
    try {
      expect(getRecentlyChangedFiles(nonGit)).toEqual([]);
    } finally {
      rmSync(nonGit, { recursive: true, force: true });
    }
  });
});
