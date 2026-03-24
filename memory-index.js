import { LocalIndex } from 'vectra';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { embed } from './embeddings.js';

const DATA_DIR = path.join(os.homedir(), '.claude-memory');
const INDEX_PATH = path.join(DATA_DIR, 'vector_index');

let index = null;

async function getIndex() {
  if (index) return index;
  fs.mkdirSync(INDEX_PATH, { recursive: true });
  index = new LocalIndex(INDEX_PATH);
  if (!await index.isIndexCreated()) {
    await index.createIndex();
  }
  return index;
}

export async function addFact(text, metadata) {
  const idx = await getIndex();
  const vector = await embed(text);

  // Semantic dedup — reject if a very similar memory already exists
  const results = await idx.queryItems(vector, 1);
  if (results.length > 0 && results[0].score > 0.85) {
    return { added: false, existing: results[0].item.metadata.text, id: results[0].item.id };
  }

  const item = await idx.insertItem({ vector, metadata: { text, ...metadata } });
  return { added: true, id: item.id };
}

export async function queryFacts(text, topK = 5) {
  const idx = await getIndex();
  const vector = await embed(text);
  const results = await idx.queryItems(vector, topK);
  return results.map(r => ({
    id: r.item.id,
    text: r.item.metadata.text,
    category: r.item.metadata.category,
    score: r.score
  }));
}

export async function deleteFact(id) {
  const idx = await getIndex();
  await idx.deleteItem(id);
}
