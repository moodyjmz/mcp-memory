import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

/**
 * Return true only if the path targets a .md file inside a .claude/ directory.
 * Used by memory_store_file to prevent accidental writes outside reference docs.
 */
export function isValidClaudeFilePath(filePath: string): boolean {
  const normalised = (path.isAbsolute(filePath) ? filePath : path.resolve(filePath)).replace(/\\/g, '/');
  return normalised.includes('/.claude/') && normalised.endsWith('.md');
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
    const raw = execSync(
      `git log --name-only --format= -n ${n} HEAD`,
      { cwd: repoRoot, encoding: 'utf8', timeout: 5000 }
    );
    return [...new Set(raw.split('\n').map(l => l.trim()).filter(Boolean))];
  } catch {
    return [];
  }
}
