import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import path from 'path';
import { createServer } from './create-server.js';
import { createMemoryIndex } from './memory-index.js';
import { getDefaultDb, DEFAULT_DATA_DIR } from './db.js';
import { getEmbedder } from './embeddings.js';
import { restrictToOwner } from './permissions.js';

async function main(): Promise<void> {
  // Anything the server creates (db sidecars, notes) is owner-only from the start
  process.umask(0o077);
  // Versions up to 4.0.0 kept a copy of every memory in vector_index/index.json. It is
  // no longer read or written, but stays on disk as the rollback path.
  const legacyIndex = path.join(DEFAULT_DATA_DIR, 'vector_index');
  restrictToOwner(legacyIndex, [path.join(legacyIndex, 'index.json')]);

  const db = getDefaultDb();
  const index = createMemoryIndex(db);
  const server = createServer({ db, index });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('claude-memory MCP server running on stdio');

  const unsearchable = db.listUnsearchable().length;
  if (unsearchable > 0) {
    console.error(`claude-memory: ${unsearchable} memories are not searchable yet; re-embedding them in the background`);
  }

  // Warm the embedding model in background, then heal what older versions or other sessions left unsearchable
  getEmbedder().then(() => {
    console.error('Embedding model ready');
    return index.heal();
  }).then(result => {
    if (result.embedded > 0) console.error(`claude-memory: re-embedded ${result.embedded} memories`);
  }).catch(err => {
    console.error('Embedding model failed to load:', (err as Error).message);
  });
}

main().catch(err => {
  console.error('Server error:', err);
  process.exit(1);
});
