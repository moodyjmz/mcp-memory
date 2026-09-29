import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { execSync } from 'child_process';
import path from 'path';
import { normaliseRemoteUrl } from './project-utils.js';

const HOOK = path.resolve(__dirname, '../hooks/session-start.sh');

function hookProject(cwd: string, home: string): string | null {
  const out = execSync(`bash "${HOOK}"`, { cwd, encoding: 'utf8', env: { ...process.env, HOME: home } });
  const match = out.replace(/\x1b\[[0-9;]*m/g, '').match(/project: (\S+)/);
  return match ? match[1] : null;
}

describe('session-start hook project ID', () => {
  let dir: string;
  let home: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'claude-memory-hook-test-'));
    home = mkdtempSync(path.join(tmpdir(), 'claude-memory-hook-home-'));
    execSync('git init', { cwd: dir, stdio: 'pipe' });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it.each([
    'git@github.com:Euro-Office/web-apps.git',
    'https://github.com/Euro-Office/web-apps.git',
    'git@gitlab.example.com:group/repo.git',
    'https://github.com/org/repo?x=1#frag',
  ])('matches the server normalisation for %s', (remote) => {
    execSync(`git remote add origin "${remote}"`, { cwd: dir, stdio: 'pipe' });
    expect(hookProject(dir, home)).toBe(normaliseRemoteUrl(remote));
  });
});
