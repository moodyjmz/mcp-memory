import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * memory_store_file writes only to server-built paths under one notes folder:
 *   <root>/<org>/<repo>/<name>.md   (or <root>/_local/<name>/<name>.md without an org)
 * <root> defaults to ~/.claude-memory/notes, a folder only this server writes to.
 * The caller supplies a name, never a path, so nothing a tool call passes in can
 * point a write inside a repository or at Claude Code's own config.
 */

export const NOTE_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

export function notesRoot(env: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(env.MEMORY_FILES_DIR || path.join(os.homedir(), '.claude-memory', 'notes'));
}

/**
 * Map a project ID to its notes subfolder: the last two path segments
 * (org/repo), matching hooks/lib/cm-findings-path.sh, or _local/<name>.
 */
export function projectSubdir(project: string): string {
  const pathPart = project.includes('://') ? new URL(project).pathname : project;
  const segments = pathPart.split('/').filter(Boolean);
  const picked = segments.length >= 2 ? segments.slice(-2) : ['_local', ...segments];
  if (picked.length !== 2 || !picked.every(s => s === '_local' || SEGMENT_PATTERN.test(s))) {
    throw new Error(`project "${project}" does not map to a safe notes folder`);
  }
  return picked.join('/');
}

/** Create <name>.md for a project and return its absolute path. Never overwrites. */
export function writeNote(root: string, project: string, name: string, content: string): string {
  if (!NOTE_NAME_PATTERN.test(name)) {
    throw new Error('name must be lowercase letters, digits and hyphens (max 64), starting with a letter or digit');
  }
  const dir = path.join(root, projectSubdir(project));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  // A symlink planted anywhere under root must not redirect the write outside it
  const realRoot = fs.realpathSync(root);
  const realDir = fs.realpathSync(dir);
  if (realDir !== realRoot && !realDir.startsWith(realRoot + path.sep)) {
    throw new Error('notes folder resolves outside the notes root');
  }

  // Create-only: never truncate an existing note (on case-insensitive filesystems
  // "readme" would otherwise open README.md). O_EXCL also refuses a symlinked target.
  const target = path.join(realDir, `${name}.md`);
  let fd: number;
  try {
    fd = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`${name}.md already exists in ${projectSubdir(project)}; choose another name`);
    }
    throw err;
  }
  try {
    fs.writeSync(fd, content, null, 'utf8');
    fs.fchmodSync(fd, 0o600);
  } finally {
    fs.closeSync(fd);
  }
  return target;
}
