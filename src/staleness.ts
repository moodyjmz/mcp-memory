import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import type { StalenessResult } from './types.js';

export function checkStaleness(file_path: string | null | undefined, git_sha: string | null | undefined): StalenessResult {
  if (!file_path || !git_sha) {
    return { stale: false };
  }

  try {
    const absPath = path.isAbsolute(file_path) ? file_path : path.resolve(file_path);

    if (!fs.existsSync(absPath)) {
      return { stale: true, reason: 'file deleted' };
    }

    const cwd = path.dirname(absPath);
    const filename = path.basename(absPath);

    const output = execSync(
      `git log --oneline ${git_sha}..HEAD -- "${filename}"`,
      { cwd, encoding: 'utf8', timeout: 5000 }
    ).trim();

    if (output) {
      const commits_since = output.split('\n').length;
      return { stale: true, commits_since };
    }

    return { stale: false };
  } catch {
    return { stale: false };
  }
}
