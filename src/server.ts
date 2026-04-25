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

function getGitRootPath(file_path: string): string | null {
  try {
    const absPath = path.isAbsolute(file_path) ? file_path : path.resolve(file_path);
    const cwd = path.dirname(absPath);
    return execSync('git rev-parse --show-toplevel', { cwd, encoding: 'utf8', timeout: 5000 }).trim();
  } catch {
    return null;
  }
}

function getGitRemote(file_path: string): string | null {
  try {
    const absPath = path.isAbsolute(file_path) ? file_path : path.resolve(file_path);
    const cwd = path.dirname(absPath);
    const url = execSync('git remote get-url origin', { cwd, encoding: 'utf8', timeout: 5000 }).trim();
    // Normalise: strip .git suffix, convert SSH to HTTPS form, strip fragments/query strings
    const normalized = url.replace(/\.git$/, '').replace(/^git@([^:]+):/, 'https://$1/');
    // Strip fragments and query strings so a crafted remote can't spoof another project's ID
    return normalized.split('?')[0].split('#')[0];
  } catch {
    return null;
  }
}

function toRelativePath(file_path: string): string {
  const root = getGitRootPath(file_path);
  if (!root) return file_path;
  const absPath = path.isAbsolute(file_path) ? file_path : path.resolve(file_path);
  const rel = path.relative(root, absPath);
  return rel || file_path;
}

function getProjectId(file_path: string): string | null {
  // Prefer git remote URL (portable), fall back to repo dir name
  return getGitRemote(file_path) || (() => {
    const root = getGitRootPath(file_path);
    return root ? path.basename(root) : null;
  })();
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
    file_path: z.string().optional().describe('Related file path. Converted to relative (portable) on storage. Enables staleness detection.'),
    project: z.string().optional().describe('Project identifier for multi-project filtering'),
    pinned: z.boolean().optional().describe('Pin this memory so it is never evicted. Use for user-provided preferences and permanent facts.'),
    tags: z.array(z.string()).optional().describe('Keywords/tags to improve search discoverability. These are embedded alongside the text for semantic matching.'),
    load_with: z.array(z.string()).optional().describe('IDs of other memories that should always surface alongside this one. Use when two facts are only useful together.'),
  },
}, async ({ text, category, file_path, project, pinned, tags, load_with }) => {
  const db = getDefaultDb();
  const index = getDefaultIndex();

  // Auto-detect project from git remote URL if not provided
  const resolvedProject = project || (file_path ? getProjectId(file_path) : null) || undefined;
  const git_sha = file_path ? getGitSha(file_path) : null;
  // Store relative path (portable across machines)
  const storedPath = file_path ? toRelativePath(file_path) : undefined;

  const tagsString = tags?.length ? tags.join(', ') : undefined;
  const loadWithString = load_with?.length ? load_with.join(',') : undefined;

  const result = await index.addFact(text, {
    category: category as MemoryCategory,
    file_path: storedPath,
    project: resolvedProject,
    tags: tagsString,
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

  db.insertMemory(result.id, text, category as MemoryCategory, storedPath, git_sha, resolvedProject, pinned, tagsString, loadWithString);

  // Evict old memories if over limit
  const evicted = await evictIfNeeded();

  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({
        stored: true,
        id: result.id,
        category,
        file_path: storedPath || null,
        project: resolvedProject || null,
        pinned: pinned || false,
        tags: tags || null,
        load_with: load_with || null,
        ...(evicted > 0 ? { evicted } : {}),
      }, null, 2),
    }],
  };
});

// ─── memory_query ────────────────────────────────────────────────────────────

