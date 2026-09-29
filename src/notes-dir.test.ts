import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, statSync, symlinkSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync } from 'fs';
import { tmpdir, homedir } from 'os';
import path from 'path';
import { notesRoot, projectSubdir, writeNote } from './notes-dir.js';

describe('projectSubdir', () => {
  it('uses org/repo from a normalised remote URL', () => {
    expect(projectSubdir('https://github.com/Euro-Office/web-apps')).toBe('Euro-Office/web-apps');
  });

  it('uses the last two segments of a nested path, like cm-findings-path.sh', () => {
    expect(projectSubdir('https://gitlab.example.com/group/sub/repo')).toBe('sub/repo');
  });

  it('keeps an org/repo shorthand', () => {
    expect(projectSubdir('nextcloud/office')).toBe('nextcloud/office');
  });

  it('puts a bare name under _local', () => {
    expect(projectSubdir('mcp-memory')).toBe('_local/mcp-memory');
  });

  it.each(['../../etc', 'org/..', '..', '.hidden/repo', 'org/re po', ''])('rejects %j', (project) => {
    expect(() => projectSubdir(project)).toThrow();
  });
});

describe('notesRoot', () => {
  it('honours MEMORY_FILES_DIR', () => {
    expect(notesRoot({ MEMORY_FILES_DIR: '/srv/notes' })).toBe('/srv/notes');
  });

  it('defaults to ~/.claude-memory/notes', () => {
    expect(notesRoot({})).toBe(path.join(homedir(), '.claude-memory', 'notes'));
  });
});

describe('writeNote', () => {
  let root: string;
  let outside: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'claude-memory-notes-'));
    outside = mkdtempSync(path.join(tmpdir(), 'claude-memory-outside-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it('writes <root>/<org>/<repo>/<name>.md owner-only', () => {
    const target = writeNote(root, 'https://github.com/org/repo', 'lost-writes', '# notes');
    expect(target).toBe(path.join(realpathSync(root), 'org', 'repo', 'lost-writes.md'));
    expect(readFileSync(target, 'utf8')).toBe('# notes');
    expect(statSync(target).mode & 0o777).toBe(0o600);
    expect(statSync(path.dirname(target)).mode & 0o777).toBe(0o700);
  });

  it('refuses to overwrite an existing note', () => {
    writeNote(root, 'org/repo', 'n', 'first');
    expect(() => writeNote(root, 'org/repo', 'n', 'second')).toThrow(/already exists/);
    expect(readFileSync(path.join(root, 'org', 'repo', 'n.md'), 'utf8')).toBe('first');
  });

  it('never truncates a differently-cased existing file', () => {
    mkdirSync(path.join(root, 'org', 'share'), { recursive: true });
    const readme = path.join(root, 'org', 'share', 'README.md');
    writeFileSync(readme, 'rules');
    try { writeNote(root, 'org/share', 'readme', 'x'); } catch { /* case-insensitive FS: EEXIST */ }
    expect(readFileSync(readme, 'utf8')).toBe('rules');
  });

  it.each(['../escape', 'a/b', 'UPPER', '.hidden', '', 'x'.repeat(65)])('rejects name %j', (name) => {
    expect(() => writeNote(root, 'org/repo', name, 'x')).toThrow();
  });

  it('refuses a project folder symlinked outside the root', () => {
    mkdirSync(path.join(root, 'org'), { recursive: true });
    symlinkSync(outside, path.join(root, 'org', 'repo'));
    expect(() => writeNote(root, 'org/repo', 'n', 'x')).toThrow(/outside the notes root/);
    expect(existsSync(path.join(outside, 'n.md'))).toBe(false);
  });

  it('refuses to follow a symlinked target file', () => {
    mkdirSync(path.join(root, 'org', 'repo'), { recursive: true });
    const victim = path.join(outside, 'victim.md');
    writeFileSync(victim, 'original');
    symlinkSync(victim, path.join(root, 'org', 'repo', 'n.md'));
    expect(() => writeNote(root, 'org/repo', 'n', 'x')).toThrow();
    expect(readFileSync(victim, 'utf8')).toBe('original');
  });
});
