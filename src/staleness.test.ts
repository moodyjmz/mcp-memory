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
  execSync: vi.fn(),
}));

import fs from 'fs';
import { execSync } from 'child_process';
import { checkStaleness } from './staleness.js';

const mockExecSync = vi.mocked(execSync);
const mockExistsSync = vi.mocked(fs.existsSync);

describe('staleness', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(true);
  });

  it('returns not stale when no file_path', () => {
    expect(checkStaleness(null, 'abc123')).toEqual({ stale: false });
  });

  it('returns not stale when no git_sha', () => {
    expect(checkStaleness('/some/file.ts', null)).toEqual({ stale: false });
  });

  it('returns stale when file is deleted', () => {
    mockExistsSync.mockReturnValue(false);
    expect(checkStaleness('/some/file.ts', 'abc123')).toEqual({ stale: true, reason: 'file deleted' });
  });

  it('returns not stale when no commits since sha', () => {
    mockExecSync.mockReturnValue('');
    expect(checkStaleness('/some/file.ts', 'abc123')).toEqual({ stale: false });
  });

  it('returns stale with commit count when file changed', () => {
    mockExecSync.mockReturnValue('def456 fix thing\nghi789 update thing');
    const result = checkStaleness('/some/file.ts', 'abc123');
    expect(result).toEqual({ stale: true, commits_since: 2 });
  });

  it('returns not stale on git error', () => {
    mockExecSync.mockImplementation(() => { throw new Error('not a git repo'); });
    expect(checkStaleness('/some/file.ts', 'abc123')).toEqual({ stale: false });
  });
});
