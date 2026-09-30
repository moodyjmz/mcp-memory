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
  /** Apply the update, re-embedding when text or tags change. Returns whether a new vector was written. */
  updateFact(id: string, fields: MemoryUpdateFields): Promise<boolean>;
  queryFacts(text: string, topK?: number, project?: string): Promise<VectorHit[]>;
  /**
   * Re-embed every unsearchable memory. One pass, one at a time per process; a
   * call while a pass runs gets that pass. Never rejects: failures are logged.
   */
  heal(): Promise<HealResult>;
}

export interface HealResult {
  embedded: number;
  /** Rows another session edited or deleted while they were being embedded */
  changed: number;
  /** Rows another process re-embedded or deleted after this pass listed them */
  skipped: number;
  error?: string;
}

function shuffle<T>(items: T[]): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

export function createMemoryIndex(
  db: MemoryDb,
  { embed = defaultEmbed, eviction = DEFAULT_EVICTION_CONFIG }: { embed?: EmbedFn; eviction?: EvictionConfig } = {},
): MemoryIndex {
  let healing: Promise<HealResult> | null = null;

  async function healPass(): Promise<HealResult> {
    const result: HealResult = { embedded: 0, changed: 0, skipped: 0 };
    try {
      // After an upgrade every restarted session heals at once. A random order spreads
      // them over different rows, and the re-check skips rows another one has done.
      for (const { id } of shuffle(db.listUnsearchable())) {
        const row = db.getUnsearchable(id);
        if (!row) {
          result.skipped++;
          continue;
        }
        const source = embedSource(row.text, row.tags);
        if (db.putVectorIfCurrent(row.id, { vector: await embed(source), source })) {
          result.embedded++;
        } else {
          // No retry here: the next store or query that sees it unsearchable starts another pass
          result.changed++;
          console.error(`claude-memory: memory ${row.id} was edited or deleted while being re-embedded; if it still exists, the next pass retries it`);
        }
      }
    } catch (err) {
      result.error = (err as Error).message;
      console.error(`claude-memory: re-embedding unsearchable memories failed: ${result.error}`);
    }
    return result;
  }

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
      // False when another session changed or deleted the memory while it was embedded
      return db.updateMemoryAndVector(id, fields, { vector: await embed(source), source });
    },

    async queryFacts(text, topK = 5, project?) {
      return db.searchVectors(await embed(text), topK, project);
    },

    heal() {
      healing ??= healPass().finally(() => { healing = null; });
      return healing;
    },
  };
}
