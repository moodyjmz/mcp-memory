# claude-memory-mcp

A local MCP (Model Context Protocol) server that gives Claude Code persistent, searchable memory across conversations. Stores facts about codebases — architecture, conventions, gotchas, decisions, and preferences — using semantic embeddings for retrieval and git-based staleness detection.

## Architecture

```
src/
  server.ts          MCP entry point, registers tools via stdio
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
| `memory_store` | Store a fact. Deduplicates via cosine similarity (0.85 threshold). Captures git SHA for file-linked memories. Auto-detects project from git root. Accepts optional `tags` array for search enrichment. |
| `memory_query` | Semantic search. Returns top-K results with staleness flags. Optional project filter. Tracks access for eviction. |
| `memory_list` | List memories filtered by category and/or project. |
| `memory_forget` | Remove a memory by ID from both stores. |
| `repo_link` | Record a cross-repo relationship (provides, consumes, depends_on, builds_from, extends). |
| `repo_unlink` | Remove a cross-repo relationship by ID. |
| `repo_map` | Show all known cross-repo relationships, optionally filtered by project. |
| `memory_project_summary` | Lightweight project overview for session start: category counts, pinned memories, repo relationships, and 5 most recently accessed memories. |

### Categories

`architecture` · `convention` · `gotcha` · `decision` · `preference` · `relationship`

### Cross-Repo Knowledge

Use `repo_link` to record how projects relate — e.g. "core-lib provides shared types consumed by frontend". These relationships are stored in a dedicated table (not the vector index) for fast structured queries. Use `repo_map` to see all connections for a project.

### Tags

`memory_store` accepts an optional `tags` array of keywords to improve search discoverability. Tags are embedded alongside the memory text into the vector, so semantic queries matching tag terms score higher — even when those words don't appear in the memory itself.

```json
{
  "text": "Rate limiter uses a sliding window algorithm with Redis sorted sets",
  "category": "architecture",
  "tags": ["throttling", "API", "redis", "rate-limit", "sliding-window"]
}
```

Tags are stored as a comma-separated string in SQLite and returned in `memory_query` results.

### Eviction

Memories are automatically evicted when the count exceeds `maxMemories` (default 500). Least-recently-accessed memories are removed first. **Pinned memories are never evicted** — use `pinned: true` on `memory_store` for permanent facts and user preferences. Configure via environment variables:

- `MEMORY_MAX_COUNT` — max stored memories (default 500)
- `MEMORY_MAX_AGE_DAYS` — max age in days (default 90)

### Project Scoping

When storing a memory with a `file_path`, the project is auto-detected from the git repository root name. You can also pass `project` explicitly. `memory_query` accepts an optional `project` filter to scope results.

## Setup

```bash
npm install
npm run setup
```

This builds the TypeScript, registers the MCP server globally with Claude Code, adds memory usage instructions to `~/.claude/CLAUDE.md`, configures tool permissions for autonomous access, and installs session hooks — so Claude proactively stores and recalls knowledge across sessions.

Verify with `claude mcp list` or `/mcp` inside a session.

### Manual registration

If you prefer to register manually instead of using the setup script:

```bash
npm run build

# Global (all projects)
claude mcp add memory -s user $(which node) /path/to/claude-memory/dist/server.js

# Single project
claude mcp add memory $(which node) /path/to/claude-memory/dist/server.js
```

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

## Claude Code Hooks

Optional hooks to nudge Claude into using memory at the right moments. The `npm run setup` script installs these automatically — it copies the hook scripts to `~/.claude/hooks/` and adds the hooks and tool permissions to `~/.claude/settings.json`.

To install manually instead:

```bash
cp hooks/*.sh ~/.claude/hooks/
chmod +x ~/.claude/hooks/*.sh
```

Then add the hook config and memory tool permissions to `~/.claude/settings.json`:

```json
{
  "permissions": {
    "allow": [
      "mcp__memory__memory_store",
      "mcp__memory__memory_query",
      "mcp__memory__memory_list",
      "mcp__memory__memory_forget",
      "mcp__memory__memory_project_summary",
      "mcp__memory__repo_link",
      "mcp__memory__repo_unlink",
      "mcp__memory__repo_map"
    ]
  },
  "hooks": {
    "SessionStart": [
      {
        "hooks": [{ "type": "command", "command": "bash ~/.claude/hooks/session-start.sh", "timeout": 5 }]
      }
    ],
    "PreCompact": [
      {
        "hooks": [{ "type": "command", "command": "bash ~/.claude/hooks/pre-compact.sh", "timeout": 5 }]
      }
    ],
    "SessionEnd": [
      {
        "hooks": [{ "type": "command", "command": "bash ~/.claude/hooks/session-end.sh", "timeout": 5 }]
      }
    ]
  }
}
```

| Hook | Event | What it does |
|------|-------|-------------|
| `session-start.sh` | SessionStart | Detects project from git, reminds Claude to call `memory_project_summary` |
| `pre-compact.sh` | PreCompact | Warns Claude to store learnings before context is compressed |
| `session-end.sh` | SessionEnd | Reminds Claude to persist key findings before session closes |

All hooks output colour-coded console messages (cyan/red/yellow) for visibility.

## Gotchas

- **Build before first use** — the server runs from `dist/`, not `src/`. You must run `npm run build` after cloning or the server won't start.
- **nvm users** — `$(which node)` captures the active nvm node path at registration time. If you switch node versions later, the MCP registration will break. Consider using a `.nvmrc` with `nvm exec` or the full versioned path.
- **Native module (`better-sqlite3`)** — compiles on `npm install`. If you change CPU architecture (e.g., x86 to ARM Mac) or jump major node versions, run `npm rebuild`.
- **First run downloads ~30MB** — the embedding model (`Xenova/all-MiniLM-L6-v2`) is fetched and cached locally on first `memory_store` or `memory_query`. Subsequent runs are fast.
