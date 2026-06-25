# claude-memory-mcp

MCP memory server for Claude Code — persistent, searchable codebase knowledge. TypeScript, Node.js, SQLite + Vectra vector index.

## What this repo is

An MCP server that gives Claude Code a persistent memory store across sessions. Memories are stored in SQLite (`~/.claude-memory/memories.db`) and indexed via Vectra (local vector index at `~/.claude-memory/index/`) using `@huggingface/transformers` for embeddings (runs locally, no API calls).

It is published as `claude-memory-mcp` on npm and installed as an MCP server in Claude Code's config.

## Repository layout

| Path | Purpose |
| :--- | :------ |
| `src/server.ts` | MCP tool definitions (entry point). All tools registered here. |
| `src/db.ts` | SQLite layer — schema, migrations, CRUD, eviction. |
| `src/memory-index.ts` | Vectra vector index — add, query, delete facts. Semantic dedup at 0.85 cosine threshold. |
| `src/embeddings.ts` | HuggingFace transformer embeddings (local). Model: `Xenova/all-MiniLM-L6-v2`. |
| `src/staleness.ts` | Git-based staleness detection for file-linked memories. |
| `src/project-utils.ts` | Git root detection, `.claude/` file scanning, recently changed files. |
| `src/types.ts` | Shared types: `CATEGORIES`, `EVICTION_EXEMPT_CATEGORIES`, `MemoryRow`, etc. |
| `build/` | Grunt build (not the SDK build — see below). |
| `dist/` | Compiled output (`tsc`). Never hand-edit. |

## Build & develop

```bash
npm ci --legacy-peer-deps   # install deps (always use ci, not install)
npm run build               # tsc → dist/
npm test                    # vitest run (96 tests)
npm run test:watch          # vitest watch mode
```

No Java required. No Grunt for day-to-day work — `tsc` is the build.

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

Two parallel stores, kept in sync:

- **SQLite** (`db.ts`) — source of truth for all metadata (text, category, tags, pinned, ephemeral, load_with, file_path, git_sha, project, timestamps).
- **Vectra** (`memory-index.ts`) — vector index for semantic search. Stores text + tags concatenated as the embedding input (tags enrich search surface). IDs are shared with SQLite.

On query: Vectra returns ranked IDs → SQLite row is fetched for full metadata (SQL is authoritative — survives `memory_update` without re-indexing text).

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
- Tests live alongside source as `*.test.ts`. Run with `vitest`. Tests use real SQLite (in-memory via better-sqlite3) and a real Vectra index — no mocks.
- Use `npm ci --legacy-peer-deps` everywhere — `npm-shrinkwrap.json` locks deps, `--legacy-peer-deps` handles a peer conflict in the HuggingFace dep tree.
- The SQLite DB and Vectra index must stay in sync. If you delete from one, delete from the other. `memory_forget` and eviction both do this.
- Semantic dedup threshold is 0.85 cosine similarity (`memory-index.ts`). Lowering it causes false dedup; raising it allows near-duplicate memories.

## Release

The `release.yml` workflow fires on every push to `main`. It runs tests, then calls `npm run release -- --ci`, which:

- Only releases when there are `feat:` or `fix:` commits since the last tag — `chore:`, `docs:`, etc. don't trigger a release
- Creates a git tag and GitHub release
- Updates `CHANGELOG.md` (conventional changelog, angular preset)

`npm.publish: false` in `.release-it.json` — npm publish is **not** handled by CI. After a tagged release is created, publish to npm manually:

```bash
npm run build
npm publish
```

## Gotchas

- Restarting Claude Code is required to pick up a new `dist/` build — the MCP server process is long-lived.
- `gh pr update-branch` can silently report "already up-to-date" when main has advanced. With `strict: true` branch protection this blocks merges. Fix: checkout the branch locally, `git merge origin/main`, push an empty commit to trigger CI.
- The release bot (`release-it`) fires on every push to main — including dependabot merges. Each dep bump gets its own patch release. Consider gating releases manually if this becomes noisy.
- `npm-shrinkwrap.json` (not `package-lock.json`) is the lock file used in production. Always use `npm ci`.

## Where future findings live

Long-tail findings go in the MCP memory store (this server's own database), not in this file. Keep this file orientation-only.
