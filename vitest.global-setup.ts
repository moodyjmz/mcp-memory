import { execFileSync } from 'child_process';
import { createRequire } from 'module';
import path from 'path';

// Forked test workers need compiled JS. Build to a cache dir, never to dist/, which
// is what a registered server runs: tests must not swap the code under a live session.
export const TEST_DIST = path.resolve('node_modules/.cache/claude-memory-test-dist');

export default function setup(): void {
  const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
  execFileSync(process.execPath, [tsc, '--outDir', TEST_DIST, '--declaration', 'false', '--sourceMap', 'false'], { stdio: 'inherit' });
}
