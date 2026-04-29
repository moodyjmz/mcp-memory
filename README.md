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
| `memory_store` | Store a fact. Deduplicates via cosine similarity (0.85 threshold). Captures git SHA for file-linked memories. Auto-detects project from git root. Accepts optional `tags` and `load_with` arrays. |
| `memory_update` | Amend an existing memory — update text, tags, category, file_path, pinned, or load_with without deleting and re-creating. Re-embeds automatically if text or tags change. |
| `memory_query` | Semantic search. Returns `{ results, also_relevant }` — results are top-K semantic matches with staleness flags; also_relevant are tag-matched memories not in the main results (often causally related). |
| `memory_graph` | Compact table-of-contents of all project memories grouped by category, with 120-char excerpts, tags, and load_with. Use at session start to see everything that exists before querying. |
| `memory_list` | List memories filtered by category and/or project. Returns full rows. |
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

`memory_store` and `memory_update` accept an optional `tags` array of keywords to improve search discoverability. Tags are embedded alongside the memory text into the vector, so semantic queries matching tag terms score higher — even when those words don't appear in the memory itself. They also drive `also_relevant` in `memory_query`.

```json
{
  "text": "Rate limiter uses a sliding window algorithm with Redis sorted sets",
  "category": "architecture",
  "tags": ["throttling", "API", "backpressure", "quota", "429"]
}
```

Tags are stored as a comma-separated string in SQLite and returned in `memory_query` results.

### Coupling memories with `load_with`

When two facts are only useful together — e.g. a root cause and its implication — mark them with each other's IDs via `load_with`. They'll surface together in `memory_query` results as part of the `also_relevant` set.

```json
{
  "text": "copy:images-app reads from source tree, not BUILD_ROOT",
  "category": "gotcha",
  "tags": ["grunt", "deploy", "images"],
  "load_with": ["<id-of-the-deploy-theme-images-memory>"]
}
```

Use `memory_update` to add `load_with` to existing memories when you discover coupling mid-session rather than having to predict it at store-time.

### also_relevant in memory_query

`memory_query` returns `{ results, also_relevant }`. The `also_relevant` array contains up to 3 memories that share tags with the main results but weren't semantically close enough to rank. These are often causally related facts with different vocabulary — the kind semantic search alone would miss.

Only populated when the results have tags and a project is known.

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
npm run release     # Cut a new release (bumps version, generates changelog, tags, pushes, creates GitHub Release)
```

Releases use [release-it](https://github.com/release-it/release-it) with conventional-changelog. Commit messages following the `feat:`, `fix:`, `docs:` etc. convention are automatically grouped into the `CHANGELOG.md` and the GitHub Release notes. Run `npm run release` from `main` and it will prompt for the version bump type.

## How it works

1. **Store**: Text is embedded locally, checked against existing vectors (cosine > 0.85 = duplicate), then stored in both Vectra (for search) and SQLite (for metadata). Eviction runs if over limit.
2. **Update**: SQL fields (category, tags, pinned, load_with, file_path) update in SQLite only. If text or tags change, the Vectra vector is replaced in-place (delete + re-insert with same ID). SQL values are authoritative for display.
3. **Query**: Input is embedded, Vectra returns nearest neighbours (optionally filtered by project), SQLite enriches with metadata and staleness. Tag-based `also_relevant` is computed from all project memories sharing tags with the results.
4. **Graph**: `memory_graph` lists all project memories from SQLite grouped by category — no vector lookup needed.
5. **Forget**: Removes from both Vectra index and SQLite.

The embedding model (`Xenova/all-MiniLM-L6-v2`) runs locally — no API calls. It loads lazily on first use (~30MB download, cached after that).

## Security

### Prompt injection → shell execution: the core attack surface

This server stores content that Claude encounters in the wild (code, docs, README text) and later acts on that stored content to run git commands (staleness detection). That creates a path:

> malicious content in repo → prompt injection tricks Claude into calling `memory_store` with a crafted `file_path` → stored value later used in a git invocation → arbitrary code execution

**The rule for contributors**: any code that reads `file_path`, `git_sha`, or any other stored value and passes it to a subprocess must use `spawnSync` / `execFile` with an explicit args array — never string interpolation into a shell command. The shell never sees user-controlled data that way.

```ts
// WRONG — file_path or git_sha in the string = shell injection risk
execSync(`git log ${git_sha}..HEAD -- "${filename}"`);

// RIGHT — args array, no shell involved
spawnSync('git', ['log', `${git_sha}..HEAD`, '--', filename]);
```

`staleness.ts` is the main place this matters today. `server.ts` runs fixed git commands with only `cwd` derived from user input — `cwd` affects the working directory but is not part of the command string, so those calls are safe.

### SHA validation

Before any stored `git_sha` is used as a git revision, `staleness.ts` validates it matches `/^[0-9a-f]{7,64}$/i`. Values that fail — including anything with `;`, spaces, or shell metacharacters — are silently rejected, returning `{ stale: false }`. Any future code using stored SHAs as git args should apply the same check.

### Data directory permissions

`~/.claude-memory/` is created with mode `0700` and `memory.db` is set to `0600` at creation time, so memories are readable only by the owning user. Memories can contain sensitive context about codebases and personal workflows, so they should not be world-readable.

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
      "mcp__memory__memory_update",
      "mcp__memory__memory_query",
      "mcp__memory__memory_graph",
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

## Upgrading

```bash
git pull && npm run setup
```

`setup.sh` builds the TypeScript, re-registers the MCP server, replaces the `~/.claude/CLAUDE.md` instructions block in-place, and merges any new tool permissions into `settings.json`. Running it again on an existing install is safe and idempotent.

**Database** — no action needed. New columns (`tags`, `load_with`, etc.) are added automatically via `ALTER TABLE` migrations on first startup. Existing memories are untouched.

## Gotchas

- **Build before first use** — the server runs from `dist/`, not `src/`. You must run `npm run build` after cloning or the server won't start.
- **nvm users** — `$(which node)` captures the active nvm node path at registration time. If you switch node versions later, the MCP registration will break. Consider using a `.nvmrc` with `nvm exec` or the full versioned path.
- **Native module (`better-sqlite3`)** — compiles on `npm install`. If you change CPU architecture (e.g., x86 to ARM Mac) or jump major node versions, run `npm rebuild`.
- **First run downloads ~30MB** — the embedding model (`Xenova/all-MiniLM-L6-v2`) is fetched and cached locally on first `memory_store` or `memory_query`. Subsequent runs are fast.
