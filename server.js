import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { execSync } from 'child_process';
import path from 'path';
import { addFact, queryFacts, deleteFact } from './memory-index.js';
import { insertMemory, deleteMemory, getMemory, listMemories } from './db.js';
import { checkStaleness } from './staleness.js';
import { getEmbedder } from './embeddings.js';

const CATEGORIES = ['architecture', 'convention', 'gotcha', 'decision', 'preference'];

function getGitSha(file_path) {
  try {
    const absPath = path.isAbsolute(file_path) ? file_path : path.resolve(file_path);
    const cwd = path.dirname(absPath);
    return execSync('git rev-parse HEAD', { cwd, encoding: 'utf8', timeout: 5000 }).trim();
  } catch {
    return null;
  }
}

const server = new McpServer({
  name: 'claude-memory',
  version: '1.0.0'
});

// ─── memory_store ────────────────────────────────────────────────────────────

server.registerTool('memory_store', {
  description: 'Store a fact about the codebase — architectural decisions, conventions, gotchas, or preferences. Deduplicates semantically similar memories.',
  inputSchema: {
    text: z.string().describe('The fact to remember'),
    category: z.enum(CATEGORIES).describe('Category: architecture, convention, gotcha, decision, or preference'),
    file_path: z.string().optional().describe('Related file path (absolute). Enables staleness detection.'),
    project: z.string().optional().describe('Project identifier for multi-project filtering')
  }
}, async ({ text, category, file_path, project }) => {
  const git_sha = file_path ? getGitSha(file_path) : null;
  const result = await addFact(text, { category, file_path, project });

  if (!result.added) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          stored: false,
          reason: 'Semantically similar memory already exists',
          existing: result.existing,
          existing_id: result.id
        }, null, 2)
      }]
    };
  }

  insertMemory(result.id, text, category, file_path, git_sha, project);

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        stored: true,
        id: result.id,
        category,
        file_path: file_path || null,
        project: project || null
      }, null, 2)
    }]
  };
});

// ─── memory_query ────────────────────────────────────────────────────────────

server.registerTool('memory_query', {
  description: 'Search memories by semantic similarity. Returns the most relevant stored facts, with staleness flags for file-linked memories.',
  inputSchema: {
    text: z.string().describe('What to search for'),
    topK: z.number().optional().describe('Number of results to return (default 5)')
  }
}, async ({ text, topK }) => {
  const results = await queryFacts(text, topK || 5);

  const enriched = results.map(r => {
    const row = getMemory(r.id);
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
      ...(staleness.reason ? { stale_reason: staleness.reason } : {})
    };
  });

  return {
    content: [{
      type: 'text',
      text: JSON.stringify(enriched, null, 2)
    }]
  };
});

// ─── memory_list ─────────────────────────────────────────────────────────────

server.registerTool('memory_list', {
  description: 'List stored memories, optionally filtered by category and/or project. No staleness check (use memory_query for that).',
  inputSchema: {
    category: z.enum(CATEGORIES).optional().describe('Filter by category'),
    project: z.string().optional().describe('Filter by project')
  }
}, async ({ category, project }) => {
  const rows = listMemories(category, project);

  return {
    content: [{
      type: 'text',
      text: JSON.stringify(rows, null, 2)
    }]
  };
});

// ─── memory_forget ───────────────────────────────────────────────────────────

server.registerTool('memory_forget', {
  description: 'Remove a memory by ID from both vector index and database.',
  inputSchema: {
    id: z.string().describe('The memory ID to remove')
  }
}, async ({ id }) => {
  const existing = getMemory(id);
  if (!existing) {
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ forgotten: false, reason: 'Memory not found' }, null, 2)
      }]
    };
  }

  await deleteFact(id);
  deleteMemory(id);

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({ forgotten: true, id, text: existing.text }, null, 2)
    }]
  };
});

// ─── Start ───────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('claude-memory MCP server running on stdio');

  // Warm the embedding model in background
  getEmbedder().then(() => {
    console.error('Embedding model ready');
  }).catch(err => {
    console.error('Embedding model failed to load:', err.message);
  });
}

main().catch(err => {
  console.error('Server error:', err);
  process.exit(1);
});
