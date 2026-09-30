# claude-memory-mcp

MCP memory server for Claude Code — persistent, searchable codebase knowledge. TypeScript, Node.js, SQLite for memories and their vectors.

## What this repo is

An MCP server that gives Claude Code a persistent memory store across sessions. Memories and their vectors are stored in SQLite (`~/.claude-memory/memory.db`), embedded with `@huggingface/transformers` (runs locally, no API calls). Every Claude session runs its own server process on that one file.

It is installed as an MCP server in Claude Code's config via `npm run setup` (see below) — not distributed via the npm registry; `claude-memory-mcp` on npm is an unrelated package.

## Repository layout

| Path | Purpose |
| :--- | :------ |
| `src/server.ts` | Entry point: reads config, opens the store, connects stdio, starts healing. |
| `src/create-server.ts` | All MCP tool definitions, as `createServer({ db, index })`. |
| `src/instructions.ts` | Server instructions sent in the MCP initialize result: when to use memory. Size-capped by its test. |
| `src/db.ts` | SQLite layer — schema, migrations, CRUD, vectors, dedup (0.85 cosine, `DEDUP_THRESHOLD`), eviction. |
| `src/memory-index.ts` | Embedding side — store, update, query, and `heal()` for unsearchable memories. |
| `src/vectors.ts` | Vector encoding (Float32 BLOBs), cosine similarity, top-k. |
| `src/embed-source.ts` | `embedSource()`: the one definition of the string a memory is embedded from. |
| `src/config.ts` | Environment config (`MEMORY_MAX_COUNT`). |
| `src/embeddings.ts` | HuggingFace transformer embeddings (local). Model: `Xenova/all-MiniLM-L6-v2`. |
| `src/staleness.ts` | Git-based staleness detection for file-linked memories. |
| `src/project-utils.ts` | Git root detection, `.claude/` file scanning, recently changed files. |
| `src/notes-dir.ts` | Server-built paths and safe writes for `memory_store_file` notes. |
| `src/permissions.ts` | Reapplies owner-only modes to the data folder and files on every start. |
| `src/limits.ts` | Upper bounds for every tool argument. |
| `src/types.ts` | Shared types: `CATEGORIES`, `EVICTION_EXEMPT_CATEGORIES`, `MemoryRow`, etc. |
| `dist/` | Compiled output (`tsc`). Never hand-edit. |

## Build & develop

```bash
npm ci --legacy-peer-deps   # install deps (always use ci, not install)
npm run build               # tsc → dist/
npm test                    # vitest run
npm run test:watch          # vitest watch mode
```

`tsc` is the build.

The MCP server is a stdio server (`dist/server.js`). Restart Claude Code to pick up a rebuilt `dist/`.

### First-time setup

```bash
npm run setup               # build + register MCP server + configure hooks/permissions
```

`setup.sh` handles first-time wiring: compiles, registers the server globally via `claude mcp add memory -s user node dist/server.js`, copies hooks to `~/.claude/hooks/`, and patches `~/.claude/settings.json` with tool permissions and hook entries.

### MCP inspector

```bash
npx @modelcontextprotocol/inspector node dist/server.js
```

Opens a browser UI to invoke any tool manually without a full Claude Code session. Useful for smoke-testing after a build before restarting Claude Code.

## Architecture

### Storage

One SQLite database (`db.ts`), two tables:

- **`memories`** — all metadata (text, category, tags, pinned, ephemeral, load_with, file_path, git_sha, project, timestamps).
- **`memory_vectors`** — one Float32 vector per memory, plus `source`, the exact string it was embedded from (text + tags, see `embedSource()`). A separate table so `SELECT *` over `memories` never returns vectors. An `AFTER DELETE` trigger on `memories` drops the vector.

On query: the input is embedded, every vector (optionally of one project) is scored by cosine similarity in JS, and the top-k rows are fetched. A memory is *unsearchable* when it has no vector or its `source` no longer matches its text and tags; `heal()` re-embeds those in the background.

`vector_index/index.json` is the Vectra index used up to 4.0.0. Nothing reads or writes it now; it stays on disk as the rollback path.

### Categories

Defined in `src/types.ts`:

```
architecture | convention | gotcha | decision | preference | relationship | person
```

`person` is exempt from LRU eviction (see `EVICTION_EXEMPT_CATEGORIES`). Use it for reviewer/author trust calibration — facts about team members that should never be silently dropped.

### Eviction

LRU, capped at `MEMORY_MAX_COUNT` (default 2000). `getEvictableIds()` excludes `pinned`, `ephemeral`, and categories in `EVICTION_EXEMPT_CATEGORIES`. Triggered on every `memory_store` call.

### Ephemeral memories

Session-scoped. Shown in `session_state` at top of `memory_project_summary`. Cleared at session end via `memory_clear_ephemerals`. Promote to long-term with `memory_update { ephemeral: false }`.

## Code conventions

- **TypeScript strict mode** — no implicit any.
- Tests live alongside source as `*.test.ts`. Run with `vitest`. They use real SQLite files in temp dirs and `mockEmbed`, a deterministic fake embedder. Tool tests go through `createServer()` over an in-memory MCP transport (`connectServer` in `test-helpers.ts`). `multi-process.test.ts` forks real processes against a copy compiled to `node_modules/.cache` by `vitest.global-setup.ts`, never `dist/`.
- Use `npm ci --legacy-peer-deps` everywhere — `package-lock.json` locks deps, `--legacy-peer-deps` handles a peer conflict in the HuggingFace dep tree.
- A write that touches a memory and its vector runs in one `BEGIN IMMEDIATE` transaction (`.immediate()`). Embed before opening it: better-sqlite3 transactions are synchronous, and other sessions wait on the lock.
- Write a vector only while it matches the row's current text and tags (`putVectorIfCurrent`); another session may have edited the memory while it was being embedded.
- Semantic dedup threshold is 0.85 cosine similarity (`DEDUP_THRESHOLD` in `db.ts`), global across projects. Lowering it causes false dedup; raising it allows near-duplicate memories.

## Release

The `release.yml` workflow fires on every push to `main`. It runs tests, then calls `npm run release -- --ci`, which:

- Only releases when there are `feat:` or `fix:` commits since the last tag — `chore:`, `docs:`, etc. don't trigger a release
- Creates a git tag and GitHub release
- Updates `CHANGELOG.md` (conventional changelog, angular preset)

`npm.publish: false` in `.release-it.json` — this package isn't published to the npm registry at all (`claude-memory-mcp` there is an unrelated package). Installation is via `npm run setup` against a local clone; the git tag and GitHub release are the actual release artifact.

## Gotchas

- Restarting Claude Code is required to pick up a new `dist/` build — the MCP server process is long-lived.
- `gh pr update-branch` can silently report "already up-to-date" when main has advanced. With `strict: true` branch protection this blocks merges. Fix: checkout the branch locally, `git merge origin/main`, push an empty commit to trigger CI.
- The release bot (`release-it`) fires on every push to main — including dependabot merges. Each dep bump gets its own patch release. Consider gating releases manually if this becomes noisy.
- After upgrading, every Claude session must restart: an old server process keeps running its old code against the shared database.

## Where future findings live

Long-tail findings go in the MCP memory store (this server's own database), not in this file. Keep this file orientation-only.
