import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { execSync } from 'child_process';
import path from 'path';
import { getDefaultIndex } from './memory-index.js';
import { getDefaultDb } from './db.js';
import { checkStaleness } from './staleness.js';
import { getEmbedder } from './embeddings.js';
import { CATEGORIES, DEFAULT_EVICTION_CONFIG } from './types.js';
import type { MemoryCategory } from './types.js';

function getGitSha(file_path: string): string | null {
  try {
    const absPath = path.isAbsolute(file_path) ? file_path : path.resolve(file_path);
    const cwd = path.dirname(absPath);
    return execSync('git rev-parse HEAD', { cwd, encoding: 'utf8', timeout: 5000 }).trim();
  } catch {
    return null;
  }
}

function getGitRoot(file_path: string): string | null {
  try {
    const absPath = path.isAbsolute(file_path) ? file_path : path.resolve(file_path);
    const cwd = path.dirname(absPath);
    const root = execSync('git rev-parse --show-toplevel', { cwd, encoding: 'utf8', timeout: 5000 }).trim();
    return path.basename(root);
  } catch {
    return null;
  }
}

async function evictIfNeeded(): Promise<number> {
  const db = getDefaultDb();
  const index = getDefaultIndex();
  const ids = db.getEvictableIds(DEFAULT_EVICTION_CONFIG);

  for (const id of ids) {
    try { await index.deleteFact(id); } catch { /* already gone from index */ }
    db.deleteMemory(id);
  }

  return ids.length;
}

const server = new McpServer({
  name: 'claude-memory',
  version: '2.0.0',
});

// ─── memory_store ────────────────────────────────────────────────────────────

server.registerTool('memory_store', {
  description: 'Store a fact about the codebase — architectural decisions, conventions, gotchas, or preferences. Deduplicates semantically similar memories.',
  inputSchema: {
    text: z.string().describe('The fact to remember'),
    category: z.enum(CATEGORIES).describe('Category: architecture, convention, gotcha, decision, or preference'),
    file_path: z.string().optional().describe('Related file path (absolute). Enables staleness detection.'),
    project: z.string().optional().describe('Project identifier for multi-project filtering'),
  },
}, async ({ text, category, file_path, project }) => {
  const db = getDefaultDb();
  const index = getDefaultIndex();

  // Auto-detect project from git root if not provided
  const resolvedProject = project || (file_path ? getGitRoot(file_path) : null) || undefined;
  const git_sha = file_path ? getGitSha(file_path) : null;

  const result = await index.addFact(text, {
    category: category as MemoryCategory,
    file_path,
    project: resolvedProject,
  });

  if (!result.added) {
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          stored: false,
          reason: 'Semantically similar memory already exists',
          existing: result.existing,
          existing_id: result.id,
        }, null, 2),
      }],
    };
  }

  db.insertMemory(result.id, text, category as MemoryCategory, file_path, git_sha, resolvedProject);

  // Evict old memories if over limit
  const evicted = await evictIfNeeded();

  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({
        stored: true,
        id: result.id,
        category,
        file_path: file_path || null,
        project: resolvedProject || null,
        ...(evicted > 0 ? { evicted } : {}),
      }, null, 2),
    }],
  };
});

// ─── memory_query ────────────────────────────────────────────────────────────

server.registerTool('memory_query', {
  description: 'Search memories by semantic similarity. Returns the most relevant stored facts, with staleness flags for file-linked memories.',
  inputSchema: {
    text: z.string().describe('What to search for'),
    topK: z.number().optional().describe('Number of results to return (default 5)'),
    project: z.string().optional().describe('Filter results to a specific project'),
  },
}, async ({ text, topK, project }) => {
  const db = getDefaultDb();
  const index = getDefaultIndex();

  const results = await index.queryFacts(text, topK || 5, project);

  // Track access for eviction
  const ids = results.map(r => r.id);
  db.updateLastAccessed(ids);

  const enriched = results.map(r => {
    const row = db.getMemory(r.id);
    const staleness = row ? checkStaleness(row.file_path, row.git_sha) : { stale: false };

    return {
      id: r.id,
      text: r.text,
      category: r.category,
      score: Math.round(r.score * 1000) / 1000,
      file_path: row?.file_path || null,
      project: row?.project || null,
      date: row?.created_at || null,
      stale: staleness.stale,
      ...(staleness.commits_since ? { commits_since: staleness.commits_since } : {}),
      ...(staleness.reason ? { stale_reason: staleness.reason } : {}),
    };
  });

  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify(enriched, null, 2),
    }],
  };
});

// ─── memory_list ─────────────────────────────────────────────────────────────

server.registerTool('memory_list', {
  description: 'List stored memories, optionally filtered by category and/or project. No staleness check (use memory_query for that).',
  inputSchema: {
    category: z.enum(CATEGORIES).optional().describe('Filter by category'),
    project: z.string().optional().describe('Filter by project'),
  },
}, async ({ category, project }) => {
  const db = getDefaultDb();
  const rows = db.listMemories(category as MemoryCategory | undefined, project);

  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify(rows, null, 2),
    }],
  };
});

// ─── memory_forget ───────────────────────────────────────────────────────────

server.registerTool('memory_forget', {
  description: 'Remove a memory by ID from both vector index and database.',
  inputSchema: {
    id: z.string().describe('The memory ID to remove'),
  },
}, async ({ id }) => {
  const db = getDefaultDb();
  const index = getDefaultIndex();

  const existing = db.getMemory(id);
  if (!existing) {
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ forgotten: false, reason: 'Memory not found' }, null, 2),
      }],
    };
  }

  await index.deleteFact(id);
  db.deleteMemory(id);

  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({ forgotten: true, id, text: existing.text }, null, 2),
    }],
  };
});

// ─── Start ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
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
