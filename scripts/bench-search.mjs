// Search latency at 10k memories, against the budget of 50 ms per query.
// Not a CI gate: timings on shared runners are too noisy. Run with `npm run bench`.
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { seedMemories, mockEmbed } from '../dist/test-helpers.js';
import { createMemoryDb } from '../dist/db.js';

const COUNT = 10_000;
const RUNS = 50;

const dir = mkdtempSync(path.join(tmpdir(), 'claude-memory-bench-'));
try {
  await seedMemories(dir, COUNT);
  const db = createMemoryDb(path.join(dir, 'memory.db'));
  const queries = await Promise.all(Array.from({ length: RUNS }, (_, i) => mockEmbed(`bench query ${i}`)));

  const measure = project => {
    db.searchVectors(queries[0], 5, project);
    const times = queries.map(q => {
      const start = performance.now();
      db.searchVectors(q, 5, project);
      return performance.now() - start;
    }).sort((a, b) => a - b);
    return `median ${times[RUNS >> 1].toFixed(1)} ms, p95 ${times[Math.floor(RUNS * 0.95)].toFixed(1)} ms`;
  };

  console.log(`${COUNT} memories, ${RUNS} queries each`);
  console.log(`  all projects: ${measure()}`);
  console.log(`  one project (${COUNT / 20} rows): ${measure('project-0')}`);
  db.close();
} finally {
  rmSync(dir, { recursive: true, force: true });
}
