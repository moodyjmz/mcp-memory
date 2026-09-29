import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs, { mkdtempSync, rmSync, statSync, writeFileSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { restrictToOwner } from './permissions.js';

describe('restrictToOwner', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'claude-memory-perms-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('tightens an existing folder and files created with looser modes', () => {
    chmodSync(dir, 0o755);
    const file = path.join(dir, 'a.db');
    writeFileSync(file, '', { mode: 0o644 });
    restrictToOwner(dir, [file]);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('skips files that do not exist', () => {
    expect(() => restrictToOwner(dir, [path.join(dir, 'missing-wal')])).not.toThrow();
  });

  it('logs instead of throwing when the filesystem refuses the chmod', () => {
    const chmod = vi.spyOn(fs, 'chmodSync').mockImplementation(() => {
      throw Object.assign(new Error('read-only file system'), { code: 'EROFS' });
    });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(() => restrictToOwner(dir, [path.join(dir, 'a.db')])).not.toThrow();
      expect(log).toHaveBeenCalledWith(expect.stringContaining('EROFS'));
    } finally {
      chmod.mockRestore();
      log.mockRestore();
    }
  });
});