server.registerTool('memory_query', {
  description: 'Search memories by semantic similarity. Returns the most relevant stored facts, with staleness flags for file-linked memories. Also returns also_relevant: memories sharing tags with the results but not semantically close enough to rank — these are often causally related facts you should read alongside the main results.',
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
      text: row?.text ?? r.text,         // SQL is authoritative (survives memory_update)
      category: row?.category ?? r.category,
      score: Math.round(r.score * 1000) / 1000,
      file_path: row?.file_path || null,
      project: row?.project || null,
      date: row?.created_at || null,
      tags: row?.tags || null,
      load_with: row?.load_with ? row.load_with.split(',').map(s => s.trim()) : null,
      stale: staleness.stale,
      ...(staleness.commits_since ? { commits_since: staleness.commits_since } : {}),
      ...(staleness.reason ? { stale_reason: staleness.reason } : {}),
    };
  });

  // Tag-based also_relevant: memories sharing tags with results but not already returned.
  // Catches causally related facts that are semantically distant.
  const resultIds = new Set(enriched.map(r => r.id));
  const allResultTags = new Set(
    enriched.flatMap(r => r.tags ? r.tags.split(',').map(t => t.trim()).filter(Boolean) : [])
  );

  type AlsoRelevant = { id: string; excerpt: string; category: string; tags: string[] | null; shared_tags: number };
  let alsoRelevant: AlsoRelevant[] = [];

  if (allResultTags.size > 0 && project) {
    const allProjectMemories = db.listMemories(undefined, project);

    alsoRelevant = allProjectMemories
      .filter(row => !resultIds.has(row.id) && row.tags)
      .map(row => {
        const memTags = row.tags!.split(',').map(t => t.trim()).filter(Boolean);
        const shared = memTags.filter(t => allResultTags.has(t)).length;
        return { row, shared };
      })
      .filter(({ shared }) => shared > 0)
      .sort((a, b) => b.shared - a.shared)
      .slice(0, 3)
      .map(({ row, shared }) => ({
        id: row.id,
        excerpt: row.text.length > 100 ? row.text.slice(0, 97) + '...' : row.text,
        category: row.category,
        tags: row.tags ? row.tags.split(',').map(t => t.trim()).filter(Boolean) : null,
        shared_tags: shared,
      }));
  }

  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({ results: enriched, also_relevant: alsoRelevant }, null, 2),
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

// ─── memory_update ───────────────────────────────────────────────────────────

server.registerTool('memory_update', {
  description: 'Amend an existing memory — update text, tags, category, file_path, pinned, or load_with without deleting and re-creating. If text or tags change the vector is re-embedded automatically.',
  inputSchema: {
    id: z.string().describe('The memory ID to update'),
    text: z.string().optional().describe('New text (triggers re-embedding)'),
    category: z.enum(CATEGORIES).optional().describe('New category'),
    file_path: z.string().nullable().optional().describe('New file path (null to clear)'),
    tags: z.array(z.string()).nullable().optional().describe('Replace tags (null to clear)'),
    pinned: z.boolean().optional().describe('Set pinned status'),
    load_with: z.array(z.string()).nullable().optional().describe('Replace load_with IDs (null to clear). IDs of memories that should always surface alongside this one.'),
  },
}, async ({ id, text, category, file_path, tags, pinned, load_with }) => {
  const db = getDefaultDb();
  const index = getDefaultIndex();

  const existing = db.getMemory(id);
  if (!existing) {
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ updated: false, reason: 'Memory not found' }, null, 2),
      }],
    };
  }

  const newText = text ?? existing.text;
  const newTags = tags !== undefined
    ? (tags === null ? null : tags.join(', '))
    : existing.tags;

  // Re-embed if text or tags changed
  const textChanged = text !== undefined && text !== existing.text;
  const tagsChanged = tags !== undefined && (tags === null ? existing.tags !== null : tags.join(', ') !== existing.tags);

  if (textChanged || tagsChanged) {
    await index.updateFact(id, newText, {
      category: (category ?? existing.category) as string,
      file_path: file_path !== undefined ? (file_path ?? undefined) : (existing.file_path ?? undefined),
      project: existing.project ?? undefined,
      tags: newTags ?? undefined,
    });
  }

  const loadWithString = load_with !== undefined
    ? (load_with === null ? null : load_with.join(','))
    : undefined;

  db.updateMemory(id, {
    ...(text !== undefined ? { text } : {}),
    ...(category !== undefined ? { category: category as MemoryCategory } : {}),
    ...(file_path !== undefined ? { file_path } : {}),
    ...(tags !== undefined ? { tags: newTags } : {}),
    ...(pinned !== undefined ? { pinned } : {}),
    ...(loadWithString !== undefined ? { load_with: loadWithString } : {}),
  });

  const updated = db.getMemory(id);
  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({
        updated: true,
        id,
        text: updated?.text,
        category: updated?.category,
        tags: updated?.tags,
        load_with: updated?.load_with ? updated.load_with.split(',').map(s => s.trim()) : null,
        pinned: updated?.pinned === 1,
        re_embedded: textChanged || tagsChanged,
      }, null, 2),
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

// ─── memory_graph ────────────────────────────────────────────────────────────

