// Search latency at 10k memories, against the budget of 50 ms per query.
// Not a CI gate: timings on shared runners are too noisy. Run with `npm run bench`.
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { seedMemories, mockEmbed } from '../dist/test-helpers.js';
import { createMemoryDb } from '../dist/db.js';

const COUNT = 10_000;
const RUNS = 200;

const dir = mkdtempSync(path.join(tmpdir(), 'claude-memory-bench-'));
try {
  await seedMemories(dir, COUNT);
  const db = createMemoryDb(path.join(dir, 'memory.db'));
  const queries = await Promise.all(Array.from({ length: RUNS }, (_, i) => mockEmbed(`bench query ${i}`)));

  const time = run => {
    run(queries[0]);
    const times = queries.map(q => {
      const start = performance.now();
      run(q);
      return performance.now() - start;
    }).sort((a, b) => a - b);
    return `median ${times[RUNS >> 1].toFixed(1)} ms, p95 ${times[Math.floor(RUNS * 0.95)].toFixed(1)} ms`;
  };

  console.log(`${COUNT} memories, ${RUNS} runs each`);
  for (const [label, project] of [['all projects', undefined], [`one project (${COUNT / 20} rows)`, 'project-0']]) {
    console.log(`  ${label}`);
    console.log(`    search: ${time(q => db.searchVectors(q, 5, project))}`);
    // Every query, store and summary also counts unsearchable memories in its scope
    console.log(`    unsearchable count: ${time(() => db.listUnsearchable(project))}`);
    console.log(`    memory_query (both): ${time(q => { db.searchVectors(q, 5, project); db.listUnsearchable(project); })}`);
  }
  db.close();
} finally {
  rmSync(dir, { recursive: true, force: true });
}
