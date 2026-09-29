import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

// server.ts runs main() on import, so check its tool schemas as source text:
// every string or array argument a caller controls must carry an upper bound.
const serverSource = readFileSync(path.resolve(__dirname, 'server.ts'), 'utf8');
const schemaFields = serverSource
  .split('\n')
  .filter(line => /^\s+\w+: z\.(string|array|number)\(/.test(line));

describe('tool input limits', () => {
  it('has no schema field split across lines, which the per-line check would miss', () => {
    const openers = serverSource.split('\n').filter(line => /^\s+\w+: z\s*$/.test(line) || /^\s+\w+:\s*$/.test(line));
    expect(openers).toEqual([]);
  });

  it('finds the tool schema fields', () => {
    expect(schemaFields.length).toBeGreaterThan(30);
  });

  it.each(schemaFields.map(line => [line.trim().split(':')[0], line]))('%s is bounded', (_field, line) => {
    expect(line).toMatch(/\.max\(|\.regex\(/);
    if (line.includes('z.number(')) expect(line).toMatch(/\.int\(\)/);
    if (line.includes('z.array(')) expect(line).toMatch(/z\.array\(z\.string\(\)\.max\([^)]*\)\)\.max\(/);
  });
});
