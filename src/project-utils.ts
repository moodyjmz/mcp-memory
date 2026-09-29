import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

/**
 * Canonical project ID for a git remote URL: strip a trailing .git, rewrite
 * SSH (git@host:org/repo) to HTTPS form keeping the host, and drop any query
 * string or fragment so a crafted remote can't spoof another project's ID.
 */
export function normaliseRemoteUrl(url: string): string {
  const normalized = url.trim().replace(/\.git$/, '').replace(/^git@([^:]+):/, 'https://$1/');
  return normalized.split('?')[0].split('#')[0];
}

export interface ClaudeFile {
  rel_path: string;   // e.g. ".claude/icon-migration.md"
  name: string;       // e.g. "icon-migration.md"
}

/**
 * Scan the .claude/ directory at a repo root and return all .md files.
 */
export function scanClaudeFiles(repoRoot: string): ClaudeFile[] {
  const claudeDir = path.join(repoRoot, '.claude');
  if (!fs.existsSync(claudeDir)) return [];
  try {
    return fs.readdirSync(claudeDir)
      .filter(f => f.endsWith('.md'))
      .map(f => ({ rel_path: path.join('.claude', f), name: f }));
  } catch {
    return [];
  }
}

/**
 * Return relative file paths changed in the last `n` commits of the repo
 * rooted at `repoRoot`. Returns empty array if git is unavailable or repo
 * has no commits.
 */
export function getRecentlyChangedFiles(repoRoot: string, n = 20): string[] {
  try {
    const raw = execFileSync(
      'git', ['log', '--name-only', '--format=', '-n', String(Math.trunc(n)), 'HEAD'],
      { cwd: repoRoot, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }
    );
    return [...new Set(raw.split('\n').map(l => l.trim()).filter(Boolean))];
  } catch {
    return [];
  }
}
