import { embed as defaultEmbed } from './embeddings.js';
import { embedSource } from './embed-source.js';
import type { MemoryDb, MemoryUpdateFields } from './db.js';
import type { VectorHit } from './vectors.js';
import { DEFAULT_EVICTION_CONFIG } from './types.js';
import type { NewMemory, StoreResult, EvictionConfig } from './types.js';

type EmbedFn = (text: string) => Promise<ArrayLike<number>>;

/**
 * Semantic operations over the SQLite store. Embedding is slow and async, so it
 * always happens here, before the db opens its (synchronous) write transaction.
 */
export interface MemoryIndex {
  addFact(memory: NewMemory): Promise<StoreResult>;
  /** Apply the update, re-embedding when text or tags change. Returns whether it re-embedded. */
  updateFact(id: string, fields: MemoryUpdateFields): Promise<boolean>;
  queryFacts(text: string, topK?: number, project?: string): Promise<VectorHit[]>;
}

export function createMemoryIndex(
  db: MemoryDb,
  { embed = defaultEmbed, eviction = DEFAULT_EVICTION_CONFIG }: { embed?: EmbedFn; eviction?: EvictionConfig } = {},
): MemoryIndex {
  return {
    async addFact(memory) {
      const source = embedSource(memory.text, memory.tags);
      return db.storeMemory(memory, { vector: await embed(source), source }, eviction);
    },

    async updateFact(id, fields) {
      const row = db.getMemory(id);
      if (!row) return false;
      const source = embedSource(fields.text ?? row.text, 'tags' in fields ? fields.tags : row.tags);
      if (source === embedSource(row.text, row.tags)) {
        db.updateMemory(id, fields);
        return false;
      }
      db.updateMemoryAndVector(id, fields, { vector: await embed(source), source });
      return true;
    },

    async queryFacts(text, topK = 5, project?) {
      return db.searchVectors(await embed(text), topK, project);
    },
  };
}