server.registerTool('memory_graph', {
  description: 'Compact table-of-contents view of all memories for a project — IDs, short excerpts, tags, and category grouped together. Use at session start to see what exists before querying. Much lighter than memory_list.',
  inputSchema: {
    project: z.string().optional().describe('Project identifier. Auto-detected from file_path if not given.'),
    file_path: z.string().optional().describe('A file in the project — used to auto-detect project if project is not given.'),
  },
}, async ({ project, file_path }) => {
  const db = getDefaultDb();

  const resolvedProject = project || (file_path ? getProjectId(file_path) : null) || undefined;
  if (!resolvedProject) {
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ error: 'Could not determine project. Provide project or file_path.' }, null, 2),
      }],
    };
  }

  const all = db.listMemories(undefined, resolvedProject);

  const byCategory: Record<string, Array<{
    id: string;
    excerpt: string;
    tags: string[] | null;
    file_path: string | null;
    pinned: boolean;
    load_with: string[] | null;
  }>> = {};

  for (const row of all) {
    const cat = row.category;
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push({
      id: row.id,
      excerpt: row.text.length > 120 ? row.text.slice(0, 117) + '...' : row.text,
      tags: row.tags ? row.tags.split(',').map(t => t.trim()) : null,
      file_path: row.file_path || null,
      pinned: row.pinned === 1,
      load_with: row.load_with ? row.load_with.split(',').map(s => s.trim()) : null,
    });
  }

  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({
        project: resolvedProject,
        total: all.length,
        by_category: byCategory,
      }, null, 2),
    }],
  };
});

// ─── repo_link ───────────────────────────────────────────────────────────────

server.registerTool('repo_link', {
  description: 'Record a cross-repo relationship — how one project provides, consumes, or depends on another. E.g. "core-lib provides shared types consumed by frontend".',
  inputSchema: {
    source: z.string().describe('Source project name (the provider)'),
    target: z.string().describe('Target project name (the consumer)'),
    relationship_type: z.enum(['provides', 'consumes', 'depends_on', 'builds_from', 'extends']).describe('Type of relationship'),
    description: z.string().describe('What is provided/consumed/shared — be specific'),
    file_path: z.string().optional().describe('File where the relationship is visible (e.g. the import or config)'),
  },
}, async ({ source, target, relationship_type, description, file_path }) => {
  const db = getDefaultDb();
  const id = db.addRelationship(source, target, relationship_type, description, file_path);

  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({ linked: true, id, source, target, relationship_type, description }, null, 2),
    }],
  };
});

// ─── repo_unlink ─────────────────────────────────────────────────────────────

server.registerTool('repo_unlink', {
  description: 'Remove a cross-repo relationship by ID.',
  inputSchema: {
    id: z.number().describe('The relationship ID to remove'),
  },
}, async ({ id }) => {
  const db = getDefaultDb();
  db.removeRelationship(id);

  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({ unlinked: true, id }, null, 2),
    }],
  };
});

// ─── repo_map ────────────────────────────────────────────────────────────────

server.registerTool('repo_map', {
  description: 'Show all known cross-repo relationships, optionally filtered by project. Returns how repos connect: what provides what, what depends on what.',
  inputSchema: {
    project: z.string().optional().describe('Filter to relationships involving this project'),
  },
}, async ({ project }) => {
  const db = getDefaultDb();
  const relationships = db.getRepoMap(project);

  return {
    content: [{
      type: 'text' as const,
      text: relationships.length === 0
        ? JSON.stringify({ relationships: [], message: 'No cross-repo relationships stored yet' }, null, 2)
        : JSON.stringify(relationships, null, 2),
    }],
  };
});

// ─── memory_project_summary ──────────────────────────────────────────────────

server.registerTool('memory_project_summary', {
  description: 'Lightweight project overview for session start: category counts, pinned memories, repo relationships, and recently accessed memories. Does NOT return all memories.',
  inputSchema: {
    project: z.string().optional().describe('Project identifier. Auto-detected from file_path if not given.'),
    file_path: z.string().optional().describe('A file in the project — used to auto-detect project if project is not given.'),
  },
}, async ({ project, file_path }) => {
  const db = getDefaultDb();

  const resolvedProject = project || (file_path ? getProjectId(file_path) : null) || undefined;
  if (!resolvedProject) {
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ error: 'Could not determine project. Provide project or file_path.' }, null, 2),
      }],
    };
  }

  const allMemories = db.listMemories(undefined, resolvedProject);

  // Category counts
  const categoryCounts: Record<string, number> = {};
  for (const row of allMemories) {
    categoryCounts[row.category] = (categoryCounts[row.category] || 0) + 1;
  }

  // Pinned memories (full text)
  const pinned = allMemories
    .filter(r => r.pinned === 1)
    .map(r => ({ id: r.id, text: r.text, category: r.category }));

  // 5 most recently accessed memories
  const recent = [...allMemories]
    .sort((a, b) => {
      const aDate = a.last_accessed || a.created_at;
      const bDate = b.last_accessed || b.created_at;
      return bDate.localeCompare(aDate);
    })
    .slice(0, 5)
    .map(r => ({ id: r.id, text: r.text, category: r.category }));

  // Repo relationships
  const relationships = db.getRepoMap(resolvedProject);

  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({
        project: resolvedProject,
        total_memories: allMemories.length,
        category_counts: categoryCounts,
        pinned_memories: pinned,
        recent_memories: recent,
        repo_relationships: relationships,
      }, null, 2),
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
