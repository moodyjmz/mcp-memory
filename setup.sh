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

BLOCK_FILE=$(mktemp)
cat > "$BLOCK_FILE" <<'BLOCK'

<!-- claude-memory-mcp -->
## Codebase Memory (MCP)

Persistent memory via the `memory` MCP server. Tools: `memory_store`, `memory_update`, `memory_query`, `memory_graph`, `memory_list`, `memory_forget`, `repo_link`, `repo_unlink`, `repo_map`, `memory_project_summary`. Project is auto-detected from git root.

**Session start (MANDATORY):** On SessionStart hook, call `memory_project_summary` (tell user "Loading project memory...") BEFORE responding. Use the project from the hook message, or auto-detect from file_path. For unfamiliar projects also call `memory_graph` to get a scannable overview of all stored memories before querying.

**When to store:** non-obvious architecture/conventions/gotchas, user corrections, cross-repo relationships (`repo_link`), and key learnings before context compaction. Check `repo_map` before cross-repo assumptions. Check `memory_query` before exploring unfamiliar code.

**How to store:** Silently, with a one-liner announcement (e.g. "Storing: LESS overrides needed for escaped string interpolation"). Always include a `tags` array that adds NEW search surface — don't repeat words from the text (already embedded). Use synonyms and related terms. Example: text "Rate limiter uses sliding window with Redis" → `tags: ["throttling", "API", "backpressure", "quota", "429"]`.

**Updating memories:** Use `memory_update` to amend existing memories — add tags, set load_with, fix text — without deleting and re-creating. Use `load_with` to couple two memories that are only useful together; set it on both so they surface together.

**Pinning:** Use `pinned: true` only when the user explicitly asks to remember something permanently.
<!-- /claude-memory-mcp -->
BLOCK

if [ -f "$CLAUDE_MD" ] && grep -q "$MARKER" "$CLAUDE_MD"; then
  # Replace existing block (handles upgrades — existing users get updated instructions)
  python3 -c "
import re, sys
new_block = open(sys.argv[2]).read()
content = open(sys.argv[1]).read()
updated = re.sub(
    r'\n<!-- claude-memory-mcp -->.*?<!-- /claude-memory-mcp -->',
    new_block,
    content,
    flags=re.DOTALL
)
open(sys.argv[1], 'w').write(updated)
" "$CLAUDE_MD" "$BLOCK_FILE"
  echo "    Updated memory instructions in $CLAUDE_MD"
else
  cat "$BLOCK_FILE" >> "$CLAUDE_MD"
  echo "    Added memory instructions to $CLAUDE_MD"
fi
rm -f "$BLOCK_FILE"

echo "==> Installing Claude Code hooks..."
mkdir -p "$HOME/.claude/hooks"
cp "$SCRIPT_DIR/hooks/"*.sh "$HOME/.claude/hooks/"
chmod +x "$HOME/.claude/hooks/"*.sh
echo "    Hooks copied to $HOME/.claude/hooks/"

# --- Prompt user before modifying settings.json ---
echo ""
echo "To work autonomously, claude-memory needs to add the following to ~/.claude/settings.json:"
echo "  - Tool permissions: allow all memory MCP tools without prompting"
echo "  - Hooks: SessionStart, PreCompact, SessionEnd"
echo ""
read -r -p "Configure permissions and hooks in settings.json? [Y/n] " REPLY
REPLY="${REPLY:-Y}"

if [[ "$REPLY" =~ ^[Yy]$ ]]; then
  SETTINGS_FILE="$HOME/.claude/settings.json"

  # Create settings.json if it doesn't exist
  if [ ! -f "$SETTINGS_FILE" ]; then
    echo '{}' > "$SETTINGS_FILE"
  fi

  # Use node to merge permissions and hooks into existing settings
  "$NODE_BIN" -e "
const fs = require('fs');
const settingsPath = process.argv[1];
const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));

// --- Permissions ---
const memoryTools = [
  'mcp__memory__memory_store',
  'mcp__memory__memory_update',
  'mcp__memory__memory_query',
  'mcp__memory__memory_graph',
  'mcp__memory__memory_list',
  'mcp__memory__memory_forget',
  'mcp__memory__memory_project_summary',
  'mcp__memory__repo_link',
  'mcp__memory__repo_unlink',
  'mcp__memory__repo_map'
];

if (!settings.permissions) settings.permissions = {};
if (!Array.isArray(settings.permissions.allow)) settings.permissions.allow = [];

const existing = new Set(settings.permissions.allow);
let addedPerms = 0;
for (const tool of memoryTools) {
  if (!existing.has(tool)) {
    settings.permissions.allow.push(tool);
    addedPerms++;
  }
}

// --- Hooks ---
const hookEntries = {
  SessionStart: 'session-start.sh',
  PreCompact: 'pre-compact.sh',
  SessionEnd: 'session-end.sh'
};

if (!settings.hooks) settings.hooks = {};

for (const [event, script] of Object.entries(hookEntries)) {
  const cmd = 'bash ~/.claude/hooks/' + script;
  if (!settings.hooks[event]) settings.hooks[event] = [];

  // Check if this hook command is already registered
  const alreadyExists = settings.hooks[event].some(group =>
    group.hooks && group.hooks.some(h => h.command === cmd)
  );

  if (!alreadyExists) {
    settings.hooks[event].push({
      hooks: [{ type: 'command', command: cmd, timeout: 5 }]
    });
  }
}

fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
console.log('    Added ' + addedPerms + ' tool permissions');
console.log('    Hooks configured for: ' + Object.keys(hookEntries).join(', '));
" "$SETTINGS_FILE"
else
  echo "    Skipped. See README for manual configuration."
fi

echo ""
echo "Done. Restart Claude Code to pick up the changes."
