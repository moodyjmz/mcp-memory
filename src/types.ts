// Note: cross-repo relationships go in repo_relationships via repo_link/repo_map, not as memories.
// 'relationship' is kept here only for backward-compat with any existing stored memories.
export const CATEGORIES = ['architecture', 'convention', 'gotcha', 'decision', 'preference', 'relationship', 'person'] as const;

// Categories excluded from LRU eviction (beyond pinned/ephemeral).
// 'person' profiles are low-volume, high-value, slow-changing — evicting them silently loses
// reviewer trust calibration built up over time.
export const EVICTION_EXEMPT_CATEGORIES: ReadonlySet<string> = new Set(['person']);

export type MemoryCategory = typeof CATEGORIES[number];

export interface NewMemory {
  text: string;
  category: MemoryCategory;
  file_path?: string | null;
  git_sha?: string | null;
  project?: string | null;
  pinned?: boolean;
  tags?: string | null; // comma-separated
  load_with?: string | null; // comma-separated IDs
  ephemeral?: boolean;
}

/** A vector and the exact string it was embedded from (see embedSource). */
export interface Embedded {
  vector: ArrayLike<number>;
  source: string;
}

export type StoreResult =
  | { stored: true; id: string; evicted: number }
  | { stored: false; id: string; existing: string };

export interface MemoryRow {
  id: string;
  text: string;
  category: MemoryCategory;
  file_path: string | null;
  git_sha: string | null;
  project: string | null;
  created_at: string;
  last_accessed: string | null;
  pinned: number; // 0 or 1 (SQLite boolean)
  tags: string | null; // comma-separated tags for search enrichment
  load_with: string | null; // comma-separated memory IDs to auto-surface with this one
  ephemeral: number; // 0 or 1 — session-scoped, cleared at session end unless promoted
}

export interface StalenessResult {
  stale: boolean;
  reason?: string;
  commits_since?: number;
}

export interface EvictionConfig {
  maxMemories: number;
}

/** Without MEMORY_MAX_COUNT; the server reads that through evictionConfigFromEnv() */
export const DEFAULT_EVICTION_CONFIG: EvictionConfig = {
  maxMemories: 2000,
};
