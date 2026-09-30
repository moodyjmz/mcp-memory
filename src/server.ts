import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './create-server.js';
import { getDefaultIndex } from './memory-index.js';
import { getDefaultDb } from './db.js';
import { getEmbedder } from './embeddings.js';

async function main(): Promise<void> {
  // Anything the server creates (db sidecars, index, notes) is owner-only from the start
  process.umask(0o077);
  const server = createServer({ db: getDefaultDb(), index: getDefaultIndex() });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('claude-memory MCP server running on stdio');

  // Warm the embedding model in background
  getEmbedder().then(() => {
    console.error('Embedding model ready');
  }).catch(err => {
    console.error('Embedding model failed to load:', (err as Error).message);
  });
}

main().catch(err => {
  console.error('Server error:', err);
  process.exit(1);
});
