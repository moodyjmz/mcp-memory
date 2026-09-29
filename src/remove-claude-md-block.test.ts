import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'remove-claude-md-block.py');
const BLOCK = '<!-- claude-memory-mcp -->\n## Codebase Memory (MCP)\n\nOld instructions.\n<!-- /claude-memory-mcp -->';

describe('remove-claude-md-block.py', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'claude-md-'));
    file = path.join(dir, 'CLAUDE.md');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function run(content: string) {
    writeFileSync(file, content);
    const r = spawnSync('python3', [SCRIPT, file], { encoding: 'utf8' });
    return { status: r.status, out: r.stdout + r.stderr, after: readFileSync(file, 'utf8') };
  }

  it('removes a block appended at the end, as setup.sh wrote it', () => {
    const r = run(`# Mine\n\nKeep this.\n\n${BLOCK}\n`);
    expect(r.status).toBe(0);
    expect(r.after).toBe('# Mine\n\nKeep this.\n');
  });

  it('removes a block in the middle and keeps the text on both sides', () => {
    const r = run(`# Mine\n\nAbove.\n\n${BLOCK}\n\n## Later\n\nBelow.\n`);
    expect(r.after).toBe('# Mine\n\nAbove.\n\n## Later\n\nBelow.\n');
  });

  it('removes a block at the start of the file', () => {
    const r = run(`${BLOCK}\n\n# Mine\n`);
    expect(r.after).toBe('# Mine\n');
  });

  it('leaves an empty file when the block was all there was', () => {
    const r = run(`\n${BLOCK}\n`);
    expect(r.after).toBe('');
  });

  it('leaves a file without the block unchanged', () => {
    const r = run('# Mine\n\n<!-- some-other-tool -->\nx\n<!-- /some-other-tool -->\n');
    expect(r.status).toBe(0);
    expect(r.after).toBe('# Mine\n\n<!-- some-other-tool -->\nx\n<!-- /some-other-tool -->\n');
    expect(r.out).toMatch(/No claude-memory-mcp block/);
  });

  it('refuses to touch a file whose markers do not pair up', () => {
    const broken = '# Mine\n<!-- claude-memory-mcp -->\nno end marker\n';
    const r = run(broken);
    expect(r.status).toBe(1);
    expect(r.after).toBe(broken);
  });
});
