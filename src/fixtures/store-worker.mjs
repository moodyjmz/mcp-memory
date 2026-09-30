// One Claude session's server process, forked by multi-process.test.ts.
// argv: <compiled dir> <data dir> <mode: distinct | same | forever | open> <count> <start at, epoch ms>
import path from 'path';
import { pathToFileURL } from 'url';

const [distDir, dataDir, mode, count, startAt] = process.argv.slice(2);
const load = file => import(pathToFileURL(path.join(distDir, file)).href);
const { createMemoryDb } = await load('db.js');
const { createMemoryIndex } = await load('memory-index.js');
const { mockEmbed } = await load('test-helpers.js');

// Every worker starts on the same tick so their writes overlap
await new Promise(resolve => setTimeout(resolve, Math.max(0, Number(startAt) - Date.now())));

const db = createMemoryDb(path.join(dataDir, 'memory.db'));
if (mode !== 'open') {
  const index = createMemoryIndex(db, { embed: mockEmbed, eviction: { maxMemories: 1_000_000 } });
  for (let i = 0; mode === 'forever' || i < Number(count); i++) {
    const text = mode === 'same' ? 'the same fact' : `fact ${process.pid} ${i}`;
    const result = await index.addFact({ text, category: 'gotcha' });
    process.stdout.write(JSON.stringify(result) + '\n');
  }
}
db.close();
