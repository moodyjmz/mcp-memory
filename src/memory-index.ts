import { LocalIndex } from 'vectra';
import type { MetadataFilter } from 'vectra';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { embed as defaultEmbed } from './embeddings.js';
import type { MemoryMetadata, AddFactResult, QueryFactResult } from './types.js';

const DEFAULT_DATA_DIR = path.join(os.homedir(), '.claude-memory');

export interface MemoryIndex {
  addFact(text: string, metadata: { category: string; file_path?: string; project?: string }): Promise<AddFactResult>;
  queryFacts(text: string, topK?: number, project?: string): Promise<QueryFactResult[]>;
  deleteFact(id: string): Promise<void>;
}

export function createMemoryIndex(
  indexPath: string,
  embedFn: (text: string) => Promise<number[]> = defaultEmbed,
): MemoryIndex {
  let index: LocalIndex<MemoryMetadata> | null = null;

  async function getIndex(): Promise<LocalIndex<MemoryMetadata>> {
    if (index) return index;
    fs.mkdirSync(indexPath, { recursive: true });
    index = new LocalIndex<MemoryMetadata>(indexPath);
    if (!await index.isIndexCreated()) {
      await index.createIndex();
    }
    return index;
  }

  return {
    async addFact(text, metadata) {
      const idx = await getIndex();
      const vector = await embedFn(text);

      // Semantic dedup — reject if a very similar memory already exists
      const results = await idx.queryItems(vector, '', 1);
      if (results.length > 0 && results[0].score > 0.85) {
        return { added: false, existing: results[0].item.metadata.text, id: results[0].item.id };
      }

      const fullMetadata: MemoryMetadata = {
        text,
        category: metadata.category as MemoryMetadata['category'],
        file_path: metadata.file_path || '',
        project: metadata.project || '',
      };
      const item = await idx.insertItem({ vector, metadata: fullMetadata });
      return { added: true, id: item.id };
    },

    async queryFacts(text, topK = 5, project?) {
      const idx = await getIndex();
      const vector = await embedFn(text);

      const filter: MetadataFilter | undefined = project
        ? { project: { '$eq': project } }
        : undefined;

      const results = await idx.queryItems(vector, '', topK, filter);
      return results.map(r => ({
        id: r.item.id,
        text: r.item.metadata.text,
        category: r.item.metadata.category,
        score: r.score,
      }));
    },

    async deleteFact(id) {
      const idx = await getIndex();
      await idx.deleteItem(id);
    },
  };
}

// Default singleton for production
let _default: MemoryIndex | null = null;

export function getDefaultIndex(): MemoryIndex {
  if (!_default) {
    _default = createMemoryIndex(path.join(DEFAULT_DATA_DIR, 'vector_index'));
  }
  return _default;
}
