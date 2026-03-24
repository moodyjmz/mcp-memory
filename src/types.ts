export const CATEGORIES = ['architecture', 'convention', 'gotcha', 'decision', 'preference'] as const;

export type MemoryCategory = typeof CATEGORIES[number];

// Vectra requires Record<string, MetadataTypes> where MetadataTypes = string | number | boolean.
// Optional fields are stored as empty strings when absent, not undefined.
export interface MemoryMetadata {
  [key: string]: string | number | boolean;
  text: string;
  category: MemoryCategory;
  file_path: string;
  project: string;
}

export interface MemoryRow {
  id: string;
  text: string;
  category: MemoryCategory;
  file_path: string | null;
  git_sha: string | null;
  project: string | null;
  created_at: string;
  last_accessed: string | null;
}

export interface StalenessResult {
  stale: boolean;
  reason?: string;
  commits_since?: number;
}

export interface AddFactResult {
  added: boolean;
  id: string;
  existing?: string;
}

export interface QueryFactResult {
  id: string;
  text: string;
  category: string;
  score: number;
}

export interface EvictionConfig {
  maxMemories: number;
  maxAgeDays: number;
}

export const DEFAULT_EVICTION_CONFIG: EvictionConfig = {
  maxMemories: parseInt(process.env.MEMORY_MAX_COUNT || '500', 10),
  maxAgeDays: parseInt(process.env.MEMORY_MAX_AGE_DAYS || '90', 10),
};
