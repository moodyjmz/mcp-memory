#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
NODE_BIN="$(which node)"
SERVER_PATH="$SCRIPT_DIR/dist/server.js"
CLAUDE_MD="$HOME/.claude/CLAUDE.md"
MARKER="<!-- claude-memory-mcp -->"

echo "==> Building TypeScript..."
npm run build

echo "==> Registering MCP server globally..."
# Remove existing registration if present (ignore errors)
claude mcp remove memory -s user 2>/dev/null || true
claude mcp add memory -s user "$NODE_BIN" "$SERVER_PATH"

echo "==> Configuring global CLAUDE.md..."
mkdir -p "$HOME/.claude"

# Only append if not already present
if [ -f "$CLAUDE_MD" ] && grep -q "$MARKER" "$CLAUDE_MD"; then
  echo "    Memory instructions already in $CLAUDE_MD — skipping."
else
  cat >> "$CLAUDE_MD" << 'BLOCK'

<!-- claude-memory-mcp -->
## Codebase Memory (MCP)

You have access to persistent memory tools via the `memory` MCP server. Use them proactively:

- **On session start**: query memory for context about the current project before diving into code
- **When you learn something non-obvious**: store architectural decisions, conventions, gotchas, and preferences
- **When the user corrects your approach**: store the correction so you don't repeat the mistake
- **When you discover how systems connect**: store cross-repo relationships and integration points
- **Before exploring unfamiliar code**: check if you already know something relevant
- **Before context compaction**: store key learnings from the session — decisions made, gotchas found, conventions discovered — before they're compressed away

The tools are: `memory_store`, `memory_query`, `memory_list`, `memory_forget`, `repo_link`, `repo_unlink`, `repo_map`.
Project is auto-detected from git root when you provide a file path.
Use `repo_link` when you discover how repos relate (provides, consumes, depends_on, builds_from, extends). Use `repo_map` to check known relationships before making cross-repo assumptions.

Store silently but announce with a brief one-liner, e.g. "Storing: LESS overrides needed for escaped string interpolation". No need to ask permission — just be transparent about what goes in.

When the user explicitly asks you to remember something permanently, use \`pinned: true\` on \`memory_store\`. Pinned memories are never evicted. Only pin when the user explicitly asks — normal codebase facts stay unpinned.
<!-- /claude-memory-mcp -->
BLOCK
  echo "    Added memory instructions to $CLAUDE_MD"
fi

echo ""
echo "Done. Restart Claude Code to pick up the changes."
