# claude-memory-mcp

A local MCP (Model Context Protocol) server that gives Claude Code persistent, searchable memory across conversations. Stores facts about codebases — architecture, conventions, gotchas, decisions, and preferences — using semantic embeddings for retrieval and git-based staleness detection.

## Architecture

```
src/
  server.ts          MCP entry point, registers 4 tools via stdio
  embeddings.ts      Local embedding model (Xenova/all-MiniLM-L6-v2, 384-dim)
  memory-index.ts    Vectra vector index for semantic search + dedup
  db.ts              SQLite metadata store (category, file path, git SHA, project)
  staleness.ts       Git log-based staleness detection for file-linked memories
  types.ts           Shared type definitions
```

Data is stored in `~/.claude-memory/` (separate from source code):
- `memory.db` — SQLite database (WAL mode)
- `vector_index/` — Vectra local index files

## Tools

| Tool | Description |
|------|-------------|
| `memory_store` | Store a fact. Deduplicates via cosine similarity (0.85 threshold). Captures git SHA for file-linked memories. Auto-detects project from git root. |
| `memory_query` | Semantic search. Returns top-K results with staleness flags. Optional project filter. Tracks access for eviction. |
| `memory_list` | List memories filtered by category and/or project. |
| `memory_forget` | Remove a memory by ID from both stores. |

### Categories

`architecture` · `convention` · `gotcha` · `decision` · `preference`

### Eviction

Memories are automatically evicted when the count exceeds `maxMemories` (default 500). Least-recently-accessed memories are removed first. Configure via environment variables:

- `MEMORY_MAX_COUNT` — max stored memories (default 500)
- `MEMORY_MAX_AGE_DAYS` — max age in days (default 90)

### Project Scoping

When storing a memory with a `file_path`, the project is auto-detected from the git repository root name. You can also pass `project` explicitly. `memory_query` accepts an optional `project` filter to scope results.

## Setup

```bash
npm install
npm run build
```

### Register with Claude Code

```bash
# Global (all projects)
claude mcp add memory -s user $(which node) /path/to/claude-memory/dist/server.js

# Single project
claude mcp add memory $(which node) /path/to/claude-memory/dist/server.js
```

Verify with `claude mcp list` or `/mcp` inside a session.

## Development

```bash
npm run build       # Compile TypeScript to dist/
npm run dev         # Watch mode
npm test            # Run tests (vitest)
npm run test:watch  # Watch mode tests
```

## How it works

1. **Store**: Text is embedded locally, checked against existing vectors (cosine > 0.85 = duplicate), then stored in both Vectra (for search) and SQLite (for metadata). Eviction runs if over limit.
2. **Query**: Input is embedded, Vectra returns nearest neighbours (optionally filtered by project), SQLite enriches with metadata, staleness is checked via `git log {sha}..HEAD -- {file}`, and access timestamps are updated.
3. **Forget**: Removes from both Vectra index and SQLite.

The embedding model (`Xenova/all-MiniLM-L6-v2`) runs locally — no API calls. It loads lazily on first use (~30MB download, cached after that).

## Dependencies

**Runtime:**
- `@modelcontextprotocol/sdk` — MCP server framework
- `@huggingface/transformers` — local embedding inference
- `onnxruntime-node` — ONNX runtime for the embedding model
- `better-sqlite3` — SQLite bindings
- `vectra` — local vector index

**Development:**
- `typescript` — type safety
- `vitest` — test runner
- `@types/better-sqlite3`, `@types/node` — type definitions
