import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SERVER_INSTRUCTIONS, SERVER_INSTRUCTIONS_MAX_CHARS } from './instructions.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(REPO, 'dist', 'server.js');

describe('SERVER_INSTRUCTIONS content', () => {
  it('stays under its size cap (it is loaded on every main-session turn)', () => {
    expect(SERVER_INSTRUCTIONS.length).toBeLessThanOrEqual(SERVER_INSTRUCTIONS_MAX_CHARS);
  });

  it('tells the model to load deferred tools before calling them', () => {
    expect(SERVER_INSTRUCTIONS).toMatch(/deferred/);
    expect(SERVER_INSTRUCTIONS).toMatch(/tool search/);
  });

  it('carries the session-start steps, including for non-git workspaces', () => {
    expect(SERVER_INSTRUCTIONS).toMatch(/memory_project_summary/);
    expect(SERVER_INSTRUCTIONS).toMatch(/ephemeral: true/);
    expect(SERVER_INSTRUCTIONS).toMatch(/isn't a git repo/);
  });

  it('carries the store and correction triggers', () => {
    expect(SERVER_INSTRUCTIONS).toMatch(/memory_query/);
    expect(SERVER_INSTRUCTIONS).toMatch(/memory_update or memory_forget/);
    expect(SERVER_INSTRUCTIONS).toMatch(/Tags should add search terms/);
    expect(SERVER_INSTRUCTIONS).toMatch(/load_with on both/);
    expect(SERVER_INSTRUCTIONS).toMatch(/memory_store_file/);
  });

  it('carries the session-end step, which the session-end hook may deliver too late', () => {
    expect(SERVER_INSTRUCTIONS).toMatch(/Before the session ends/);
    expect(SERVER_INSTRUCTIONS).toMatch(/promote or clear each ephemeral/);
  });

  it('holds no user-specific paths', () => {
    expect(SERVER_INSTRUCTIONS).not.toMatch(/\/Users\/|\/home\/|~\//);
  });
});

describe('stdio handshake', () => {
  let home: string;
  let client: Client;

  // release.yml runs the tests without building, so this hook may need to compile first.
  beforeAll(async () => {
    if (!existsSync(SERVER)) execSync('npm run build', { cwd: REPO, stdio: 'pipe' });
    // A throwaway HOME keeps the spawned server away from the real ~/.claude-memory store.
    home = mkdtempSync(path.join(tmpdir(), 'mem-instr-'));
    client = new Client({ name: 'instructions-test', version: '0.0.0' });
    await client.connect(new StdioClientTransport({
      command: process.execPath,
      args: [SERVER],
      env: { ...process.env, HOME: home } as Record<string, string>,
      stderr: 'pipe',
    }));
  }, 120_000);

  afterAll(async () => {
    await client?.close();
    rmSync(home, { recursive: true, force: true });
  });

  it('returns SERVER_INSTRUCTIONS in the initialize result', () => {
    expect(client.getInstructions()).toBe(SERVER_INSTRUCTIONS);
  });
});
