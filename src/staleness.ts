import { spawnSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import type { StalenessResult } from './types.js';

export function checkStaleness(file_path: string | null | undefined, git_sha: string | null | undefined): StalenessResult {
  if (!file_path || !git_sha) {
    return { stale: false };
  }

  // Validate git_sha is a plausible SHA before using it as a git revision
  if (!/^[0-9a-f]{7,64}$/i.test(git_sha)) {
    return { stale: false };
  }

  try {
    let absPath: string;
    if (path.isAbsolute(file_path)) {
      absPath = file_path;
    } else {
      // file_path is stored relative to git root — find it from cwd first
      const gitRoot = spawnSync('git', ['rev-parse', '--show-toplevel'], {
        cwd: process.cwd(), encoding: 'utf8', timeout: 5000,
      });
      const base = (!gitRoot.error && gitRoot.status === 0)
        ? gitRoot.stdout.trim()
        : process.cwd();
      absPath = path.resolve(base, file_path);
    }

    if (!fs.existsSync(absPath)) {
      // Relative path that doesn't resolve — different repo or not checked out here
      if (!path.isAbsolute(file_path)) {
        return { stale: false };
      }
      return { stale: true, reason: 'file deleted' };
    }

    const cwd = path.dirname(absPath);
    const filename = path.basename(absPath);

    // Use spawnSync with an args array — never interpolated into a shell string
    const result = spawnSync(
      'git',
      ['log', '--oneline', `${git_sha}..HEAD`, '--', filename],
      { cwd, encoding: 'utf8', timeout: 5000 },
    );

    if (result.error || result.status !== 0) {
      return { stale: false };
    }

    const output = result.stdout.trim();
    if (output) {
      const commits_since = output.split('\n').length;
      return { stale: true, commits_since };
    }

    return { stale: false };
  } catch {
    return { stale: false };
  }
}
