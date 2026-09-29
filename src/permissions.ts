import fs from 'fs';

/**
 * Reapply owner-only permissions on every start. mkdirSync/open modes only take
 * effect when a path is created, so a folder or file made before a fix (or by a
 * different umask) otherwise stays readable by other local accounts.
 */
export function restrictToOwner(dir: string, files: string[] = []): void {
  chmodIfPresent(dir, 0o700);
  for (const file of files) chmodIfPresent(file, 0o600);
}

function chmodIfPresent(target: string, mode: number): void {
  try {
    fs.chmodSync(target, mode);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // Missing sidecar files and filesystems without POSIX modes are fine
    if (code !== 'ENOENT' && code !== 'EPERM' && code !== 'ENOTSUP') throw err;
  }
}
