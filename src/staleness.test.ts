import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock fs before importing staleness
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: { ...actual, existsSync: vi.fn(() => true) },
    existsSync: vi.fn(() => true),
  };
});

vi.mock('child_process', () => ({
  spawnSync: vi.fn(),
}));

import fs from 'fs';
import { spawnSync } from 'child_process';
import { checkStaleness } from './staleness.js';

const mockSpawnSync = vi.mocked(spawnSync);
const mockExistsSync = vi.mocked(fs.existsSync);

// Real git rev-parse HEAD produces a 40-char hex SHA; short SHAs are 7+ chars
const VALID_SHA = 'abc1234';

describe('staleness', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(true);
  });

  it('returns not stale when no file_path', () => {
    expect(checkStaleness(null, VALID_SHA)).toEqual({ stale: false });
  });

  it('returns not stale when no git_sha', () => {
    expect(checkStaleness('/some/file.ts', null)).toEqual({ stale: false });
  });

  it('returns not stale when git_sha fails validation', () => {
    expect(checkStaleness('/some/file.ts', '; rm -rf ~')).toEqual({ stale: false });
    expect(checkStaleness('/some/file.ts', 'abc')).toEqual({ stale: false }); // too short
  });

  it('returns stale when file is deleted', () => {
    mockExistsSync.mockReturnValue(false);
    expect(checkStaleness('/some/file.ts', VALID_SHA)).toEqual({ stale: true, reason: 'file deleted' });
  });

  it('returns not stale when no commits since sha', () => {
    mockSpawnSync.mockReturnValue({ stdout: '', stderr: '', status: 0, error: undefined } as any);
    expect(checkStaleness('/some/file.ts', VALID_SHA)).toEqual({ stale: false });
  });

  it('returns stale with commit count when file changed', () => {
    mockSpawnSync.mockReturnValue({ stdout: 'def4567 fix thing\nghi7890 update thing', stderr: '', status: 0, error: undefined } as any);
    const result = checkStaleness('/some/file.ts', VALID_SHA);
    expect(result).toEqual({ stale: true, commits_since: 2 });
  });

  it('returns not stale on git error', () => {
    mockSpawnSync.mockReturnValue({ stdout: '', stderr: 'fatal: not a git repo', status: 128, error: undefined } as any);
    expect(checkStaleness('/some/file.ts', VALID_SHA)).toEqual({ stale: false });
  });

  it('returns not stale when spawnSync throws', () => {
    mockSpawnSync.mockImplementation(() => { throw new Error('spawn error'); });
    expect(checkStaleness('/some/file.ts', VALID_SHA)).toEqual({ stale: false });
  });

  describe('relative paths', () => {
    it('resolves relative path from git root and returns not stale', () => {
      // First call: git rev-parse --show-toplevel
      mockSpawnSync.mockReturnValueOnce({ stdout: '/repo/root\n', stderr: '', status: 0, error: undefined } as any);
      // Second call: git log
      mockSpawnSync.mockReturnValueOnce({ stdout: '', stderr: '', status: 0, error: undefined } as any);
      expect(checkStaleness('src/file.ts', VALID_SHA)).toEqual({ stale: false });
    });

    it('resolves relative path from git root and returns stale', () => {
      mockSpawnSync.mockReturnValueOnce({ stdout: '/repo/root\n', stderr: '', status: 0, error: undefined } as any);
      mockSpawnSync.mockReturnValueOnce({ stdout: 'abc1234 fix thing', stderr: '', status: 0, error: undefined } as any);
      expect(checkStaleness('src/file.ts', VALID_SHA)).toEqual({ stale: true, commits_since: 1 });
    });

    it('falls back to cwd when git root lookup fails', () => {
      // First call: git rev-parse fails
      mockSpawnSync.mockReturnValueOnce({ stdout: '', stderr: 'fatal: not a git repo', status: 128, error: undefined } as any);
      // Second call: git log
      mockSpawnSync.mockReturnValueOnce({ stdout: '', stderr: '', status: 0, error: undefined } as any);
      expect(checkStaleness('src/file.ts', VALID_SHA)).toEqual({ stale: false });
    });

    it('returns not stale when relative path cannot be resolved', () => {
      mockSpawnSync.mockReturnValueOnce({ stdout: '/repo/root\n', stderr: '', status: 0, error: undefined } as any);
      mockExistsSync.mockReturnValue(false);
      expect(checkStaleness('src/file.ts', VALID_SHA)).toEqual({ stale: false });
    });
  });
});
