# claude-memory-mcp

A local MCP (Model Context Protocol) server that gives Claude Code persistent, searchable memory across conversations. Stores facts about codebases — architecture, conventions, gotchas, decisions, and preferences — using semantic embeddings for retrieval and git-based staleness detection.

## Architecture

```
server.js          MCP entry point, registers 4 tools via stdio
embeddings.js      Local embedding model (Xenova/all-MiniLM-L6-v2, 384-dim)
memory-index.js    Vectra vector index for semantic search + dedup
db.js              SQLite metadata store (category, file path, git SHA, project)
staleness.js       Git log-based staleness detection for file-linked memories
```

Data is stored in `~/.claude-memory/` (separate from source code):
- `memory.db` — SQLite database (WAL mode)
- `vector_index/` — Vectra local index files

## Tools

| Tool | Description |
|------|-------------|
| `memory_store` | Store a fact. Deduplicates via cosine similarity (0.85 threshold). Captures git SHA for file-linked memories. |
| `memory_query` | Semantic search. Returns top-K results with staleness flags. |
| `memory_list` | List memories filtered by category and/or project. |
| `memory_forget` | Remove a memory by ID from both stores. |

### Categories

`architecture` · `convention` · `gotcha` · `decision` · `preference`

## Setup

```bash
npm install
```

### Register with Claude Code

```bash
# Global (all projects)
claude mcp add memory -s user $(which node) /path/to/claude-memory/server.js

# Single project
claude mcp add memory $(which node) /path/to/claude-memory/server.js
```

Verify with `claude mcp list` or `/mcp` inside a session.

## How it works

1. **Store**: Text is embedded locally, checked against existing vectors (cosine > 0.85 = duplicate), then stored in both Vectra (for search) and SQLite (for metadata).
2. **Query**: Input is embedded, Vectra returns nearest neighbours, SQLite enriches with metadata, and staleness is checked via `git log {sha}..HEAD -- {file}`.
3. **Forget**: Removes from both Vectra index and SQLite.

The embedding model (`Xenova/all-MiniLM-L6-v2`) runs locally — no API calls. It loads lazily on first use (~30MB download, cached after that).

## Dependencies

- `@modelcontextprotocol/sdk` — MCP server framework
- `@huggingface/transformers` — local embedding inference
- `onnxruntime-node` — ONNX runtime for the embedding model
- `better-sqlite3` — SQLite bindings
- `vectra` — local vector index
