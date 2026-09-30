import { DEFAULT_EVICTION_CONFIG, type EvictionConfig } from './types.js';

/**
 * MEMORY_MAX_COUNT as a whole number of memories. Anything else stops the server:
 * parseInt read "1e3" as 1 and "abc" as NaN, which evicted nearly everything or
 * failed every store after its row was written.
 */
export function evictionConfigFromEnv(env: NodeJS.ProcessEnv = process.env): EvictionConfig {
  const raw = env.MEMORY_MAX_COUNT;
  const trimmed = raw?.trim();
  if (!trimmed) return DEFAULT_EVICTION_CONFIG;
  const value = Number(trimmed);
  // Accepts everything parseInt read correctly before: whitespace, a leading + or zeros
  if (!/^\+?[0-9]+$/.test(trimmed) || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`MEMORY_MAX_COUNT must be a positive whole number, got "${raw}"`);
  }
  return { maxMemories: value };
}
